import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { FIXTURES_DIR } from '../paths.js';
import { LlmError, draftOutputSchema, type DraftInput, type DraftRun, type ParserDrafter } from './types.js';

export const RECORDINGS_DIR = join(FIXTURES_DIR, 'llm');

export const recordingSchema = z.object({
  label: z.literal('Recorded from a live run'),
  recordedAt: z.string(),
  model: z.string(),
  emailSha256: z.string().regex(/^[a-f0-9]{64}$/),
  durationMs: z.number(),
  costUsd: z.number().nullable(),
  numTurns: z.number().nullable(),
  attempts: z.number(),
  output: draftOutputSchema,
  trace: z.array(z.object({ kind: z.string(), label: z.string(), atMs: z.number(), detail: z.unknown().optional() })),
});
export type Recording = z.infer<typeof recordingSchema>;

export function bodySha256(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

export function loadRecordings(dir = RECORDINGS_DIR): Recording[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => recordingSchema.parse(JSON.parse(readFileSync(join(dir, f), 'utf8'))));
}

/** Plays back responses recorded from real live runs, matched by the email body hash. */
export class ReplayDrafter implements ParserDrafter {
  readonly mode = 'replay' as const;
  readonly model: string;
  private readonly recordings: Recording[];

  constructor(recordings: Recording[] = loadRecordings()) {
    this.recordings = recordings;
    this.model = recordings[0]?.model ?? 'recorded';
  }

  hasRecordingFor(body: string): boolean {
    const sha = bodySha256(body);
    return this.recordings.some((r) => r.emailSha256 === sha);
  }

  async draft(input: DraftInput): Promise<DraftRun> {
    const started = Date.now();
    const sha = bodySha256(input.body);
    const rec = this.recordings.find((r) => r.emailSha256 === sha);
    if (!rec) throw new LlmError('No recorded run for this email. Run npm run record-fixture with a Claude login.', false);
    return {
      output: rec.output,
      mode: 'replay',
      model: rec.model,
      durationMs: Date.now() - started,
      recorded: { durationMs: rec.durationMs, costUsd: rec.costUsd, numTurns: rec.numTurns, recordedAt: rec.recordedAt },
      costUsd: null,
      numTurns: rec.numTurns,
      attempts: 1,
      trace: [
        { kind: 'fallback', label: `Replaying the run recorded ${rec.recordedAt.slice(0, 10)} (${rec.model})`, atMs: 0 },
        ...rec.trace.map((t) => ({ ...t, kind: t.kind as DraftRun['trace'][number]['kind'] })),
      ],
    };
  }
}
