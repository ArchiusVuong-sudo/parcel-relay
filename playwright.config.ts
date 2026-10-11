import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';

const port = Number(process.env.PORT ?? 4115);
const dataDir = mkdtempSync(join(tmpdir(), 'parcel-relay-e2e-'));

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 120_000,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1440, height: 900 },
    // PW_CHANNEL=chrome uses an installed Chrome; otherwise run `npx playwright install chromium` once.
    ...(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {}),
  },
  webServer: {
    command: 'npm run build && node dist/server/main.js',
    url: `http://127.0.0.1:${port}/api/meta`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { PORT: String(port), DEMO_REPLAY: '1', DATA_DIR: dataDir, LOG_LEVEL: 'silent' },
  },
});
