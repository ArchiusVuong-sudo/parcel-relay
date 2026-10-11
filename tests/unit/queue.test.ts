import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { many, openDb, type Db } from '../../src/server/db/client.js';
import { Worker, backoffMs, claimNext, enqueue, listJobs, type JobOutcome } from '../../src/server/services/queue.js';

let db: Db;
beforeEach(async () => {
  db = await openDb();
});
afterEach(async () => {
  await db.close();
});

const job = (key: string, runAt = new Date(0)) => ({ kind: 'upload_tracking', payload: { orderId: key }, idempotencyKey: key, runAt });

describe('enqueue', () => {
  it('creates one job per idempotency key', async () => {
    const a = await enqueue(db, job('k1'));
    const b = await enqueue(db, job('k1'));
    expect(a.created).toBe(true);
    expect(b).toEqual({ id: a.id, created: false });
    expect((await many(db, 'SELECT id FROM jobs')).length).toBe(1);
  });
});

describe('claimNext', () => {
  it('claims due jobs in order and skips future ones', async () => {
    await enqueue(db, job('a', new Date(1000)));
    await enqueue(db, job('b', new Date(2000)));
    await enqueue(db, job('later', new Date(9_999_999_999_999)));
    const now = new Date(5000);
    expect((await claimNext(db, now))?.idempotency_key).toBe('a');
    expect((await claimNext(db, now))?.idempotency_key).toBe('b');
    expect(await claimNext(db, now)).toBeUndefined();
  });
  it('marks the job running and counts the attempt', async () => {
    await enqueue(db, job('a'));
    const j = await claimNext(db, new Date());
    expect(j).toMatchObject({ status: 'running', attempts: 1 });
  });
  it('reclaims a running job whose lease expired', async () => {
    await enqueue(db, job('a'));
    await claimNext(db, new Date(10_000));
    expect(await claimNext(db, new Date(20_000), 30_000)).toBeUndefined();
    expect((await claimNext(db, new Date(50_000), 30_000))?.attempts).toBe(2);
  });
  it('uses FOR UPDATE SKIP LOCKED in the claim', async () => {
    const src = (await import('node:fs')).readFileSync(new URL('../../src/server/services/queue.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/FOR UPDATE SKIP LOCKED/);
  });
});

describe('backoffMs', () => {
  it('doubles per attempt with bounded jitter and a cap', () => {
    const opts = { baseMs: 2000, maxMs: 30_000 };
    expect(backoffMs(1, opts, () => 0)).toBe(1600);
    expect(backoffMs(1, opts, () => 0.999)).toBeLessThanOrEqual(2400);
    expect(backoffMs(3, opts, () => 0.5)).toBe(8000);
    expect(backoffMs(10, opts, () => 0.5)).toBe(30_000);
  });
});

describe('Worker', () => {
  function worker(outcomes: JobOutcome[], clock: { t: number }, dead: string[] = []) {
    return new Worker({
      db,
      handlers: { upload_tracking: async () => outcomes.shift() ?? { kind: 'ok' } },
      onDead: async (j, last) => void dead.push(`${j.idempotency_key}:${last.code}`),
      backoff: { baseMs: 1000, maxMs: 10_000 },
      wallNow: () => clock.t,
      random: () => 0.5,
    });
  }

  it('retries a transient failure after the backoff, then completes', async () => {
    const clock = { t: 1_000_000 };
    const w = worker([{ kind: 'retry', httpStatus: 429, code: 'RATE_LIMITED', message: 'slow down' }], clock);
    await enqueue(db, job('a', new Date(clock.t)));
    await w.tick();
    let [j] = await listJobs(db);
    expect(j).toMatchObject({ status: 'queued', attempts: 1 });
    expect(new Date(j!.runAt).getTime()).toBe(clock.t + 1000);
    await w.tick();
    expect((await listJobs(db))[0]!.status).toBe('queued');
    clock.t += 1000;
    await w.tick();
    [j] = await listJobs(db);
    expect(j).toMatchObject({ status: 'done', attempts: 2 });
    expect(j!.history.map((h) => h.outcome)).toEqual(['retry', 'ok']);
    expect(j!.history[0]).toMatchObject({ httpStatus: 429, code: 'RATE_LIMITED' });
  });

  it('honours Retry-After when it is longer than the backoff', async () => {
    const clock = { t: 0 };
    const w = worker([{ kind: 'retry', code: 'RATE_LIMITED', message: '', retryAfterMs: 5000 }], clock);
    await enqueue(db, job('a', new Date(0)));
    await w.tick();
    expect(new Date((await listJobs(db))[0]!.runAt).getTime()).toBe(5000);
  });

  it('dead-letters a permanent error after one attempt, with no retry', async () => {
    const clock = { t: 0 };
    const dead: string[] = [];
    const w = worker([{ kind: 'permanent', httpStatus: 422, code: 'ORDER_CANCELLED', message: 'cancelled' }], clock, dead);
    await enqueue(db, job('a', new Date(0)));
    await w.tick();
    const [j] = await listJobs(db);
    expect(j).toMatchObject({ status: 'dead', attempts: 1 });
    expect(dead).toEqual(['a:ORDER_CANCELLED']);
  });

  it('dead-letters after max attempts of transient failures', async () => {
    const clock = { t: 0 };
    const dead: string[] = [];
    const fail: JobOutcome = { kind: 'retry', code: 'TIMEOUT', message: 'no answer' };
    const w = worker([fail, fail, fail, fail, fail, fail], clock, dead);
    await enqueue(db, { ...job('a', new Date(0)), maxAttempts: 3 });
    for (let i = 0; i < 3; i++) {
      await w.tick();
      clock.t += 60_000;
    }
    const [j] = await listJobs(db);
    expect(j).toMatchObject({ status: 'dead', attempts: 3 });
    expect(j!.history.map((h) => h.outcome)).toEqual(['retry', 'retry', 'dead']);
    expect(dead).toEqual(['a:TIMEOUT']);
  });

  it('treats a thrown handler error as transient', async () => {
    const clock = { t: 0 };
    const w = new Worker({ db, handlers: { upload_tracking: async () => { throw new Error('boom'); } }, wallNow: () => clock.t, random: () => 0.5 });
    await enqueue(db, job('a', new Date(0)));
    await w.tick();
    expect((await listJobs(db))[0]).toMatchObject({ status: 'queued', lastError: 'HANDLER_ERROR: boom' });
  });

  it('pause waits for the job in flight and claims nothing new', async () => {
    const clock = { t: 0 };
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const w = new Worker({ db, handlers: { upload_tracking: async () => { await gate; return { kind: 'ok' }; } }, wallNow: () => clock.t });
    await enqueue(db, job('a', new Date(0)));
    await enqueue(db, job('b', new Date(0)));
    const running = w.tick();
    await new Promise((r) => setTimeout(r, 20));
    const paused = w.pause();
    release();
    await paused;
    await running;
    const jobs = await listJobs(db);
    expect(jobs.map((j) => j.status)).toEqual(['done', 'queued']);
  });
});
