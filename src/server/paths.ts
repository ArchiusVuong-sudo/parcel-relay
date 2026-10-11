import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function findRoot(start: string): string {
  let dir = start;
  while (!existsSync(join(dir, 'package.json'))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error('package root not found');
    dir = parent;
  }
  return dir;
}

/** Repo root, found from this file so it works from src/ (tsx) and dist/ (compiled). */
export const ROOT = findRoot(dirname(fileURLToPath(import.meta.url)));
export const FIXTURES_DIR = join(ROOT, 'fixtures');
export const MIGRATIONS_DIR = join(ROOT, 'src', 'server', 'db', 'migrations');
export const WEB_DIST_DIR = join(ROOT, 'dist', 'web');
export const DEFAULT_DATA_DIR = join(ROOT, 'data');
