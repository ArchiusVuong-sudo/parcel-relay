import { buildApp, type App } from '../src/server/app.js';
import { openDb, type Db } from '../src/server/db/client.js';
import { resetAndSeed } from '../src/server/db/seed.js';
import { loadFixtures } from '../src/server/fixtures.js';
import { ReplayDrafter } from '../src/server/llm/replay.js';
import type { DraftInput, DraftRun, ParserDrafter } from '../src/server/llm/types.js';
import { MemoryBlobStore } from '../src/server/services/blobStore.js';
import { SimClock } from '../src/server/services/clock.js';
import { SerialRunner, type AppContext } from '../src/server/services/context.js';
import { EventBus } from '../src/server/services/events.js';

export async function seededDb(now = Date.parse('2026-10-11T08:00:00Z')): Promise<Db> {
  const db = await openDb();
  await resetAndSeed(db, loadFixtures(), now);
  return db;
}

/** A drafter that counts calls and delegates to another (the replay drafter by default). */
export class CountingDrafter implements ParserDrafter {
  calls = 0;
  readonly mode: 'live' | 'replay';
  readonly model: string;
  constructor(private readonly inner: ParserDrafter = new ReplayDrafter()) {
    this.mode = inner.mode;
    this.model = inner.model;
  }
  async draft(input: DraftInput): Promise<DraftRun> {
    this.calls += 1;
    return this.inner.draft(input);
  }
}

export async function testContext(drafter: ParserDrafter = new ReplayDrafter()): Promise<AppContext> {
  return {
    db: await seededDb(Date.now()),
    blobs: new MemoryBlobStore(),
    bus: new EventBus(),
    clock: new SimClock(0),
    fixtures: loadFixtures(),
    drafter,
    llm: { mode: drafter.mode, reason: 'test', model: drafter.model },
    serial: new SerialRunner(),
  };
}

export interface RunningApp {
  app: App;
  base: string;
  api<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }>;
  close(): Promise<void>;
}

/** Full app in memory on a random port, replay mode, fast retries. */
export async function startApp(drafter: ParserDrafter = new ReplayDrafter()): Promise<RunningApp> {
  const app = await buildApp({
    drafter: { drafter, mode: drafter.mode, reason: 'test' },
    serveWeb: false,
    backoff: { baseMs: 100, maxMs: 1000 },
    workerPollMs: 25,
    clientTimeoutMs: 300,
    slowReplyMs: 500,
  });
  const base = await app.listen(0);
  return {
    app,
    base,
    async api<T = any>(method: string, path: string, body?: unknown) {
      const res = await fetch(`${base}/api${path}`, {
        method,
        ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      });
      return { status: res.status, body: (await res.json()) as T };
    },
    close: () => app.close(),
  };
}

export async function until(what: string, check: () => Promise<boolean> | boolean, timeoutMs = 15_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for: ${what}`);
}
