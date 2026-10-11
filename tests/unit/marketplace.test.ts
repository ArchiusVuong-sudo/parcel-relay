import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/server/db/client.js';
import { FAULT_CYCLE, faultFor, marketplaceRoutes, marketplaceSnapshot } from '../../src/server/services/marketplace.js';
import { HttpMarketplaceClient } from '../../src/server/services/marketplaceClient.js';
import { setSetting } from '../../src/server/services/settings.js';
import { seededDb } from '../helpers.js';

let db: Db;
let app: FastifyInstance;

beforeEach(async () => {
  db = await seededDb();
  app = Fastify({ forceCloseConnections: true });
  await app.register(marketplaceRoutes, { prefix: '/sim/marketplace', db, slowReplyMs: 400 });
});
afterEach(async () => {
  await app.close();
  await db.close();
});

const post = (orderId: string, key: string | null, carrier = 'kestrelpost', trackingNumber = 'KP407318267ZZ') =>
  app.inject({
    method: 'POST',
    url: `/sim/marketplace/orders/${orderId}/tracking`,
    headers: key ? { 'idempotency-key': key } : {},
    payload: { carrier, trackingNumber },
  });

describe('fault schedule', () => {
  it('is fixed: 429 then timeout-after-commit, once per cycle, only in flaky mode', () => {
    expect(faultFor(1, 'flaky')).toBe('rate_limit');
    expect(faultFor(2, 'flaky')).toBe('timeout_after_commit');
    expect(faultFor(3, 'flaky')).toBeNull();
    expect(faultFor(1 + FAULT_CYCLE, 'flaky')).toBe('rate_limit');
    expect(faultFor(1, 'normal')).toBeNull();
  });
});

describe('simulated marketplace API', () => {
  it('creates a tracking, then replays the same idempotency key without a second row', async () => {
    expect((await post('SO-24017', 'k1')).statusCode).toBe(201);
    const again = await post('SO-24017', 'k1');
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ replayed: true });
    const snap = await marketplaceSnapshot(db);
    expect(snap.orders.find((o) => o.id === 'SO-24017')).toMatchObject({ trackings: 1, requests: 2 });
  });
  it('refuses a second, different tracking on the same order', async () => {
    await post('SO-24017', 'k1');
    expect((await post('SO-24017', 'k2', 'tidelane', '003840217755003120')).statusCode).toBe(409);
  });
  it('answers 422 for an order the buyer cancelled', async () => {
    const res = await post('SO-24039', 'k3');
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('ORDER_CANCELLED');
  });
  it('answers 422 for a carrier it does not accept', async () => {
    expect((await post('SO-24036', 'k4', 'quillmoor_courier', 'QC204118839')).json().error).toBe('CARRIER_NOT_ACCEPTED');
  });
  it('needs an idempotency key', async () => {
    expect((await post('SO-24017', null)).statusCode).toBe(400);
  });
  it('in flaky mode, rate limits request 1 with Retry-After', async () => {
    await setSetting(db, 'marketplaceMode', 'flaky');
    const res = await post('SO-24017', 'k5');
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('2');
  });
});

describe('HttpMarketplaceClient', () => {
  it('maps a slow reply after commit to a retryable timeout, and the retry replays', async () => {
    await setSetting(db, 'marketplaceMode', 'flaky');
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
    const client = new HttpMarketplaceClient(() => base, 150);
    const req = { orderId: 'SO-24017', carrierCode: 'kestrelpost', trackingNumber: 'KP407318267ZZ', idempotencyKey: 'k-time' };
    expect(await client.uploadTracking(req)).toMatchObject({ kind: 'retryable', status: 429, retryAfterMs: 2000 });
    expect(await client.uploadTracking(req)).toMatchObject({ kind: 'retryable', code: 'TIMEOUT' });
    expect(await client.uploadTracking(req)).toMatchObject({ kind: 'ok', replayed: true });
    expect(await client.uploadTracking({ ...req, orderId: 'SO-24039', idempotencyKey: 'k-c' })).toMatchObject({ kind: 'permanent', status: 422, code: 'ORDER_CANCELLED' });
    const snap = await marketplaceSnapshot(db);
    expect(snap.orders.find((o) => o.id === 'SO-24017')?.trackings).toBe(1);
  });
  it('maps a refused connection to a retryable network error', async () => {
    const client = new HttpMarketplaceClient(() => 'http://127.0.0.1:9', 300);
    expect((await client.uploadTracking({ orderId: 'SO-24017', carrierCode: 'kestrelpost', trackingNumber: 'X', idempotencyKey: 'k' })).kind).toBe('retryable');
  });
});
