import { many, one, type Queryable } from '../db/client.js';
import { CARRIERS } from '../domain/carriers.js';
import { HOUR_MS } from './clock.js';
import type { AppContext } from './context.js';
import { recordOrderEvent } from './events.js';
import type { OrderRow } from './rows.js';
import { setSetting } from './settings.js';

export const LATE_RISK_WINDOW_H = 12;

function carrierName(code: string | null): string {
  return CARRIERS.find((c) => c.code === code)?.name ?? code ?? 'the carrier';
}

export function messageBody(order: Pick<OrderRow, 'id' | 'buyer_name' | 'carrier_code' | 'tracking_number' | 'items'>, kind: 'shipped' | 'delivered'): string {
  const first = order.buyer_name.split(' ')[0];
  const item = order.items[0]?.title ?? 'your order';
  if (kind === 'shipped') {
    return `Hi ${first}, your ${item} (order ${order.id}) has shipped with ${carrierName(order.carrier_code)}. Tracking: ${order.tracking_number}.`;
  }
  return `Hi ${first}, ${carrierName(order.carrier_code)} shows your ${item} (order ${order.id}) as delivered. Enjoy, and thanks for your order.`;
}

/** Sends at most one message per order and stage; a second call is a no-op thanks to the unique key. */
export async function sendBuyerMessage(q: Queryable, order: OrderRow, kind: 'shipped' | 'delivered', at: Date): Promise<boolean> {
  const row = await one<{ id: number }>(
    q,
    `INSERT INTO buyer_messages (order_id, kind, body, sent_at) VALUES ($1, $2, $3, $4) ON CONFLICT (order_id, kind) DO NOTHING RETURNING id`,
    [order.id, kind, messageBody(order, kind), at.toISOString()],
  );
  if (row) await recordOrderEvent(q, order.id, at, 'buyer_message', `Buyer message sent: ${kind}`, { messageId: row.id });
  return Boolean(row);
}

/** Replays seeded carrier scans that are due by the current simulated day. */
export async function applyDueScans(ctx: AppContext): Promise<number> {
  const due = await many<{ scan_id: number; order_id: string; status: 'in_transit' | 'delivered'; location: string }>(
    ctx.db,
    `SELECT s.id AS scan_id, o.id AS order_id, s.status, s.location
       FROM carrier_scans s JOIN orders o ON o.tracking_number = s.tracking_number
      WHERE s.applied_at IS NULL AND o.status IN ('uploaded', 'in_transit')
        AND o.uploaded_day + s.days_after_upload <= $1
      ORDER BY s.days_after_upload, o.id`,
    [ctx.clock.day()],
  );
  const now = ctx.clock.now();
  for (const scan of due) {
    await ctx.db.transaction(async (tx) => {
      await tx.query('UPDATE carrier_scans SET applied_at = $2 WHERE id = $1', [scan.scan_id, now.toISOString()]);
      if (scan.status === 'in_transit') {
        await tx.query(`UPDATE orders SET status = 'in_transit', updated_at = now() WHERE id = $1 AND status = 'uploaded'`, [scan.order_id]);
        await recordOrderEvent(tx, scan.order_id, now, 'in_transit', `Carrier scan (simulated): in transit at ${scan.location}`);
      } else {
        await tx.query(`UPDATE orders SET status = 'delivered', updated_at = now() WHERE id = $1 AND status IN ('uploaded', 'in_transit')`, [scan.order_id]);
        await recordOrderEvent(tx, scan.order_id, now, 'delivered', `Carrier scan (simulated): delivered, ${scan.location}`);
        const order = await one<OrderRow>(tx, 'SELECT * FROM orders WHERE id = $1', [scan.order_id]);
        if (order) await sendBuyerMessage(tx, order, 'delivered', now);
      }
    });
  }
  if (due.length) ctx.bus.publish('order.updated', { scans: due.length });
  return due.length;
}

export async function advanceDay(ctx: AppContext): Promise<{ day: number; scansApplied: number }> {
  const day = ctx.clock.day() + 1;
  await setSetting(ctx.db, 'offsetDays', day);
  ctx.clock.setOffsetDays(day);
  const scansApplied = await applyDueScans(ctx);
  ctx.bus.publish('clock.advanced', { day });
  return { day, scansApplied };
}

export interface LateRisk {
  orderId: string;
  buyerName: string;
  supplierName: string;
  deadline: string;
  hoursOverdue: number;
  hoursLeft: number;
  state: 'overdue' | 'due_soon';
  note: string | null;
}

/** Orders with no tracking yet, past or close to their handling deadline. */
export async function lateRisk(ctx: AppContext): Promise<LateRisk[]> {
  const now = ctx.clock.now().getTime();
  const rows = await many<OrderRow & { held_reason: string | null }>(
    ctx.db,
    `SELECT o.*, (SELECT e.reason FROM order_events ev JOIN shipments s ON s.id = (ev.detail->>'shipmentId')::int JOIN emails e ON e.id = s.email_id
                   WHERE ev.order_id = o.id AND ev.kind = 'tracking_held' ORDER BY ev.id DESC LIMIT 1) AS held_reason
       FROM orders o
      WHERE o.status = 'awaiting_tracking' AND o.handling_deadline < $1
      ORDER BY o.handling_deadline`,
    [new Date(now + LATE_RISK_WINDOW_H * HOUR_MS).toISOString()],
  );
  return rows.map((o) => {
    const diffH = (now - o.handling_deadline.getTime()) / HOUR_MS;
    return {
      orderId: o.id,
      buyerName: o.buyer_name,
      supplierName: o.supplier_name,
      deadline: o.handling_deadline.toISOString(),
      hoursOverdue: diffH > 0 ? Math.round(diffH) : 0,
      hoursLeft: diffH < 0 ? Math.round(-diffH) : 0,
      state: diffH > 0 ? 'overdue' : 'due_soon',
      note: o.held_reason,
    };
  });
}
