import type { Db } from '../db/client.js';
import type { Fixtures } from '../fixtures.js';
import type { ParserDrafter } from '../llm/types.js';
import type { BlobStore } from './blobStore.js';
import type { SimClock } from './clock.js';
import type { EventBus } from './events.js';

/** Runs tasks one after another; inbox processing and approvals share it so they never interleave. */
export class SerialRunner {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;

  run<T>(task: () => Promise<T>): Promise<T> {
    this.pending += 1;
    const next = this.tail.then(task, task);
    this.tail = next.catch(() => undefined).finally(() => {
      this.pending -= 1;
    });
    return next;
  }

  get busy(): boolean {
    return this.pending > 0;
  }

  idle(): Promise<void> {
    return this.tail.then(() => undefined);
  }
}

export interface AppContext {
  db: Db;
  blobs: BlobStore;
  bus: EventBus;
  clock: SimClock;
  fixtures: Fixtures;
  drafter: ParserDrafter;
  llm: { mode: 'live' | 'replay'; reason: string; model: string };
  serial: SerialRunner;
}
