import { z } from 'zod';
import { templatePatternsSchema, type Fields } from '../domain/template.js';

export const fieldsSchema = z.object({
  tracking_number: z.string().max(80),
  carrier: z.string().max(80),
  buyer_name: z.string().max(120),
  street: z.string().max(160),
  postal_code: z.string().max(20),
  items: z.string().max(200),
});

/** What the model must return. Checked against this schema after the call, whatever the SDK says. */
export const draftOutputSchema = z.object({
  fields: fieldsSchema,
  confidence: z.number().min(0).max(1),
  template: z.object({
    flags: z.string().regex(/^[ims]{0,3}$/),
    patterns: templatePatternsSchema,
  }),
  notes: z.string().max(600),
});
export type DraftOutput = z.infer<typeof draftOutputSchema>;

export interface DraftInput {
  supplierName: string;
  senderDomain: string;
  subject: string;
  body: string;
  contentType: string;
}

export interface TraceStep {
  kind: 'prompt' | 'tool_call' | 'tool_result' | 'output' | 'schema_check' | 'retry' | 'fallback';
  label: string;
  atMs: number;
  detail?: unknown;
}

export interface DraftRun {
  output: DraftOutput;
  mode: 'live' | 'replay';
  model: string;
  /** Wall time of this call. In replay mode it is the replay itself, near zero. */
  durationMs: number;
  /** Numbers from the live run; in replay mode they come from the recording. */
  recorded: { durationMs: number; costUsd: number | null; numTurns: number | null; recordedAt: string } | null;
  costUsd: number | null;
  numTurns: number | null;
  attempts: number;
  trace: TraceStep[];
  fallbackReason?: string;
}

/** One provider interface, two implementations: live (Agent SDK) and replay (recorded runs). */
export interface ParserDrafter {
  readonly mode: 'live' | 'replay';
  readonly model: string;
  draft(input: DraftInput): Promise<DraftRun>;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

export type { Fields };
