import { z } from 'zod';
import { one } from '../db/client.js';
import type { AppContext } from './context.js';
import { sendBuyerMessage } from './delivery.js';
import { recordOrderEvent } from './events.js';
import type { MarketplaceClient } from './marketplaceClient.js';
import type { DeadHandler, JobHandler } from './queue.js';
import type { OrderRow } from './rows.js';

const payloadSchema = z.object({ orderId: z.string(), shipmentId: z.number(), carrierCode: z.string(), trackingNumber: z.string() });

/** Uploads one tracking number. The idempotency key makes a retry after a lost reply safe. */
export function uploadHandler(ctx: AppContext, client: MarketplaceClient): JobHandler {
  return async (job) => {
    const p = payloadSchema.parse(job.payload);
    const result = await client.uploadTracking({ ...p, idempotencyKey: job.idempotency_key });
    const now = ctx.clock.now();
    if (result.kind === 'ok') {
      await ctx.db.transaction(async (tx) => {
        await tx.query(`UPDATE orders SET status = 'uploaded', uploaded_day = $2, updated_at = now() WHERE id = $1 AND status = 'uploading'`, [p.orderId, ctx.clock.day()]);
        await recordOrderEvent(
          tx,
          p.orderId,
          now,
          'uploaded',
          result.replayed
            ? `Marketplace already had this tracking (idempotent replay on attempt ${job.attempts}); still one tracking on the order`
            : `Tracking uploaded to the marketplace on attempt ${job.attempts}`,
          { jobId: job.id, status: result.status },
        );
        const order = await one<OrderRow>(tx, 'SELECT * FROM orders WHERE id = $1', [p.orderId]);
        if (order) await sendBuyerMessage(tx, order, 'shipped', now);
      });
      ctx.bus.publish('order.updated', { orderId: p.orderId });
      return { kind: 'ok', httpStatus: result.status, message: result.replayed ? 'Replayed: already uploaded' : 'Uploaded' };
    }
    if (result.kind === 'retryable') {
      await recordOrderEvent(ctx.db, p.orderId, now, 'upload_retry', `Attempt ${job.attempts} failed: ${result.code}${result.status ? ` (HTTP ${result.status})` : ''}. Will retry.`, { jobId: job.id });
      ctx.bus.publish('order.updated', { orderId: p.orderId });
      return { kind: 'retry', httpStatus: result.status, code: result.code, message: result.message, ...(result.retryAfterMs ? { retryAfterMs: result.retryAfterMs } : {}) };
    }
    return { kind: 'permanent', httpStatus: result.status, code: result.code, message: result.message };
  };
}

export function deadLetterHandler(ctx: AppContext): DeadHandler {
  return async (job, last) => {
    const p = payloadSchema.parse(job.payload);
    const status = last.code === 'ORDER_CANCELLED' ? 'cancelled' : 'upload_failed';
    await ctx.db.transaction(async (tx) => {
      await tx.query(`UPDATE orders SET status = $2, updated_at = now() WHERE id = $1 AND status = 'uploading'`, [p.orderId, status]);
      await recordOrderEvent(tx, p.orderId, ctx.clock.now(), 'dead_letter', `Upload moved to dead letter after ${job.attempts} attempt(s): ${last.code}. ${last.message}`, { jobId: job.id });
    });
    ctx.bus.publish('order.updated', { orderId: p.orderId });
  };
}
