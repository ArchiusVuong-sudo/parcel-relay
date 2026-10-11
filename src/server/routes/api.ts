import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { one } from '../db/client.js';
import type { AppContext } from '../services/context.js';
import { advanceDay } from '../services/delivery.js';
import { recordOrderEvent } from '../services/events.js';
import { marketplaceSnapshot } from '../services/marketplace.js';
import { linkAndQueue } from '../services/matching.js';
import { syncNextBatch } from '../services/pipeline.js';
import { listJobs } from '../services/queue.js';
import type { ShipmentRow } from '../services/rows.js';
import { setSetting } from '../services/settings.js';
import { ConflictError, approveTemplate, listSuppliers, redraftTemplate, rejectTemplate } from '../services/suppliers.js';
import { emailDetailView, emailsView, messagesView, metaView, orderDetailView, ordersView, overviewView, reviewView } from './views.js';

export interface ApiOptions {
  ctx: AppContext;
  reset: () => Promise<void>;
}

const idParam = z.object({ id: z.coerce.number().int().positive() });
const orderParam = z.object({ id: z.string().regex(/^SO-\d{5}$/) });
const waitQuery = z.object({ wait: z.enum(['0', '1']).optional() });

class NotFoundError extends Error {
  readonly statusCode = 404;
}

function found<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new NotFoundError(`${what} not found`);
  return value;
}

export async function apiRoutes(app: FastifyInstance, opts: ApiOptions): Promise<void> {
  const { ctx } = opts;

  app.get('/meta', async () => metaView(ctx));
  app.get('/overview', async () => overviewView(ctx));
  app.get('/emails', async () => emailsView(ctx));
  app.get('/emails/:id', async (req) => found(await emailDetailView(ctx, idParam.parse(req.params).id), 'Email'));
  app.get('/orders', async () => ordersView(ctx));
  app.get('/orders/:id', async (req) => found(await orderDetailView(ctx, orderParam.parse(req.params).id), 'Order'));
  app.get('/uploads', async () => ({ jobs: await listJobs(ctx.db), marketplace: await marketplaceSnapshot(ctx.db) }));
  app.get('/review', async () => reviewView(ctx));
  app.get('/suppliers', async () => listSuppliers(ctx));
  app.get('/messages', async () => messagesView(ctx));

  app.post('/sync', async (req, reply) => {
    const { wait } = waitQuery.parse(req.query);
    const result = await syncNextBatch(ctx);
    if (result.done) return reply.code(409).send({ error: 'INBOX_EMPTY', message: 'The synthetic mailbox has no more batches. Reset the demo to start again.' });
    if (wait === '1') await result.processing;
    else result.processing.catch((err: unknown) => app.log.error(err, 'inbox processing failed'));
    return reply.code(wait === '1' ? 200 : 202).send({ batch: result.batch, label: result.label, emails: result.emailIds.length });
  });

  app.post('/review/:id/assign', async (req) => {
    const { id } = idParam.parse(req.params);
    const { orderId } = z.object({ orderId: z.string().regex(/^SO-\d{5}$/) }).parse(req.body);
    return ctx.serial.run(async () => {
      const shipment = found(await one<ShipmentRow>(ctx.db, 'SELECT * FROM shipments WHERE id = $1', [id]), 'Shipment');
      if (shipment.status !== 'needs_review') throw new ConflictError('This shipment is not waiting for review');
      const candidates = ((shipment.match as { candidates?: { orderId: string; score: number }[] } | null)?.candidates ?? []);
      const pick = candidates.find((c) => c.orderId === orderId);
      if (!pick) throw new ConflictError(`${orderId} is not one of the candidate orders`);
      const now = ctx.clock.now();
      await ctx.db.transaction(async (tx) => {
        const linked = await linkAndQueue(tx, {
          shipmentId: id,
          orderId,
          carrierCode: shipment.carrier_code!,
          trackingNumber: shipment.tracking_number,
          decidedBy: 'reviewer',
          at: now,
          note: `Assigned by a person out of ${candidates.length} candidate orders (score ${pick.score.toFixed(2)})`,
        });
        if (!linked) throw new ConflictError(`${orderId} is no longer waiting for tracking`);
        for (const other of candidates.filter((c) => c.orderId !== orderId && c.score >= 0.4)) {
          await recordOrderEvent(tx, other.orderId, now, 'review_resolved', `Reviewer gave tracking ${shipment.tracking_number} to ${orderId}, not this order`);
        }
      });
      ctx.bus.publish('order.updated', { orderId });
      return { ok: true, orderId };
    });
  });

  app.post('/suppliers/:id/approve', async (req) => {
    await approveTemplate(ctx, idParam.parse(req.params).id);
    return { ok: true };
  });
  app.post('/suppliers/:id/reject', async (req) => {
    await rejectTemplate(ctx, idParam.parse(req.params).id);
    return { ok: true };
  });
  app.post('/suppliers/:id/redraft', async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const { wait } = waitQuery.parse(req.query);
    const work = redraftTemplate(ctx, id);
    if (wait === '1') await work;
    else work.catch((err: unknown) => app.log.error(err, 'redraft failed'));
    return reply.code(wait === '1' ? 200 : 202).send({ ok: true });
  });

  app.post('/clock/advance', async () => ctx.serial.run(() => advanceDay(ctx)));

  app.put('/marketplace/mode', async (req) => {
    const { mode } = z.object({ mode: z.enum(['normal', 'flaky']) }).parse(req.body);
    await setSetting(ctx.db, 'marketplaceMode', mode);
    ctx.bus.publish('marketplace.mode', { mode });
    return { mode };
  });

  app.post('/reset', async () => {
    await opts.reset();
    return { ok: true };
  });

  app.get('/events', (req, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    reply.raw.write(': connected\n\n');
    const send = (event: unknown) => reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), 15_000);
    ctx.bus.on('event', send);
    req.raw.on('close', () => {
      clearInterval(heartbeat);
      ctx.bus.off('event', send);
    });
  });
}
