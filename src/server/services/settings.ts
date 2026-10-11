import { one, type Queryable } from '../db/client.js';

export type MarketplaceMode = 'normal' | 'flaky';

export interface SettingsShape {
  epoch: string;
  offsetDays: number;
  marketplaceMode: MarketplaceMode;
  nextBatch: number;
  mpRequestSeq: number;
}

export async function getSetting<K extends keyof SettingsShape>(q: Queryable, key: K): Promise<SettingsShape[K]> {
  const row = await one<{ value: SettingsShape[K] }>(q, 'SELECT value FROM settings WHERE key = $1', [key]);
  if (row === undefined) throw new Error(`setting ${key} missing`);
  return row.value;
}

export async function setSetting<K extends keyof SettingsShape>(q: Queryable, key: K, value: SettingsShape[K]): Promise<void> {
  await q.query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [key, JSON.stringify(value)]);
}

/** Atomically bumps a counter setting and returns the new value. */
export async function bumpCounter(q: Queryable, key: 'mpRequestSeq'): Promise<number> {
  const row = await one<{ value: number }>(
    q,
    `UPDATE settings SET value = to_jsonb((value::text)::int + 1) WHERE key = $1 RETURNING value`,
    [key],
  );
  if (!row) throw new Error(`counter ${key} missing`);
  return row.value;
}
