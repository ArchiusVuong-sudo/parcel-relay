import { many, type Queryable } from '../db/client.js';
import { matchShipment, type MatchDecision, type OrderFacts, type ShipmentFacts } from '../domain/matcher.js';
import type { Fields } from '../domain/template.js';
import { recordOrderEvent } from './events.js';
import { enqueue } from './queue.js';
import type { OrderRow } from './rows.js';

export function shipmentFacts(fields: Partial<Fields>, shippedAt: Date): ShipmentFacts {
  return {
    buyerName: fields.buyer_name ?? '',
    street: fields.street ?? '',
    postalCode: fields.postal_code ?? '',
    items: fields.items ?? '',
    shippedAt,
  };
}

export async function openOrderFacts(q: Queryable): Promise<OrderFacts[]> {
  const rows = await many<OrderRow>(q, `SELECT * FROM orders WHERE status = 'awaiting_tracking' ORDER BY id`);
  return rows.map((o) => ({
    id: o.id,
    buyerName: o.buyer_name,
    street: o.street,
    postalCode: o.postal_code,
    itemTitles: o.items.map((i) => i.title),
    placedAt: o.placed_at,
    handlingDeadline: o.handling_deadline,
  }));
}

export async function previewMatch(q: Queryable, fields: Partial<Fields>, shippedAt: Date): Promise<MatchDecision> {
  return matchShipment(shipmentFacts(fields, shippedAt), await openOrderFacts(q));
}

export function uploadKey(orderId: string, carrierCode: string, tracking: string): string {
  return `upload:${orderId}:${carrierCode}:${tracking}`;
}

/**
 * Links a shipment to an order and queues the upload, in the caller's transaction.
 * The order must still be waiting for tracking; otherwise nothing changes.
 */
export async function linkAndQueue(
  q: Queryable,
  input: { shipmentId: number; orderId: string; carrierCode: string; trackingNumber: string; decidedBy: 'auto' | 'reviewer'; at: Date; note: string },
): Promise<boolean> {
  const updated = await q.query(
    `UPDATE orders SET status = 'uploading', carrier_code = $2, tracking_number = $3, shipment_id = $4, updated_at = now()
      WHERE id = $1 AND status = 'awaiting_tracking'`,
    [input.orderId, input.carrierCode, input.trackingNumber, input.shipmentId],
  );
  if ((updated.affectedRows ?? 0) === 0) return false;
  await q.query(`UPDATE shipments SET status = 'matched', order_id = $2, decided_by = $3 WHERE id = $1`, [input.shipmentId, input.orderId, input.decidedBy]);
  await recordOrderEvent(q, input.orderId, input.at, input.decidedBy === 'auto' ? 'matched' : 'assigned', input.note, { shipmentId: input.shipmentId });
  const job = await enqueue(q, {
    kind: 'upload_tracking',
    payload: { orderId: input.orderId, shipmentId: input.shipmentId, carrierCode: input.carrierCode, trackingNumber: input.trackingNumber },
    idempotencyKey: uploadKey(input.orderId, input.carrierCode, input.trackingNumber),
  });
  await recordOrderEvent(q, input.orderId, input.at, 'upload_queued', `Upload queued (job #${job.id})`, { jobId: job.id });
  return true;
}
