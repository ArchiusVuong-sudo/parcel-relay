import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { SYSTEM_PROMPT, TEST_TOOL_FULL_NAME, TOOL_SERVER, buildUserPrompt } from './prompt.js';
import { isTransientStatus, withRetry } from './retry.js';
import { buildTestToolServer } from './testTool.js';
import { LlmError, draftOutputSchema, type DraftInput, type DraftRun, type ParserDrafter, type TraceStep } from './types.js';

const ENV_ALLOWLIST = ['PATH', 'HOME', 'USER', 'LANG', 'TMPDIR', 'ANTHROPIC_API_KEY'] as const;

/** The child process gets only these variables: no CLAUDECODE or CLAUDE_CODE_* from a parent session. */
export function childEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    const value = source[key];
    if (value) env[key] = value;
  }
  return env;
}

export const OUTPUT_JSON_SCHEMA = z.toJSONSchema(draftOutputSchema, { target: 'draft-7' }) as Record<string, unknown>;

export interface LiveOptions {
  model: string;
  maxTurns?: number;
  timeoutMs?: number;
  attempts?: number;
}

/** Builds the exact SDK options for one isolated call. Exported so tests can pin every setting. */
export function sdkOptions(model: string, cwd: string, server: ReturnType<typeof buildTestToolServer>, abortController: AbortController, maxTurns: number) {
  return {
    model,
    systemPrompt: SYSTEM_PROMPT,
    tools: [] as string[],
    allowedTools: [TEST_TOOL_FULL_NAME],
    mcpServers: { [TOOL_SERVER]: server },
    strictMcpConfig: true,
    settingSources: [] as [],
    persistSession: false,
    permissionMode: 'dontAsk' as const,
    cwd,
    maxTurns,
    env: childEnv(),
    outputFormat: { type: 'json_schema' as const, schema: OUTPUT_JSON_SCHEMA },
    abortController,
  };
}

export class LiveDrafter implements ParserDrafter {
  readonly mode = 'live' as const;
  readonly model: string;
  private readonly maxTurns: number;
  private readonly timeoutMs: number;
  private readonly attempts: number;

  constructor(opts: LiveOptions) {
    this.model = opts.model;
    this.maxTurns = opts.maxTurns ?? 6;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.attempts = opts.attempts ?? 3;
  }

  async draft(input: DraftInput): Promise<DraftRun> {
    const startedAt = Date.now();
    const retries: TraceStep[] = [];
    const { value, attempts } = await withRetry(() => this.once(input), {
      attempts: this.attempts,
      baseMs: 2000,
      onRetry: (attempt, err, delayMs) =>
        retries.push({ kind: 'retry', label: `Attempt ${attempt} failed, retrying in ${delayMs} ms`, atMs: Date.now() - startedAt, detail: String((err as Error).message ?? err) }),
    });
    return { ...value, attempts, trace: [...retries, ...value.trace], durationMs: Date.now() - startedAt };
  }

  private async once(input: DraftInput): Promise<DraftRun> {
    const startedAt = Date.now();
    const trace: TraceStep[] = [{ kind: 'prompt', label: `Prompt sent to ${this.model}`, atMs: 0, detail: { maxTurns: this.maxTurns, tools: [TEST_TOOL_FULL_NAME] } }];
    const cwd = await mkdtemp(join(tmpdir(), 'parcel-relay-llm-'));
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.timeoutMs);
    const server = buildTestToolServer(input.body, trace, startedAt);
    let result: SDKResultMessage | undefined;
    try {
      const run = query({ prompt: buildUserPrompt(input), options: sdkOptions(this.model, cwd, server, abort, this.maxTurns) });
      for await (const message of run) {
        if (message.type === 'assistant') {
          for (const block of message.message.content) {
            if (block.type === 'tool_use') {
              trace.push({ kind: 'tool_call', label: `Model called ${block.name.replace(`mcp__${TOOL_SERVER}__`, '')}`, atMs: Date.now() - startedAt, detail: block.input });
            }
          }
        } else if (message.type === 'result') {
          result = message;
        }
      }
    } catch (err) {
      if (abort.signal.aborted) throw new LlmError(`Live call timed out after ${this.timeoutMs} ms`, true);
      throw err;
    } finally {
      clearTimeout(timer);
      await rm(cwd, { recursive: true, force: true });
    }

    if (!result) throw new LlmError('The SDK returned no result', true);
    if (result.subtype !== 'success') {
      throw new LlmError(`Live call ended with ${result.subtype}`, false);
    }
    if (result.is_error) {
      const status = result.api_error_status ?? null;
      throw new LlmError(`Live call failed${status ? ` (HTTP ${status})` : ''}: ${result.result.slice(0, 200)}`, isTransientStatus(status));
    }
    const parsed = draftOutputSchema.safeParse(result.structured_output);
    trace.push({
      kind: 'schema_check',
      label: parsed.success ? 'Structured output matches the schema' : 'Structured output failed the schema',
      atMs: Date.now() - startedAt,
      ...(parsed.success ? {} : { detail: parsed.error.issues.slice(0, 5) }),
    });
    if (!parsed.success) throw new LlmError('Structured output failed the schema', false);
    trace.push({ kind: 'output', label: `Draft returned, confidence ${parsed.data.confidence}`, atMs: Date.now() - startedAt });
    return {
      output: parsed.data,
      mode: 'live',
      model: this.model,
      durationMs: result.duration_ms,
      recorded: null,
      costUsd: result.total_cost_usd,
      numTurns: result.num_turns,
      attempts: 1,
      trace,
    };
  }
}
