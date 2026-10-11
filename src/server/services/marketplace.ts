import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { many, one, type Db } from '../db/client.js';
import { bumpCounter, getSetting } from './settings.js';

/**
 * A simulated marketplace API, mounted under /sim/marketplace as if it were a separate service.
 * In flaky mode it follows a fixed fault schedule so every take looks the same:
 * request 1 of every 7 gets a 429, request 2 commits and then answers too late.
 */

export const ACCEPTED_CARRIERS = ['kestrelpost', 'tidelane', 'swiftmere'] as const;
export const FAULT_CYCLE = 7;
export const RETRY_AFTER_S = 2;

export type Fault = 'rate_limit' | 'timeout_after_commit' | null;

export function faultFor(seq: number, mode: 'normal' | 'flaky'): Fault {
  if (mode !== 'flaky') return null;
  const slot = seq % FAULT_CYCLE;
  if (slot === 1) return 'rate_limit';
  if (slot === 2) return 'timeout_after_commit';
  return null;
}

const uploadBody = z.object({ carrier: z.string().min(1), trackingNumber: z.string().min(4).max(40) });
const params = z.object({ orderId: z.string().regex(/^SO-\d{5}$/) });

export interface MarketplaceRouteOptions {
  db: Db;
  /** How long a "timeout after commit" response is held back. Longer than the client timeout. */
  slowReplyMs: number;
}

export async function marketplaceRoutes(app: FastifyInstance, opts: MarketplaceRouteOptions): Promise<void> {
  const { db } = opts;

  const log = (seq: number, orderId: string, key: string | null, statusCode: number, outcome: string) =>
    db.query('INSERT INTO mp_requests (seq, order_id, idempotency_key, status_code, outcome) VALUES ($1, $2, $3, $4, $5)', [seq, orderId, key, statusCode, outcome]);

  app.post('/orders/:orderId/tracking', async (req, reply) => {
    const { orderId } = params.parse(req.params);
    const body = uploadBody.safeParse(req.body);
    const key = typeof req.headers['idempotency-key'] === 'string' ? req.headers['idempotency-key'] : null;
    const seq = await bumpCounter(db, 'mpRequestSeq');
    if (!body.success || !key) {
      await log(seq, orderId, key, 400, 'bad_request');
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'carrier, trackingNumber and an Idempotency-Key header are required' });
    }
    const fault = faultFor(seq, await getSetting(db, 'marketplaceMode'));
    if (fault === 'rate_limit') {
      await log(seq, orderId, key, 429, 'rate_limited');
      return reply.code(429).header('retry-after', String(RETRY_AFTER_S)).send({ error: 'RATE_LIMITED', message: 'Too many requests' });
    }

    const existing = await one<{ id: number }>(db, 'SELECT id FROM mp_trackings WHERE idempotency_key = $1', [key]);
    if (existing) {
      await log(seq, orderId, key, 200, 'replayed');
      return reply.code(200).send({ trackingId: existing.id, replayed: true });
    }
    const order = await one<{ status: string }>(db, 'SELECT status FROM mp_orders WHERE id = $1', [orderId]);
    if (!order) {
      await log(seq, orderId, key, 404, 'not_found');
      return reply.code(404).send({ error: 'ORDER_NOT_FOUND', message: `No order ${orderId}` });
    }
    if (order.status === 'cancelled') {
      await log(seq, orderId, key, 422, 'order_cancelled');
      return reply.code(422).send({ error: 'ORDER_CANCELLED', message: 'The buyer cancelled this order' });
    }
    if (!(ACCEPTED_CARRIERS as readonly string[]).includes(body.data.carrier)) {
      await log(seq, orderId, key, 422, 'carrier_not_accepted');
      return reply.code(422).send({ error: 'CARRIER_NOT_ACCEPTED', message: `Carrier ${body.data.carrier} is not accepted` });
    }
    const inserted = await one<{ id: number }>(
      db,
      `INSERT INTO mp_trackings (order_id, carrier_code, tracking_number, idempotency_key) VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING RETURNING id`,
      [orderId, body.data.carrier, body.data.trackingNumber, key],
    );
    if (!inserted) {
      // A concurrent request with the same key may have won the race: that is a replay, not a conflict.
      const raced = await one<{ id: number }>(db, 'SELECT id FROM mp_trackings WHERE idempotency_key = $1', [key]);
      if (raced) {
        await log(seq, orderId, key, 200, 'replayed');
        return reply.code(200).send({ trackingId: raced.id, replayed: true });
      }
      await log(seq, orderId, key, 409, 'tracking_exists');
      return reply.code(409).send({ error: 'TRACKING_EXISTS', message: 'This order already has a different tracking number' });
    }
    if (fault === 'timeout_after_commit') {
      await log(seq, orderId, key, 200, 'committed_slow_reply');
      await new Promise((r) => setTimeout(r, opts.slowReplyMs));
      return reply.code(200).send({ trackingId: inserted.id, replayed: false });
    }
    await log(seq, orderId, key, 201, 'created');
    return reply.code(201).send({ trackingId: inserted.id, replayed: false });
  });
}

export interface MarketplaceSnapshot {
  orders: { id: string; status: string; trackings: number; carrier: string | null; trackingNumber: string | null; requests: number }[];
  requests: { seq: number; orderId: string; statusCode: number; outcome: string; at: string }[];
}

export async function marketplaceSnapshot(db: Db): Promise<MarketplaceSnapshot> {
  const orders = await many<MarketplaceSnapshot['orders'][number]>(
    db,
    `SELECT o.id, o.status,
            (SELECT count(*)::int FROM mp_trackings t WHERE t.order_id = o.id) AS trackings,
            t.carrier_code AS carrier, t.tracking_number AS "trackingNumber",
            (SELECT count(*)::int FROM mp_requests r WHERE r.order_id = o.id) AS requests
       FROM mp_orders o LEFT JOIN mp_trackings t ON t.order_id = o.id
      WHERE EXISTS (SELECT 1 FROM mp_requests r WHERE r.order_id = o.id)
      ORDER BY o.id`,
  );
  const requests = await many<MarketplaceSnapshot['requests'][number]>(
    db,
    `SELECT seq, order_id AS "orderId", status_code AS "statusCode", outcome, at FROM mp_requests ORDER BY seq DESC LIMIT 40`,
  );
  return { orders, requests };
}
