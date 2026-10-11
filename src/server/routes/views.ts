import { many, one } from '../db/client.js';
import type { AppContext } from '../services/context.js';
import { lateRisk } from '../services/delivery.js';
import { loadBody } from '../services/pipeline.js';
import type { EmailRow, OrderRow, ShipmentRow } from '../services/rows.js';
import { getSetting } from '../services/settings.js';

/** Read models for the dashboard. Each returns plain JSON for one screen. */

export async function metaView(ctx: AppContext) {
  const nextBatch = await getSetting(ctx.db, 'nextBatch');
  const batches = ctx.fixtures.mailbox.batches;
  return {
    llm: ctx.llm,
    sim: { now: ctx.clock.now().toISOString(), day: ctx.clock.day(), epoch: await getSetting(ctx.db, 'epoch') },
    marketplaceMode: await getSetting(ctx.db, 'marketplaceMode'),
    seller: ctx.fixtures.orders.seller,
    inbox: {
      nextBatch,
      totalBatches: batches.length,
      nextLabel: batches.find((b) => b.batch === nextBatch)?.label ?? null,
      processing: ctx.serial.busy,
    },
  };
}

export async function overviewView(ctx: AppContext) {
  const tiles = await one<Record<string, number>>(ctx.db, 'SELECT * FROM dashboard_tiles');
  const activity = await many(
    ctx.db,
    `SELECT ev.id, ev.order_id AS "orderId", ev.at, ev.kind, ev.message, o.buyer_name AS "buyerName"
       FROM order_events ev JOIN orders o ON o.id = ev.order_id ORDER BY ev.id DESC LIMIT 14`,
  );
  return { tiles, lateRisk: await lateRisk(ctx), activity };
}

const EMAIL_LIST_SQL = `
  SELECT e.id, e.batch, e.from_name AS "fromName", e.from_addr AS "fromAddr", e.subject, e.received_at AS "receivedAt",
         e.status, e.parse_method AS "parseMethod", e.llm_calls AS "llmCalls", e.reason, e.content_type AS "contentType",
         sp.name AS "supplierName", sp.status AS "supplierStatus",
         s.id AS "shipmentId", s.status AS "shipmentStatus", s.carrier_label AS "carrier", s.tracking_number AS "trackingNumber",
         s.check_result AS "check", s.order_id AS "orderId"
    FROM emails e
    LEFT JOIN suppliers sp ON sp.id = e.supplier_id
    LEFT JOIN shipments s ON s.email_id = e.id`;

export async function emailsView(ctx: AppContext) {
  return many(ctx.db, `${EMAIL_LIST_SQL} ORDER BY e.id DESC`);
}

export async function emailDetailView(ctx: AppContext, id: number) {
  const row = await one<Record<string, unknown>>(ctx.db, `${EMAIL_LIST_SQL} WHERE e.id = $1`, [id]);
  if (!row) return undefined;
  const email = (await one<EmailRow>(ctx.db, 'SELECT * FROM emails WHERE id = $1', [id]))!;
  const shipment = await one<ShipmentRow>(ctx.db, 'SELECT * FROM shipments WHERE email_id = $1', [id]);
  const template = email.template_id
    ? await one(ctx.db, 'SELECT id, version, source, status FROM templates WHERE id = $1', [email.template_id])
    : null;
  return { ...row, body: await loadBody(ctx, email), fields: email.fields, spans: email.spans ?? [], match: shipment?.match ?? null, template, blobKey: email.blob_key };
}

export async function ordersView(ctx: AppContext) {
  const now = ctx.clock.now().getTime();
  const rows = await many<OrderRow>(ctx.db, 'SELECT * FROM orders ORDER BY id');
  return rows.map((o) => ({
    id: o.id,
    buyerName: o.buyer_name,
    town: o.town,
    items: o.items,
    supplierName: o.supplier_name,
    status: o.status,
    carrierCode: o.carrier_code,
    trackingNumber: o.tracking_number,
    placedAt: o.placed_at,
    deadline: o.handling_deadline,
    overdue: o.status === 'awaiting_tracking' && o.handling_deadline.getTime() < now,
  }));
}

export async function orderDetailView(ctx: AppContext, id: string) {
  const o = await one<OrderRow>(ctx.db, 'SELECT * FROM orders WHERE id = $1', [id]);
  if (!o) return undefined;
  const events = await many(ctx.db, 'SELECT id, at, kind, message FROM order_events WHERE order_id = $1 ORDER BY id', [id]);
  const shipment = o.shipment_id ? await one<ShipmentRow>(ctx.db, 'SELECT * FROM shipments WHERE id = $1', [o.shipment_id]) : undefined;
  const candidates = ((shipment?.match as { candidates?: { orderId: string }[] } | null)?.candidates ?? []);
  const messages = await many(ctx.db, 'SELECT id, kind, body, sent_at AS "sentAt" FROM buyer_messages WHERE order_id = $1 ORDER BY id', [id]);
  const marketplace = await one(ctx.db, `SELECT carrier_code AS "carrierCode", tracking_number AS "trackingNumber", created_at AS "createdAt" FROM mp_trackings WHERE order_id = $1`, [id]);
  const mpTrackings = (await one<{ n: number }>(ctx.db, 'SELECT count(*)::int AS n FROM mp_trackings WHERE order_id = $1', [id]))!.n;
  return {
    order: {
      id: o.id, buyerName: o.buyer_name, street: o.street, town: o.town, postalCode: o.postal_code, items: o.items, supplierName: o.supplier_name,
      placedAt: o.placed_at, deadline: o.handling_deadline, status: o.status, carrierCode: o.carrier_code, trackingNumber: o.tracking_number,
    },
    match: shipment
      ? { decidedBy: shipment.decided_by, emailId: shipment.email_id, candidate: candidates.find((c) => c.orderId === id) ?? null, candidates }
      : null,
    events,
    messages,
    marketplace: { tracking: marketplace ?? null, trackings: mpTrackings },
  };
}

export async function reviewView(ctx: AppContext) {
  const shipments = await many<ShipmentRow & { fields: Record<string, string>; from_name: string; subject: string; received_at: Date }>(
    ctx.db,
    `SELECT s.*, e.fields, e.from_name, e.subject, e.received_at FROM shipments s JOIN emails e ON e.id = s.email_id
      WHERE s.status = 'needs_review' ORDER BY s.id`,
  );
  const orders = await many<OrderRow>(ctx.db, 'SELECT * FROM orders');
  return shipments.map((s) => {
    const match = s.match as { kind: string; reason?: string; candidates: { orderId: string; score: number; breakdown: unknown[] }[] };
    return {
      shipmentId: s.id,
      emailId: s.email_id,
      supplierName: s.from_name,
      subject: s.subject,
      receivedAt: s.received_at,
      carrier: s.carrier_label,
      trackingNumber: s.tracking_number,
      fields: s.fields,
      reason: match.kind === 'none' ? 'no_match' : match.reason ?? 'tie',
      candidates: match.candidates.map((c) => {
        const o = orders.find((x) => x.id === c.orderId);
        return { ...c, order: o ? { id: o.id, buyerName: o.buyer_name, street: o.street, town: o.town, postalCode: o.postal_code, items: o.items, status: o.status, placedAt: o.placed_at, deadline: o.handling_deadline } : null };
      }),
    };
  });
}

export async function messagesView(ctx: AppContext) {
  return many(
    ctx.db,
    `SELECT m.id, m.order_id AS "orderId", m.kind, m.body, m.sent_at AS "sentAt", o.buyer_name AS "buyerName"
       FROM buyer_messages m JOIN orders o ON o.id = m.order_id ORDER BY m.id DESC`,
  );
}
