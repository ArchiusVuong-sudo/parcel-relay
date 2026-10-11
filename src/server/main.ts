import { buildApp } from './app.js';
import { DEFAULT_DATA_DIR } from './paths.js';

const port = Number(process.env.PORT ?? 4115);
const host = process.env.HOST ?? '127.0.0.1';
const dataDir = process.env.DATA_DIR ?? DEFAULT_DATA_DIR;

const app = await buildApp({ dataDir, logger: process.env.LOG_LEVEL !== 'silent' });
const url = await app.listen(port, host);
app.server.log.info(`parcel-relay on ${url} (LLM: ${app.ctx.llm.mode}, ${app.ctx.llm.reason})`);

let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    app
      .close()
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        console.error(err);
        process.exit(1);
      });
  });
}
