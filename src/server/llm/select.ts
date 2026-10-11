import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { LiveDrafter } from './live.js';
import { ReplayDrafter } from './replay.js';
import type { DraftInput, DraftRun, ParserDrafter } from './types.js';

export const DEFAULT_MODEL = 'claude-sonnet-5-5';

/** Looks for a usable login without reading any secret: an API key variable, a credentials file, or a keychain entry. */
export function detectLogin(env: NodeJS.ProcessEnv = process.env): { found: boolean; how: string } {
  if (env.ANTHROPIC_API_KEY) return { found: true, how: 'ANTHROPIC_API_KEY' };
  if (existsSync(join(homedir(), '.claude', '.credentials.json'))) return { found: true, how: 'Claude Code login' };
  if (process.platform === 'darwin') {
    const r = spawnSync('security', ['find-generic-password', '-s', 'Claude Code-credentials'], { stdio: 'ignore' });
    if (r.status === 0) return { found: true, how: 'Claude Code login' };
  }
  return { found: false, how: 'none' };
}

/** Tries the live call first; if it fails, plays the recorded run and says why. */
export class FallbackDrafter implements ParserDrafter {
  readonly mode = 'live' as const;
  constructor(
    private readonly live: ParserDrafter,
    private readonly replay: ReplayDrafter,
  ) {}

  get model(): string {
    return this.live.model;
  }

  async draft(input: DraftInput): Promise<DraftRun> {
    try {
      return await this.live.draft(input);
    } catch (err) {
      const reason = (err as Error).message;
      if (!this.replay.hasRecordingFor(input.body)) throw err;
      const run = await this.replay.draft(input);
      return { ...run, fallbackReason: reason, trace: [{ kind: 'fallback', label: `Live call failed (${reason}); using the recorded run`, atMs: 0 }, ...run.trace] };
    }
  }
}

export interface DrafterChoice {
  drafter: ParserDrafter;
  mode: 'live' | 'replay';
  reason: string;
}

export function chooseDrafter(env: NodeJS.ProcessEnv = process.env): DrafterChoice {
  const replay = new ReplayDrafter();
  if (env.DEMO_REPLAY === '1') return { drafter: replay, mode: 'replay', reason: 'DEMO_REPLAY=1' };
  const login = detectLogin(env);
  if (!login.found) return { drafter: replay, mode: 'replay', reason: 'No Claude login or ANTHROPIC_API_KEY found' };
  const live = new LiveDrafter({ model: env.LLM_MODEL || DEFAULT_MODEL });
  return { drafter: new FallbackDrafter(live, replay), mode: 'live', reason: `Live via ${login.how}` };
}
