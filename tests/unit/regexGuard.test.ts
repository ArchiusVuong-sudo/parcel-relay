import { describe, expect, it } from 'vitest';
import { guardPattern, safeExec } from '../../src/server/domain/regexGuard.js';

const rules = (source: string, flags = 'i', samples: string[] = []) => guardPattern(source, flags, samples).map((i) => i.rule);

describe('guardPattern', () => {
  it('passes a plain labelled pattern', () => {
    expect(rules('Tracking number:\\s*([A-Z0-9]+)')).toEqual([]);
  });
  it('caps the length', () => {
    expect(rules(`(${'a'.repeat(250)})`)).toEqual(['length']);
    expect(rules('')).toEqual(['length']);
  });
  it('allows only i, m and s flags', () => {
    expect(rules('(a)', 'g')).toContain('flags');
    expect(rules('(a)', 'ims')).toEqual([]);
  });
  it('reports invalid syntax', () => {
    expect(rules('(a')).toEqual(['syntax']);
  });
  it('needs exactly one capture group', () => {
    expect(rules('abc')).toContain('capture_groups');
    expect(rules('(a)(b)')).toContain('capture_groups');
    expect(rules('(?:a)(b)')).toEqual([]);
    expect(rules('(?<v>b)')).toEqual([]);
    expect(rules('(?<=x)(b)')).toEqual([]);
    expect(rules('[(](b)')).toEqual([]);
  });
  it('rejects backreferences', () => {
    expect(rules('(a)\\1')).toContain('backreference');
    expect(rules('(?<v>a)\\k<v>')).toContain('backreference');
  });
  it('rejects nested quantifiers', () => {
    expect(rules('((a+)+)')).toContain('nested_quantifier');
    expect(rules('(\\w*)*')).toContain('nested_quantifier');
    expect(rules('(?:\\w+\\s?)*(x)')).toContain('nested_quantifier');
    expect(rules('((?:ab{2,})+)')).toContain('nested_quantifier');
  });
  it('allows a single quantified group and quantified classes', () => {
    expect(rules('([a-z]+)')).toEqual([]);
    expect(rules('(\\d{5})')).toEqual([]);
    expect(rules('((?:ab)+)')).toEqual([]);
    expect(rules('Deliver to:[^\\n]*?(\\d{5})')).toEqual([]);
    expect(rules('((?:a?)+)')).toEqual([]);
  });
  it('rejects values copied from the sample email', () => {
    expect(rules('Ship to (Ilse Varga)', 'i', ['Ilse Varga'])).toContain('sample_value');
    expect(rules('Tracking ref \\. (KP512093445ZZ)', 'i', ['KP512093445ZZ'])).toContain('sample_value');
    expect(rules('Postcode\\s+40517 (\\w+)', 'i', ['40517'])).toContain('sample_value');
    expect(rules('Address\\s*\\.+\\s*([^\\n]+)', 'i', ['7 Copperbeech Row', 'Ilse Varga'])).toEqual([]);
  });
});

describe('safeExec', () => {
  it('returns the capture and its position', () => {
    const r = safeExec('Code: (\\d+)', 'i', 'xx code: 4711 yy');
    expect(r).toEqual({ ok: true, match: { value: '4711', start: 9, end: 13 } });
  });
  it('returns null when nothing matches', () => {
    expect(safeExec('Code: (\\d+)', '', 'none')).toEqual({ ok: true, match: null });
  });
  it('stops catastrophic backtracking with the vm timeout', () => {
    const started = Date.now();
    const r = safeExec('^(a|a)*b', '', `${'a'.repeat(40)}!`, 50);
    expect(r).toMatchObject({ ok: false, error: 'timeout' });
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
