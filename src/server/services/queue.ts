import { many, one, type Db, type Queryable } from '../db/client.js';

/**
 * A Postgres job queue: FOR UPDATE SKIP LOCKED claims, a unique idempotency key per job,
 * exponential backoff with jitter, and a dead letter state.
 * Written for several workers on a server Postgres; here PGlite runs one worker in the web process.
 */

export interface Job {
  id: number;
  kind: string;
  payload: Record<string, unknown>;
  idempotency_key: string;
  status: 'queued' | 'running' | 'done' | 'dead';
  attempts: number;
  max_attempts: number;
  run_at: string;
}

export type JobOutcome =
  | { kind: 'ok'; httpStatus?: number; message?: string }
  | { kind: 'retry'; httpStatus?: number | null; code: string; message: string; retryAfterMs?: number }
  | { kind: 'permanent'; httpStatus?: number; code: string; message: string };

export type JobHandler = (job: Job) => Promise<JobOutcome>;
export type DeadHandler = (job: Job, last: { code: string; message: string }) => Promise<void>;

export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
}

/** base * 2^(attempt-1), scaled by a jitter factor in [0.8, 1.2), capped. */
export function backoffMs(attempt: number, opts: BackoffOptions, random: () => number = Math.random): number {
  const exp = opts.baseMs * 2 ** Math.max(0, attempt - 1);
  const jitter = 0.8 + random() * 0.4;
  return Math.min(opts.maxMs, Math.round(exp * jitter));
}

export async function enqueue(
  q: Queryable,
  input: { kind: string; payload: Record<string, unknown>; idempotencyKey: string; maxAttempts?: number; runAt?: Date },
): Promise<{ id: number; created: boolean }> {
  const inserted = await one<{ id: number }>(
    q,
    `INSERT INTO jobs (kind, payload, idempotency_key, status, max_attempts, run_at)
     VALUES ($1, $2, $3, 'queued', $4, $5) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
    [input.kind, JSON.stringify(input.payload), input.idempotencyKey, input.maxAttempts ?? 5, (input.runAt ?? new Date()).toISOString()],
  );
  if (inserted) return { id: Number(inserted.id), created: true };
  const existing = await one<{ id: number }>(q, 'SELECT id FROM jobs WHERE idempotency_key = $1', [input.idempotencyKey]);
  return { id: Number(existing!.id), created: false };
}

/**
 * Claims the next due job. A running job whose lease expired (its worker died) is claimable again.
 */
export async function claimNext(db: Db, now: Date, leaseMs = 30_000): Promise<Job | undefined> {
  return db.transaction(async (tx) => {
    const job = await one<Job>(
      tx,
      `UPDATE jobs SET status = 'running', attempts = attempts + 1, locked_at = $1, updated_at = $1
        WHERE id = (
          SELECT id FROM jobs
           WHERE (status = 'queued' AND run_at <= $1)
              OR (status = 'running' AND locked_at < $2)
           ORDER BY run_at, id
           FOR UPDATE SKIP LOCKED
           LIMIT 1)
        RETURNING id, kind, payload, idempotency_key, status, attempts, max_attempts, run_at`,
      [now.toISOString(), new Date(now.getTime() - leaseMs).toISOString()],
    );
    return job ? { ...job, id: Number(job.id) } : undefined;
  });
}

interface AttemptRecord {
  startedAt: Date;
  durationMs: number;
  httpStatus?: number | null;
  code?: string;
  message?: string;
}

async function logAttempt(q: Queryable, job: Job, outcome: 'ok' | 'retry' | 'dead', rec: AttemptRecord, nextRunAt: Date | null) {
  await q.query(
    `INSERT INTO job_attempts (job_id, attempt, started_at, duration_ms, outcome, http_status, code, message, next_run_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [job.id, job.attempts, rec.startedAt.toISOString(), rec.durationMs, outcome, rec.httpStatus ?? null, rec.code ?? null, rec.message ?? null, nextRunAt?.toISOString() ?? null],
  );
}

export interface WorkerOptions {
  db: Db;
  handlers: Record<string, JobHandler>;
  onDead?: DeadHandler;
  onChange?: (job: Job, outcome: 'ok' | 'retry' | 'dead') => void;
  backoff?: BackoffOptions;
  pollMs?: number;
  wallNow?: () => number;
  random?: () => number;
}

export class Worker {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private paused = false;
  private readonly backoff: BackoffOptions;
  private readonly wallNow: () => number;

  constructor(private readonly opts: WorkerOptions) {
    this.backoff = opts.backoff ?? { baseMs: 2000, maxMs: 30_000 };
    this.wallNow = opts.wallNow ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.opts.pollMs ?? 250);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }

  /** Stops claiming new jobs and waits for the one in flight. */
  async pause(): Promise<void> {
    this.paused = true;
    await this.running;
  }

  resume(): void {
    this.paused = false;
  }

  /** One pass: drain every job that is due now. Never runs two passes at once. */
  tick(): Promise<void> {
    if (this.paused) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.drain().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async drain(): Promise<void> {
    for (;;) {
      if (this.paused) return;
      const job = await claimNext(this.opts.db, new Date(this.wallNow()));
      if (!job) return;
      await this.runJob(job);
    }
  }

  async runJob(job: Job): Promise<void> {
    const { db } = this.opts;
    const handler = this.opts.handlers[job.kind];
    const startedAt = new Date(this.wallNow());
    let outcome: JobOutcome;
    try {
      outcome = handler ? await handler(job) : { kind: 'permanent', code: 'NO_HANDLER', message: `No handler for ${job.kind}` };
    } catch (err) {
      outcome = { kind: 'retry', code: 'HANDLER_ERROR', message: (err as Error).message };
    }
    const durationMs = this.wallNow() - startedAt.getTime();
    const rec: AttemptRecord = { startedAt, durationMs, ...('httpStatus' in outcome ? { httpStatus: outcome.httpStatus ?? null } : {}) };

    if (outcome.kind === 'ok') {
      await db.transaction(async (tx) => {
        await tx.query(`UPDATE jobs SET status = 'done', locked_at = NULL, last_error = NULL, updated_at = now() WHERE id = $1`, [job.id]);
        await logAttempt(tx, job, 'ok', { ...rec, ...(outcome.message ? { message: outcome.message } : {}) }, null);
      });
      this.opts.onChange?.(job, 'ok');
      return;
    }

    const last = { code: outcome.code, message: outcome.message };
    const exhausted = job.attempts >= job.max_attempts;
    if (outcome.kind === 'permanent' || exhausted) {
      await db.transaction(async (tx) => {
        await tx.query(`UPDATE jobs SET status = 'dead', locked_at = NULL, last_error = $2, updated_at = now() WHERE id = $1`, [job.id, `${last.code}: ${last.message}`]);
        await logAttempt(tx, job, 'dead', { ...rec, ...last }, null);
      });
      await this.opts.onDead?.(job, last);
      this.opts.onChange?.(job, 'dead');
      return;
    }

    const delay = Math.max(backoffMs(job.attempts, this.backoff, this.opts.random), outcome.retryAfterMs ?? 0);
    const nextRunAt = new Date(this.wallNow() + delay);
    await db.transaction(async (tx) => {
      await tx.query(`UPDATE jobs SET status = 'queued', locked_at = NULL, run_at = $2, last_error = $3, updated_at = now() WHERE id = $1`, [
        job.id,
        nextRunAt.toISOString(),
        `${last.code}: ${last.message}`,
      ]);
      await logAttempt(tx, job, 'retry', { ...rec, ...last }, nextRunAt);
    });
    this.opts.onChange?.(job, 'retry');
  }
}

export interface JobView {
  id: number;
  kind: string;
  orderId: string | null;
  status: string;
  attempts: number;
  maxAttempts: number;
  runAt: string;
  lastError: string | null;
  idempotencyKey: string;
  history: { attempt: number; outcome: string; httpStatus: number | null; code: string | null; message: string | null; durationMs: number; startedAt: string; nextRunAt: string | null }[];
}

export async function listJobs(db: Db): Promise<JobView[]> {
  const jobs = await many<{ id: number; kind: string; payload: { orderId?: string }; status: string; attempts: number; max_attempts: number; run_at: string; last_error: string | null; idempotency_key: string }>(
    db,
    'SELECT id, kind, payload, status, attempts, max_attempts, run_at, last_error, idempotency_key FROM jobs ORDER BY id',
  );
  const attempts = await many<{ job_id: number; attempt: number; outcome: string; http_status: number | null; code: string | null; message: string | null; duration_ms: number; started_at: string; next_run_at: string | null }>(
    db,
    'SELECT job_id, attempt, outcome, http_status, code, message, duration_ms, started_at, next_run_at FROM job_attempts ORDER BY id',
  );
  return jobs.map((j) => ({
    id: Number(j.id),
    kind: j.kind,
    orderId: j.payload.orderId ?? null,
    status: j.status,
    attempts: j.attempts,
    maxAttempts: j.max_attempts,
    runAt: j.run_at,
    lastError: j.last_error,
    idempotencyKey: j.idempotency_key,
    history: attempts
      .filter((a) => Number(a.job_id) === Number(j.id))
      .map((a) => ({ attempt: a.attempt, outcome: a.outcome, httpStatus: a.http_status, code: a.code, message: a.message, durationMs: a.duration_ms, startedAt: a.started_at, nextRunAt: a.next_run_at })),
  }));
}
