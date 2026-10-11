import vm from 'node:vm';

/**
 * Guard for regex templates, above all the ones a model drafts.
 * Email text is untrusted, so a pattern must pass static checks before it runs,
 * and every run happens in a fresh vm context with a hard timeout.
 */

export const MAX_PATTERN_LENGTH = 200;
export const MAX_INPUT_LENGTH = 20_000;
export const EXEC_TIMEOUT_MS = 50;
const ALLOWED_FLAGS = new Set(['i', 'm', 's']);

export type GuardRule = 'length' | 'syntax' | 'flags' | 'capture_groups' | 'backreference' | 'nested_quantifier' | 'sample_value';

export interface GuardIssue {
  rule: GuardRule;
  message: string;
}

interface ScanResult {
  captureGroups: number;
  backreference: boolean;
  nestedQuantifier: boolean;
}

/** Reads a quantifier at position i, if any. "repeat" means it can match more than once. */
function readQuantifier(source: string, i: number): { quant: boolean; repeat: boolean; next: number } {
  const c = source[i];
  let q = { quant: false, repeat: false, next: i };
  if (c === '*' || c === '+') q = { quant: true, repeat: true, next: i + 1 };
  else if (c === '?') q = { quant: true, repeat: false, next: i + 1 };
  else if (c === '{') {
    const m = /^\{(\d+)(,(\d*))?\}/.exec(source.slice(i));
    if (m) {
      const max = m[2] === undefined ? Number(m[1]) : m[3] === '' ? Infinity : Number(m[3]);
      q = { quant: true, repeat: max > 1, next: i + m[0].length };
    }
  }
  if (q.quant && source[q.next] === '?') q.next += 1; // lazy modifier
  return q;
}

/** Walks the pattern once, tracking groups, character classes and quantifiers. */
function scan(source: string): ScanResult {
  const frames: { repeats: boolean }[] = [{ repeats: false }];
  const top = () => frames[frames.length - 1]!;
  let captureGroups = 0;
  let backreference = false;
  let nestedQuantifier = false;
  let inClass = false;

  const afterAtom = (i: number): number => {
    const q = readQuantifier(source, i);
    if (q.repeat) top().repeats = true;
    return q.next;
  };

  for (let i = 0; i < source.length; ) {
    const c = source[i]!;
    if (inClass) {
      if (c === '\\') i += 2;
      else if (c === ']') {
        inClass = false;
        i = afterAtom(i + 1);
      } else i += 1;
      continue;
    }
    if (c === '\\') {
      const n = source[i + 1] ?? '';
      if (/[1-9]/.test(n) || (n === 'k' && source[i + 2] === '<')) backreference = true;
      i = afterAtom(i + 2);
      continue;
    }
    if (c === '[') {
      inClass = true;
      i += 1;
      continue;
    }
    if (c === '(') {
      i += 1;
      if (source[i] !== '?') captureGroups += 1;
      else {
        const prefix = /^\?(:|=|!|<=|<!|<[A-Za-z_][A-Za-z0-9_]*>)/.exec(source.slice(i));
        if (prefix && prefix[1]!.startsWith('<') && prefix[1] !== '<=' && prefix[1] !== '<!') captureGroups += 1;
        if (prefix) i += prefix[0].length;
      }
      frames.push({ repeats: false });
      continue;
    }
    if (c === ')') {
      const frame = frames.length > 1 ? frames.pop()! : { repeats: false };
      const q = readQuantifier(source, i + 1);
      if (q.repeat && frame.repeats) nestedQuantifier = true;
      if (q.repeat || frame.repeats) top().repeats = true;
      i = q.next;
      continue;
    }
    if (c === '|' || c === '^' || c === '$') {
      i += 1;
      continue;
    }
    i = afterAtom(i + 1);
  }
  return { captureGroups, backreference, nestedQuantifier };
}

function literalText(source: string): string {
  return source.replace(/\\([^a-zA-Z0-9])/g, '$1').toLowerCase();
}

/** Values long enough to be specific: the whole value and its longer words. */
function sampleNeedles(values: readonly string[]): string[] {
  const needles = new Set<string>();
  for (const v of values) {
    const value = v.trim().toLowerCase();
    if (value.length >= 4) needles.add(value);
    for (const word of value.split(/[^a-z0-9]+/)) if (word.length >= 5 || /^\d{4,}$/.test(word)) needles.add(word);
  }
  return [...needles];
}

export function guardPattern(source: string, flags: string, sampleValues: readonly string[] = []): GuardIssue[] {
  const issues: GuardIssue[] = [];
  if (source.length === 0 || source.length > MAX_PATTERN_LENGTH) {
    issues.push({ rule: 'length', message: `Pattern must be 1-${MAX_PATTERN_LENGTH} characters (got ${source.length})` });
    return issues;
  }
  for (const f of flags) {
    if (!ALLOWED_FLAGS.has(f)) issues.push({ rule: 'flags', message: `Flag "${f}" is not allowed` });
  }
  try {
    new RegExp(source, [...flags].filter((f) => ALLOWED_FLAGS.has(f)).join(''));
  } catch (err) {
    issues.push({ rule: 'syntax', message: `Invalid regex: ${(err as Error).message}` });
    return issues;
  }
  const s = scan(source);
  if (s.captureGroups !== 1) issues.push({ rule: 'capture_groups', message: `Needs exactly one capture group (found ${s.captureGroups})` });
  if (s.backreference) issues.push({ rule: 'backreference', message: 'Backreferences are not allowed' });
  if (s.nestedQuantifier) issues.push({ rule: 'nested_quantifier', message: 'Nested quantifiers are not allowed (ReDoS risk)' });
  const literal = literalText(source);
  const hit = sampleNeedles(sampleValues).find((needle) => literal.includes(needle));
  if (hit) issues.push({ rule: 'sample_value', message: `Pattern hardcodes a value from the sample email ("${hit}")` });
  return issues;
}

export interface ExecMatch {
  value: string;
  start: number;
  end: number;
}

export type ExecOutcome = { ok: true; match: ExecMatch | null } | { ok: false; error: 'timeout' | 'error'; message: string };

/** Runs one pattern on untrusted text in an isolated context with a timeout. */
export function safeExec(source: string, flags: string, text: string, timeoutMs = EXEC_TIMEOUT_MS): ExecOutcome {
  const input = text.slice(0, MAX_INPUT_LENGTH);
  const context = vm.createContext({ source, flags: `${flags}d`, input, out: '' });
  try {
    vm.runInContext(
      `const m = new RegExp(source, flags).exec(input);
       out = m && m[1] !== undefined ? JSON.stringify({ value: m[1], start: m.indices[1][0], end: m.indices[1][1] }) : '';`,
      context,
      { timeout: timeoutMs },
    );
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    if (/timed out/i.test(message)) return { ok: false, error: 'timeout', message: `Regex ran over ${timeoutMs} ms` };
    return { ok: false, error: 'error', message };
  }
  const out = context.out as string;
  return { ok: true, match: out ? (JSON.parse(out) as ExecMatch) : null };
}
