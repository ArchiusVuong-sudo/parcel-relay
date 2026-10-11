import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PGlite, type Transaction } from '@electric-sql/pglite';
import { MIGRATIONS_DIR } from '../paths.js';

export type Db = PGlite;
/** Anything that can run a query: the database itself or an open transaction. */
export type Queryable = Pick<PGlite, 'query'> | Transaction;

/** Opens PGlite (file-backed when a directory is given, in memory otherwise) and applies migrations. */
export async function openDb(dataDir?: string): Promise<Db> {
  if (dataDir) await mkdir(dataDir, { recursive: true });
  const db = dataDir ? new PGlite(dataDir) : new PGlite();
  await db.waitReady;
  await migrate(db);
  return db;
}

export async function migrate(db: Db): Promise<string[]> {
  await db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const done = new Set((await db.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    await db.transaction(async (tx) => {
      await tx.exec(sql);
      await tx.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    });
    applied.push(file);
  }
  return applied;
}

export async function one<T>(q: Queryable, sql: string, params: unknown[] = []): Promise<T | undefined> {
  const res = await q.query<T>(sql, params);
  return res.rows[0];
}

export async function many<T>(q: Queryable, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await q.query<T>(sql, params)).rows;
}
