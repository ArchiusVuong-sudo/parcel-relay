import { many, one, type Queryable } from '../db/client.js';
import { HOLD_REASON_TEXT, checkTracking, normalizeCarrierName, normalizeTracking } from '../domain/carriers.js';
import { applyTemplate, templateSpecSchema, type Fields, type Span } from '../domain/template.js';
import type { FixtureEmail } from '../fixtures.js';
import { contentKey } from './blobStore.js';
import type { AppContext } from './context.js';
import { recordOrderEvent } from './events.js';
import { ACCEPTED_CARRIERS } from './marketplace.js';
import { linkAndQueue, previewMatch } from './matching.js';
import type { EmailRow, SupplierRow, TemplateRow } from './rows.js';
import { getSetting, setSetting } from './settings.js';
import { draftForNewSupplier } from './suppliers.js';

export function senderDomain(from: string): string {
  return from.split('@')[1]?.toLowerCase() ?? '';
}

export async function loadBody(ctx: AppContext, email: Pick<EmailRow, 'blob_key'>): Promise<string> {
  return (await ctx.blobs.getObject({ Key: email.blob_key })).Body.toString('utf8');
}

/** Stores the raw email by content hash and records it. A repeated Message-ID is ignored. */
export async function ingestEmail(ctx: AppContext, batch: number, email: FixtureEmail): Promise<number | null> {
  const key = contentKey(email.body);
  await ctx.blobs.putObject({ Key: key, Body: email.body, ContentType: email.contentType });
  const row = await one<{ id: number }>(
    ctx.db,
    `INSERT INTO emails (message_id, batch, from_addr, from_name, subject, content_type, blob_key, received_at, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'received') ON CONFLICT (message_id) DO NOTHING RETURNING id`,
    [email.messageId, batch, email.from, email.fromName, email.subject, email.contentType, key, ctx.clock.now().toISOString()],
  );
  return row ? row.id : null;
}

export interface SyncResult {
  done: boolean;
  batch?: number;
  label?: string;
  emailIds: number[];
  processing: Promise<void>;
}

/** Pulls the next batch from the synthetic mailbox and processes it in the background, one email at a time. */
export async function syncNextBatch(ctx: AppContext): Promise<SyncResult> {
  const next = await getSetting(ctx.db, 'nextBatch');
  const batch = ctx.fixtures.mailbox.batches.find((b) => b.batch === next);
  if (!batch) return { done: true, emailIds: [], processing: Promise.resolve() };
  const emailIds: number[] = [];
  for (const email of batch.emails) {
    const id = await ingestEmail(ctx, batch.batch, email);
    if (id !== null) emailIds.push(id);
  }
  await setSetting(ctx.db, 'nextBatch', next + 1);
  ctx.bus.publish('inbox.synced', { batch: batch.batch, count: emailIds.length });
  const processing = ctx.serial.run(async () => {
    for (const id of emailIds) await processEmail(ctx, id);
  });
  return { done: false, batch: batch.batch, label: batch.label, emailIds, processing };
}

export async function processEmail(ctx: AppContext, emailId: number): Promise<void> {
  const email = await one<EmailRow>(ctx.db, 'SELECT * FROM emails WHERE id = $1', [emailId]);
  if (!email) throw new Error(`email ${emailId} not found`);
  const body = await loadBody(ctx, email);
  const domain = senderDomain(email.from_addr);
  const supplier = await one<SupplierRow>(ctx.db, 'SELECT * FROM suppliers WHERE sender_domain = $1', [domain]);

  if (!supplier) {
    const created = await one<SupplierRow>(
      ctx.db,
      `INSERT INTO suppliers (name, sender_domain, layout, status) VALUES ($1, $2, NULL, 'pending_approval') RETURNING *`,
      [email.from_name, domain],
    );
    await ctx.db.query('UPDATE emails SET supplier_id = $2 WHERE id = $1', [emailId, created!.id]);
    ctx.bus.publish('supplier.created', { supplierId: created!.id });
    await draftForNewSupplier(ctx, created!, { ...email, supplier_id: created!.id }, body);
    return;
  }

  if (supplier.status !== 'active') {
    await ctx.db.query(
      `UPDATE emails SET supplier_id = $2, status = 'waiting_approval', reason = $3 WHERE id = $1`,
      [emailId, supplier.id, 'Supplier template is waiting for approval. Held with no LLM call.'],
    );
    ctx.bus.publish('email.processed', { emailId });
    return;
  }

  const template = await one<TemplateRow>(ctx.db, `SELECT * FROM templates WHERE supplier_id = $1 AND status = 'approved'`, [supplier.id]);
  if (!template) throw new Error(`active supplier ${supplier.id} has no approved template`);
  const extracted = applyTemplate(templateSpecSchema.parse(template.spec), body);
  await ctx.db.query('UPDATE emails SET supplier_id = $2, parse_method = $3, template_id = $4 WHERE id = $1', [emailId, supplier.id, 'rule', template.id]);
  if (!extracted.fields.tracking_number || !extracted.fields.carrier) {
    await ctx.db.query(`UPDATE emails SET status = 'failed', fields = $2, spans = $3, reason = $4 WHERE id = $1`, [
      emailId,
      JSON.stringify(extracted.fields),
      JSON.stringify(extracted.spans),
      `Template found no ${extracted.missing.join(', ')}`,
    ]);
    ctx.bus.publish('email.processed', { emailId });
    return;
  }
  await routeParsed(ctx, { ...email, supplier_id: supplier.id }, extracted.fields, extracted.spans, { requireApproval: false });
}

export interface RouteResult {
  outcome: 'held' | 'duplicate' | 'awaiting_approval' | 'matched' | 'needs_review';
  shipmentId: number | null;
}

/**
 * The shared path after parsing, for rule and model output alike:
 * dedupe by tracking, check the number, then match and queue (unless a person must approve first).
 */
export async function routeParsed(
  ctx: AppContext,
  email: EmailRow,
  fields: Partial<Fields>,
  spans: Span[],
  opts: { requireApproval: boolean },
): Promise<RouteResult> {
  const result = await ctx.db.transaction(async (tx) => {
    const carrierRaw = fields.carrier ?? '';
    const check = checkTracking(carrierRaw, fields.tracking_number ?? '', ACCEPTED_CARRIERS);
    const tracking = normalizeTracking(fields.tracking_number ?? '');
    const dedupeKey = `${check.carrierCode ?? normalizeCarrierName(carrierRaw)}:${tracking}`;
    const preview = await previewMatch(tx, fields, email.received_at);
    const status = !check.ok ? 'held' : opts.requireApproval ? 'awaiting_approval' : 'needs_review';

    const inserted = await one<{ id: number }>(
      tx,
      `INSERT INTO shipments (email_id, supplier_id, carrier_code, carrier_label, tracking_number, dedupe_key, check_result, status, match)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
      [email.id, email.supplier_id, check.carrierCode, check.carrierName, tracking, dedupeKey, JSON.stringify(check), status, JSON.stringify(preview)],
    );
    const setEmail = (s: EmailRow['status'], reason: string | null) =>
      tx.query('UPDATE emails SET status = $2, reason = $3, fields = $4, spans = $5 WHERE id = $1', [email.id, s, reason, JSON.stringify(fields), JSON.stringify(spans)]);

    if (!inserted) {
      const first = await one<{ email_id: number; order_id: string | null }>(tx, 'SELECT email_id, order_id FROM shipments WHERE dedupe_key = $1', [dedupeKey]);
      await setEmail('duplicate', `Same tracking number as email #${first?.email_id}${first?.order_id ? ` (order ${first.order_id})` : ''}. Not queued again.`);
      return { outcome: 'duplicate' as const, shipmentId: null };
    }
    const shipmentId = inserted.id;
    if (!check.ok) {
      await setEmail('held', `held: ${HOLD_REASON_TEXT[check.reason]}. ${check.detail}.`);
      const likely = preview.candidates[0];
      if (likely && likely.score >= 0.85) {
        await recordOrderEvent(tx, likely.orderId, ctx.clock.now(), 'tracking_held', `Tracking ${tracking} held: ${HOLD_REASON_TEXT[check.reason]}`, { shipmentId, emailId: email.id });
      }
      return { outcome: 'held' as const, shipmentId };
    }
    if (opts.requireApproval) {
      await setEmail('waiting_approval', 'Parsed by a drafted template. Nothing uploads until a person approves it.');
      return { outcome: 'awaiting_approval' as const, shipmentId };
    }
    await setEmail('parsed', null);
    return decideMatch(ctx, tx, shipmentId, check.carrierCode, tracking, preview, email);
  });
  ctx.bus.publish('email.processed', { emailId: email.id, outcome: result.outcome });
  return result;
}

async function decideMatch(
  ctx: AppContext,
  tx: Queryable,
  shipmentId: number,
  carrierCode: string,
  tracking: string,
  decision: Awaited<ReturnType<typeof previewMatch>>,
  email: EmailRow,
): Promise<RouteResult> {
  const now = ctx.clock.now();
  if (decision.kind === 'auto') {
    const method = email.parse_method === 'llm' ? 'approved draft template' : 'rule parsed';
    await recordOrderEvent(tx, decision.orderId, now, 'tracking_found', `Tracking ${tracking} found in an email from ${email.from_name} (${method})`, { emailId: email.id });
    const linked = await linkAndQueue(tx, {
      shipmentId,
      orderId: decision.orderId,
      carrierCode,
      trackingNumber: tracking,
      decidedBy: 'auto',
      at: now,
      note: `Matched automatically: score ${decision.score.toFixed(2)}, ${decision.lead.toFixed(2)} ahead of the next order`,
    });
    if (linked) return { outcome: 'matched', shipmentId };
  }
  for (const c of decision.candidates.filter((c) => c.score >= 0.4)) {
    await recordOrderEvent(tx, c.orderId, now, 'review_needed', `Possible match for tracking ${tracking} (score ${c.score.toFixed(2)}), waiting for a person`, { shipmentId });
  }
  await tx.query(`UPDATE shipments SET status = 'needs_review' WHERE id = $1`, [shipmentId]);
  return { outcome: 'needs_review', shipmentId };
}

/** Re-runs matching for shipments released by a template approval. */
export async function releaseApproved(ctx: AppContext, supplierId: number): Promise<void> {
  const pending = await many<{ id: number; email_id: number; carrier_code: string; tracking_number: string }>(
    ctx.db,
    `SELECT id, email_id, carrier_code, tracking_number FROM shipments WHERE supplier_id = $1 AND status = 'awaiting_approval' ORDER BY id`,
    [supplierId],
  );
  for (const s of pending) {
    const email = (await one<EmailRow>(ctx.db, 'SELECT * FROM emails WHERE id = $1', [s.email_id]))!;
    await ctx.db.transaction(async (tx) => {
      const preview = await previewMatch(tx, email.fields ?? {}, email.received_at);
      await tx.query('UPDATE shipments SET match = $2 WHERE id = $1', [s.id, JSON.stringify(preview)]);
      await tx.query(`UPDATE emails SET status = 'parsed', reason = 'Released after a person approved the template' WHERE id = $1`, [email.id]);
      await decideMatch(ctx, tx, s.id, s.carrier_code, s.tracking_number, preview, email);
    });
    ctx.bus.publish('email.processed', { emailId: email.id });
  }
  const waiting = await many<{ id: number }>(
    ctx.db,
    `SELECT e.id FROM emails e WHERE e.supplier_id = $1 AND e.status = 'waiting_approval'
       AND NOT EXISTS (SELECT 1 FROM shipments s WHERE s.email_id = e.id) ORDER BY e.id`,
    [supplierId],
  );
  for (const w of waiting) await processEmail(ctx, w.id);
}
