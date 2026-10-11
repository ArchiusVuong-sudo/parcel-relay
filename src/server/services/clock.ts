export const HOUR_MS = 3600_000;
export const DAY_MS = 24 * HOUR_MS;

/**
 * Simulated business clock: wall time plus a whole number of days.
 * Retries and backoff use wall time; deadlines, scans and messages use this clock.
 */
export class SimClock {
  constructor(
    private offsetDays = 0,
    private readonly wallNow: () => number = Date.now,
  ) {}

  now(): Date {
    return new Date(this.wallNow() + this.offsetDays * DAY_MS);
  }

  day(): number {
    return this.offsetDays;
  }

  setOffsetDays(days: number): void {
    this.offsetDays = days;
  }
}
