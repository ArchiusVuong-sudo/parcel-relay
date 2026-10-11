import { describe, expect, it } from 'vitest';
import { loadFixtures } from '../../src/server/fixtures.js';
import { OUTPUT_JSON_SCHEMA, childEnv, sdkOptions } from '../../src/server/llm/live.js';
import { SYSTEM_PROMPT, TEST_TOOL_FULL_NAME, buildUserPrompt } from '../../src/server/llm/prompt.js';
import { ReplayDrafter, loadRecordings } from '../../src/server/llm/replay.js';
import { isTransient, withRetry } from '../../src/server/llm/retry.js';
import { FallbackDrafter, chooseDrafter } from '../../src/server/llm/select.js';
import { buildTestToolServer } from '../../src/server/llm/testTool.js';
import { LlmError, draftOutputSchema, type DraftInput, type ParserDrafter } from '../../src/server/llm/types.js';

const email = loadFixtures().mailbox.batches.find((b) => b.batch === 3)!.emails[0]!;
const input: DraftInput = { supplierName: email.fromName, senderDomain: 'fernwhistle.example.com', subject: email.subject, body: email.body, contentType: email.contentType };

describe('SDK isolation', () => {
  it('builds options with no built-in tools, no settings, no persistence and one allowed app tool', () => {
    const opts = sdkOptions('claude-sonnet-5-5', '/tmp/x', buildTestToolServer('body', [], Date.now()), new AbortController(), 6);
    expect(opts.tools).toEqual([]);
    expect(opts.settingSources).toEqual([]);
    expect(opts.persistSession).toBe(false);
    expect(opts.strictMcpConfig).toBe(true);
    expect(opts.permissionMode).toBe('dontAsk');
    expect(opts.allowedTools).toEqual([TEST_TOOL_FULL_NAME]);
    expect(Object.keys(opts.mcpServers)).toEqual(['parcel_relay']);
    expect(opts.maxTurns).toBe(6);
    expect(opts.cwd).toBe('/tmp/x');
    expect(opts.outputFormat.type).toBe('json_schema');
    expect(opts.systemPrompt).toBe(SYSTEM_PROMPT);
  });

  it('passes only allowlisted variables to the child process', () => {
    const env = childEnv({
      PATH: '/bin',
      HOME: '/home/a',
      USER: 'a',
      LANG: 'en_US.UTF-8',
      TMPDIR: '/tmp',
      CLAUDECODE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CODE_SSE_PORT: '1234',
      AWS_SECRET_ACCESS_KEY: 'nope',
      NODE_OPTIONS: '--inspect',
    });
    expect(Object.keys(env).sort()).toEqual(['HOME', 'LANG', 'PATH', 'TMPDIR', 'USER']);
  });

  it('forwards ANTHROPIC_API_KEY only when it is set', () => {
    expect(childEnv({ PATH: '/bin', ANTHROPIC_API_KEY: 'test-value' })).toHaveProperty('ANTHROPIC_API_KEY');
    expect(childEnv({ PATH: '/bin', ANTHROPIC_API_KEY: '' })).not.toHaveProperty('ANTHROPIC_API_KEY');
  });

  it('asks for a JSON schema with every field required', () => {
    expect(OUTPUT_JSON_SCHEMA.type).toBe('object');
    expect(OUTPUT_JSON_SCHEMA.required).toEqual(expect.arrayContaining(['fields', 'confidence', 'template', 'notes']));
  });

  it('puts the email inside tags and tells the model it is untrusted', () => {
    expect(buildUserPrompt(input)).toContain(`<email>\n${email.body}\n</email>`);
    expect(SYSTEM_PROMPT).toMatch(/untrusted/i);
  });
});

describe('structured output schema', () => {
  it('accepts the recorded run and rejects a malformed one', () => {
    const rec = loadRecordings()[0]!;
    expect(draftOutputSchema.safeParse(rec.output).success).toBe(true);
    expect(draftOutputSchema.safeParse({ ...rec.output, confidence: 2 }).success).toBe(false);
    expect(draftOutputSchema.safeParse({ ...rec.output, template: { flags: 'g', patterns: rec.output.template.patterns } }).success).toBe(false);
  });
});

describe('withRetry', () => {
  const noSleep = { sleep: async () => {}, random: () => 0.5 };
  it('retries overloaded and rate-limit errors, then succeeds', async () => {
    let n = 0;
    const r = await withRetry(async () => {
      n += 1;
      if (n === 1) throw new Error('529 overloaded_error');
      if (n === 2) throw new Error('429 rate limit exceeded');
      return 'ok';
    }, { attempts: 4, baseMs: 10, ...noSleep });
    expect(r).toEqual({ value: 'ok', attempts: 3 });
  });
  it('does not retry an auth or schema failure', async () => {
    let n = 0;
    await expect(withRetry(async () => { n += 1; throw new LlmError('Structured output failed the schema', false); }, { attempts: 4, baseMs: 10, ...noSleep })).rejects.toThrow('schema');
    expect(n).toBe(1);
  });
  it('gives up after the attempt cap', async () => {
    let n = 0;
    await expect(withRetry(async () => { n += 1; throw new Error('503 service unavailable'); }, { attempts: 3, baseMs: 10, ...noSleep })).rejects.toThrow('503');
    expect(n).toBe(3);
  });
  it('classifies errors', () => {
    expect(isTransient(new Error('Overloaded'))).toBe(true);
    expect(isTransient(new Error('Invalid API key'))).toBe(false);
    expect(isTransient(new LlmError('x', true))).toBe(true);
  });
});

describe('replay and fallback', () => {
  it('replays the recorded run for its email, labelled with the recording stats', async () => {
    const run = await new ReplayDrafter().draft(input);
    expect(run.mode).toBe('replay');
    expect(run.recorded?.recordedAt).toMatch(/^2026-/);
    expect(run.output.fields.tracking_number).toBe('KP512093445ZZ');
  });
  it('refuses an email it has no recording for', async () => {
    await expect(new ReplayDrafter().draft({ ...input, body: 'other' })).rejects.toThrow(/No recorded run/);
  });
  it('falls back to the recording when the live call fails, and says why', async () => {
    const failing: ParserDrafter = { mode: 'live', model: 'm', draft: async () => { throw new Error('Live call ended with error_max_turns'); } };
    const run = await new FallbackDrafter(failing, new ReplayDrafter()).draft(input);
    expect(run.mode).toBe('replay');
    expect(run.fallbackReason).toContain('error_max_turns');
  });
  it('picks replay when DEMO_REPLAY=1', () => {
    expect(chooseDrafter({ DEMO_REPLAY: '1' })).toMatchObject({ mode: 'replay', reason: 'DEMO_REPLAY=1' });
  });
});
