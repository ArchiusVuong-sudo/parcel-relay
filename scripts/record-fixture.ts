/**
 * Makes the one live Claude call (the unknown supplier's first email) and saves the run to fixtures/llm/.
 * Replay mode and the tests play this recording back. Needs a Claude Code login or ANTHROPIC_API_KEY.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyTemplate, testTemplate } from '../src/server/domain/template.js';
import { loadFixtures } from '../src/server/fixtures.js';
import { LiveDrafter } from '../src/server/llm/live.js';
import { RECORDINGS_DIR, bodySha256, recordingSchema, type Recording } from '../src/server/llm/replay.js';
import { DEFAULT_MODEL } from '../src/server/llm/select.js';

const mailbox = loadFixtures().mailbox;
const first = mailbox.batches.find((b) => b.batch === 3)!.emails[0]!;
const second = mailbox.batches.find((b) => b.batch === 4)!.emails[0]!;
const model = process.env.LLM_MODEL || DEFAULT_MODEL;

console.log(`Live call: ${model}, drafting a parser for ${first.fromName}...`);
const drafter = new LiveDrafter({ model });
const run = await drafter.draft({
  supplierName: first.fromName,
  senderDomain: first.from.split('@')[1]!,
  subject: first.subject,
  body: first.body,
  contentType: first.contentType,
});

const test = testTemplate(run.output.template, first.body, run.output.fields);
const onSecond = applyTemplate(run.output.template, second.body);
console.log(`Done in ${run.durationMs} ms, ${run.numTurns} turns, cost estimate $${run.costUsd?.toFixed(4)}, attempts ${run.attempts}`);
console.log(`Template test on the first email: ${test.summary}`);
console.log(`Template on the second email (not seen by the model): ${JSON.stringify(onSecond.fields)}`);

const recording: Recording = recordingSchema.parse({
  label: 'Recorded from a live run',
  recordedAt: new Date().toISOString(),
  model: run.model,
  emailSha256: bodySha256(first.body),
  durationMs: run.durationMs,
  costUsd: run.costUsd,
  numTurns: run.numTurns,
  attempts: run.attempts,
  output: run.output,
  trace: run.trace,
});
mkdirSync(RECORDINGS_DIR, { recursive: true });
const file = join(RECORDINGS_DIR, 'fernwhistle-toys.json');
writeFileSync(file, `${JSON.stringify(recording, null, 2)}\n`);
console.log(`Saved ${file}`);
if (!test.passed) {
  console.error('The drafted template failed its own test. The recording is saved, but approval will be blocked in the app.');
  process.exitCode = 2;
}
