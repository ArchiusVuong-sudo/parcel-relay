import { many, one } from '../db/client.js';
import { applyTemplate, testTemplate, type Fields, type Span } from '../domain/template.js';
import type { DraftRun } from '../llm/types.js';
import type { AppContext } from './context.js';
import { loadBody, releaseApproved, routeParsed } from './pipeline.js';
import type { EmailRow, SupplierRow, TemplateRow } from './rows.js';

export class ConflictError extends Error {
  readonly statusCode = 409;
}

/** Where each value sits in the email, for highlighting when the draft template could not find it. */
function locate(body: string, fields: Partial<Fields>): Span[] {
  const spans: Span[] = [];
  for (const [field, value] of Object.entries(fields) as [keyof Fields, string][]) {
    const start = value ? body.indexOf(value) : -1;
    if (start >= 0) spans.push({ field, start, end: start + value.length });
  }
  return spans;
}

/**
 * One model call for an unknown supplier: it reads the email and drafts a regex template.
 * The app tests the draft itself; the parsed shipment waits for a person either way.
 */
export async function draftForNewSupplier(ctx: AppContext, supplier: SupplierRow, email: EmailRow, body: string): Promise<void> {
  await ctx.db.query(`UPDATE emails SET status = 'drafting', reason = 'Drafting a parser for a new supplier' WHERE id = $1`, [email.id]);
  ctx.bus.publish('email.processed', { emailId: email.id });

  let run: DraftRun;
  try {
    run = await ctx.drafter.draft({ supplierName: supplier.name, senderDomain: supplier.sender_domain, subject: email.subject, body, contentType: email.content_type });
  } catch (err) {
    const message = (err as Error).message;
    await ctx.db.query(
      `INSERT INTO llm_runs (supplier_id, email_id, mode, model, ok, error, duration_ms) VALUES ($1, $2, $3, $4, false, $5, 0)`,
      [supplier.id, email.id, ctx.drafter.mode, ctx.drafter.model, message],
    );
    await ctx.db.query(`UPDATE emails SET status = 'failed', llm_calls = llm_calls + $2, reason = $3 WHERE id = $1`, [
      email.id,
      ctx.drafter.mode === 'live' ? 1 : 0,
      `Draft failed: ${message}`,
    ]);
    ctx.bus.publish('email.processed', { emailId: email.id });
    return;
  }

  const output = run.output;
  const test = testTemplate(output.template, body, output.fields);
  const llmRun = await one<{ id: number }>(
    ctx.db,
    `INSERT INTO llm_runs (supplier_id, email_id, mode, model, ok, duration_ms, cost_usd, num_turns, attempts, recorded_at, output, trace)
     VALUES ($1, $2, $3, $4, true, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
    [
      supplier.id,
      email.id,
      run.mode,
      run.model,
      run.mode === 'replay' ? run.recorded?.durationMs ?? 0 : run.durationMs,
      run.mode === 'replay' ? run.recorded?.costUsd ?? null : run.costUsd,
      run.numTurns,
      run.attempts,
      run.recorded?.recordedAt ?? null,
      JSON.stringify({ ...output, fallbackReason: run.fallbackReason ?? null, replayMs: run.mode === 'replay' ? run.durationMs : null }),
      JSON.stringify(run.trace),
    ],
  );
  const version = (await one<{ v: number }>(ctx.db, 'SELECT coalesce(max(version), 0)::int + 1 AS v FROM templates WHERE supplier_id = $1', [supplier.id]))!.v;
  const template = await one<{ id: number }>(
    ctx.db,
    `INSERT INTO templates (supplier_id, version, status, source, spec, test_result, llm_run_id) VALUES ($1, $2, 'draft', 'llm', $3, $4, $5) RETURNING id`,
    [supplier.id, version, JSON.stringify(output.template), JSON.stringify(test), llmRun!.id],
  );
  const extracted = applyTemplate(output.template, body);
  const spans = test.passed ? extracted.spans : locate(body, output.fields);
  await ctx.db.query(`UPDATE emails SET parse_method = 'llm', template_id = $2, llm_calls = llm_calls + 1 WHERE id = $1`, [email.id, template!.id]);
  // Uploads never run from a draft: the shipment is created and waits for approval.
  const fresh = (await one<EmailRow>(ctx.db, 'SELECT * FROM emails WHERE id = $1', [email.id]))!;
  await routeParsed(ctx, fresh, output.fields, spans, { requireApproval: true });
  ctx.bus.publish('supplier.drafted', { supplierId: supplier.id, passed: test.passed });
}

async function latestDraft(ctx: AppContext, supplierId: number): Promise<TemplateRow | undefined> {
  return one<TemplateRow>(ctx.db, `SELECT * FROM templates WHERE supplier_id = $1 AND status = 'draft' ORDER BY version DESC LIMIT 1`, [supplierId]);
}

/** A person approves the drafted template. From now on this supplier is parsed by rule. */
export async function approveTemplate(ctx: AppContext, supplierId: number): Promise<void> {
  await ctx.serial.run(async () => {
    const draft = await latestDraft(ctx, supplierId);
    if (!draft) throw new ConflictError('No draft template to approve');
    if (!draft.test_result?.passed) throw new ConflictError('The draft failed its template test, so it cannot be approved');
    await ctx.db.transaction(async (tx) => {
      await tx.query(`UPDATE templates SET status = 'rejected' WHERE supplier_id = $1 AND status = 'approved'`, [supplierId]);
      await tx.query(`UPDATE templates SET status = 'approved', approved_at = $2 WHERE id = $1`, [draft.id, ctx.clock.now().toISOString()]);
      await tx.query(`UPDATE suppliers SET status = 'active', layout = coalesce(layout, 'drafted template') WHERE id = $1`, [supplierId]);
    });
    ctx.bus.publish('supplier.approved', { supplierId });
    await releaseApproved(ctx, supplierId);
  });
}

/** A person rejects the draft. Its waiting shipments are dropped; nothing was uploaded. */
export async function rejectTemplate(ctx: AppContext, supplierId: number): Promise<void> {
  await ctx.serial.run(async () => {
    const draft = await latestDraft(ctx, supplierId);
    if (!draft) throw new ConflictError('No draft template to reject');
    await ctx.db.transaction(async (tx) => {
      await tx.query(`UPDATE templates SET status = 'rejected' WHERE id = $1`, [draft.id]);
      await tx.query(`UPDATE suppliers SET status = 'rejected' WHERE id = $1`, [supplierId]);
      await tx.query(
        `UPDATE emails SET status = 'failed', reason = 'Draft template rejected by a person'
          WHERE id IN (SELECT email_id FROM shipments WHERE supplier_id = $1 AND status = 'awaiting_approval')`,
        [supplierId],
      );
      await tx.query(`DELETE FROM shipments WHERE supplier_id = $1 AND status = 'awaiting_approval'`, [supplierId]);
    });
    ctx.bus.publish('supplier.rejected', { supplierId });
  });
}

/** Drafts again from the supplier's first email (after a rejection or a failed call). */
export async function redraftTemplate(ctx: AppContext, supplierId: number): Promise<void> {
  const supplier = await one<SupplierRow>(ctx.db, 'SELECT * FROM suppliers WHERE id = $1', [supplierId]);
  if (!supplier) throw new ConflictError('No such supplier');
  if (supplier.status === 'active') throw new ConflictError('This supplier already has an approved template');
  const email = await one<EmailRow>(ctx.db, `SELECT * FROM emails WHERE supplier_id = $1 ORDER BY id LIMIT 1`, [supplierId]);
  if (!email) throw new ConflictError('No email from this supplier yet');
  await ctx.serial.run(async () => {
    await ctx.db.query(`UPDATE templates SET status = 'rejected' WHERE supplier_id = $1 AND status = 'draft'`, [supplierId]);
    await ctx.db.query(`UPDATE suppliers SET status = 'pending_approval' WHERE id = $1`, [supplierId]);
    await ctx.db.query(`DELETE FROM shipments WHERE email_id = $1 AND status = 'awaiting_approval'`, [email.id]);
    await draftForNewSupplier(ctx, { ...supplier, status: 'pending_approval' }, email, await loadBody(ctx, email));
  });
}

export async function listSuppliers(ctx: AppContext) {
  const suppliers = await many<SupplierRow>(ctx.db, 'SELECT * FROM suppliers ORDER BY id');
  const templates = await many<TemplateRow>(ctx.db, 'SELECT * FROM templates ORDER BY supplier_id, version');
  const runs = await many<Record<string, unknown> & { id: number; supplier_id: number }>(ctx.db, 'SELECT * FROM llm_runs ORDER BY id');
  const counts = await many<{ supplier_id: number; emails: number; rule: number; llm_calls: number }>(
    ctx.db,
    `SELECT supplier_id, count(*)::int AS emails, count(*) FILTER (WHERE parse_method = 'rule')::int AS rule, coalesce(sum(llm_calls), 0)::int AS llm_calls
       FROM emails WHERE supplier_id IS NOT NULL GROUP BY supplier_id`,
  );
  return suppliers.map((s) => ({
    ...s,
    templates: templates.filter((t) => t.supplier_id === s.id),
    runs: runs.filter((r) => r.supplier_id === s.id),
    stats: counts.find((c) => c.supplier_id === s.id) ?? { emails: 0, rule: 0, llm_calls: 0 },
  }));
}
