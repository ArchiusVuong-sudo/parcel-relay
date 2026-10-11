import { existsSync } from 'node:fs';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { openDb } from './db/client.js';
import { resetAndSeed } from './db/seed.js';
import { loadFixtures } from './fixtures.js';
import { chooseDrafter, type DrafterChoice } from './llm/select.js';
import { WEB_DIST_DIR } from './paths.js';
import { apiRoutes } from './routes/api.js';
import { LocalBlobStore, MemoryBlobStore } from './services/blobStore.js';
import { SimClock } from './services/clock.js';
import { SerialRunner, type AppContext } from './services/context.js';
import { EventBus } from './services/events.js';
import { marketplaceRoutes } from './services/marketplace.js';
import { HttpMarketplaceClient } from './services/marketplaceClient.js';
import { Worker, type BackoffOptions } from './services/queue.js';
import { getSetting } from './services/settings.js';
import { deadLetterHandler, uploadHandler } from './services/uploads.js';

export interface AppOptions {
  /** Directory for PGlite and raw emails. In memory when omitted (tests). */
  dataDir?: string;
  drafter?: DrafterChoice;
  logger?: boolean;
  serveWeb?: boolean;
  backoff?: BackoffOptions;
  workerPollMs?: number;
  clientTimeoutMs?: number;
  slowReplyMs?: number;
}

export interface App {
  server: FastifyInstance;
  ctx: AppContext;
  worker: Worker;
  listen(port: number, host?: string): Promise<string>;
  close(): Promise<void>;
}

export async function buildApp(opts: AppOptions = {}): Promise<App> {
  const db = await openDb(opts.dataDir ? join(opts.dataDir, 'pg') : undefined);
  const blobs = opts.dataDir ? new LocalBlobStore(join(opts.dataDir, 'blobs')) : new MemoryBlobStore();
  const fixtures = loadFixtures();
  const seeded = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM settings`)).rows[0]!.n > 0;
  if (!seeded) await resetAndSeed(db, fixtures, Date.now());
  const clock = new SimClock(await getSetting(db, 'offsetDays'));
  const choice = opts.drafter ?? chooseDrafter();
  const ctx: AppContext = {
    db,
    blobs,
    bus: new EventBus(),
    clock,
    fixtures,
    drafter: choice.drafter,
    llm: { mode: choice.mode, reason: choice.reason, model: choice.drafter.model },
    serial: new SerialRunner(),
  };
  ctx.bus.setMaxListeners(100);

  const server = Fastify({ logger: opts.logger ?? false, forceCloseConnections: true });
  let baseUrl = '';
  const client = new HttpMarketplaceClient(() => baseUrl, opts.clientTimeoutMs ?? 1500);
  const worker = new Worker({
    db,
    handlers: { upload_tracking: uploadHandler(ctx, client) },
    onDead: deadLetterHandler(ctx),
    onChange: (job, outcome) => ctx.bus.publish('job.updated', { jobId: job.id, outcome }),
    ...(opts.backoff ? { backoff: opts.backoff } : {}),
    pollMs: opts.workerPollMs ?? 250,
  });

  const reset = () =>
    ctx.serial.run(async () => {
      await worker.pause();
      try {
        await resetAndSeed(db, fixtures, Date.now());
        await blobs.clear();
        clock.setOffsetDays(0);
      } finally {
        worker.resume();
      }
      ctx.bus.publish('demo.reset');
    });

  server.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: 'VALIDATION', message: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    const status = (err as { statusCode?: number }).statusCode;
    const message = err instanceof Error ? err.message : String(err);
    if (status && status >= 400 && status < 500) return reply.code(status).send({ error: 'REQUEST', message });
    req.log.error(err);
    return reply.code(500).send({ error: 'INTERNAL', message: 'Something went wrong. Check the server log.' });
  });

  await server.register(marketplaceRoutes, { prefix: '/sim/marketplace', db, slowReplyMs: opts.slowReplyMs ?? 2500 });
  await server.register(apiRoutes, { prefix: '/api', ctx, reset });

  if (opts.serveWeb !== false && existsSync(join(WEB_DIST_DIR, 'index.html'))) {
    await server.register(fastifyStatic, { root: WEB_DIST_DIR, prefix: '/', wildcard: false });
    server.setNotFoundHandler((req, reply) => {
      if (req.method !== 'GET' || req.url.startsWith('/api') || req.url.startsWith('/sim')) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Not found' });
      return reply.sendFile('index.html');
    });
  }

  server.addHook('onClose', async () => {
    await worker.stop();
    await ctx.serial.idle();
    await db.close();
  });

  return {
    server,
    ctx,
    worker,
    async listen(port, host = '127.0.0.1') {
      await server.listen({ port, host });
      const addr = server.server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      baseUrl = `http://${host}:${actualPort}`;
      worker.start();
      return baseUrl;
    },
    close: () => server.close(),
  };
}
