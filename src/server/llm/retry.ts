import { LlmError } from './types.js';

const TRANSIENT = /overloaded|rate.?limit|too many requests|\b429\b|\b529\b|\b5\d\d\b|ECONNRESET|ETIMEDOUT|socket hang up|timed out/i;

/** Overloaded, rate-limit and 5xx failures are worth another try; auth, schema and turn limits are not. */
export function isTransient(err: unknown): boolean {
  if (err instanceof LlmError) return err.retryable;
  return TRANSIENT.test(err instanceof Error ? err.message : String(err));
}

export function isTransientStatus(status: number | null | undefined): boolean {
  return status === 429 || status === 529 || (typeof status === 'number' && status >= 500 && status < 600);
}

export interface RetryOptions {
  attempts: number;
  baseMs: number;
  maxMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  onRetry?: (attempt: number, err: unknown, delayMs: number) => void;
}

/** Runs fn, retrying transient failures with exponential backoff and full jitter. */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions): Promise<{ value: T; attempts: number }> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = opts.random ?? Math.random;
  for (let attempt = 1; ; attempt++) {
    try {
      return { value: await fn(attempt), attempts: attempt };
    } catch (err) {
      if (attempt >= opts.attempts || !isTransient(err)) throw err;
      const cap = Math.min(opts.maxMs ?? 30_000, opts.baseMs * 2 ** (attempt - 1));
      const delay = Math.round(cap / 2 + random() * (cap / 2));
      opts.onRetry?.(attempt, err, delay);
      await sleep(delay);
    }
  }
}
