import { describe, expect, it } from 'vitest';
import { applyTemplate, cleanValue, templateSpecSchema, testTemplate, type Fields } from '../../src/server/domain/template.js';
import { loadFixtures } from '../../src/server/fixtures.js';
import { loadRecordings } from '../../src/server/llm/replay.js';

const fx = loadFixtures();
const spec = (name: string) => templateSpecSchema.parse(fx.suppliers.suppliers.find((s) => s.name === name)!.template);
const email = (batch: number, i: number) => fx.mailbox.batches.find((b) => b.batch === batch)!.emails[i]!;

describe('seeded rule templates', () => {
  it('parses the plain text layout', () => {
    const r = applyTemplate(spec('Quillmoor Home'), email(1, 0).body);
    expect(r.missing).toEqual([]);
    expect(r.fields).toEqual({
      tracking_number: 'KP407318267ZZ',
      carrier: 'Kestrelpost',
      buyer_name: 'Maren Holloway',
      street: '14 Larkspur Lane',
      postal_code: '40311',
      items: 'Linen cushion cover x2',
    });
  });
  it('parses the HTML table layout', () => {
    const r = applyTemplate(spec('Ashgrove Outfitters'), email(1, 1).body);
    expect(r.fields).toMatchObject({ tracking_number: '003840217755003120', carrier: 'Tidelane Ground', buyer_name: 'Imara Castellan', street: '88 Gullhaven Rd', postal_code: '40522' });
  });
  it('parses tracking from inside a link', () => {
    const r = applyTemplate(spec('Pellbrook Kitchen'), email(1, 2).body);
    expect(r.fields).toMatchObject({ tracking_number: 'SX702155380463', carrier: 'Swiftmere Express', buyer_name: 'Saoirse Pennick', street: '41 Kiln Street', postal_code: '40714', items: 'Cast iron skillet' });
  });
  it('records where each value sits, for highlighting', () => {
    const body = email(1, 0).body;
    const r = applyTemplate(spec('Quillmoor Home'), body);
    for (const s of r.spans) expect(body.slice(s.start, s.end)).toBe(r.fields[s.field]);
  });
  it('reports missing fields instead of guessing', () => {
    const r = applyTemplate(spec('Quillmoor Home'), 'nothing useful here');
    expect(r.missing).toHaveLength(6);
  });
});

describe('cleanValue', () => {
  it('strips tags, decodes entities and collapses space', () => {
    expect(cleanValue('  <b>Tom &amp; Jo</b>\n ')).toBe('Tom & Jo');
  });
});

describe('testTemplate', () => {
  const rec = loadRecordings()[0]!;
  const body = email(3, 0).body;

  it('passes the recorded draft on the email it was written for', () => {
    expect(testTemplate(rec.output.template, body, rec.output.fields).passed).toBe(true);
  });

  it('the recorded draft generalizes to the supplier second email', () => {
    const r = applyTemplate(rec.output.template, email(4, 0).body);
    expect(r.fields).toEqual({
      tracking_number: 'SX702155391205',
      carrier: 'Swiftmere Express',
      buyer_name: 'Corin Blackwood',
      street: '63 Thistle Way',
      postal_code: '40519',
      items: 'Felt animal mobile',
    });
  });

  it('fails a draft that hardcodes a sample value', () => {
    const bad = { ...rec.output.template, patterns: { ...rec.output.template.patterns, buyer_name: '(Ilse Varga)' } };
    const r = testTemplate(bad, body, rec.output.fields);
    expect(r.passed).toBe(false);
    expect(r.fields.find((f) => f.field === 'buyer_name')!.issues.map((i) => i.rule)).toContain('sample_value');
  });

  it('fails a draft whose pattern extracts the wrong value', () => {
    const bad = { ...rec.output.template, patterns: { ...rec.output.template.patterns, street: 'Postcode\\s*\\.+\\s*([^\\n]+)' } };
    const r = testTemplate(bad, body, rec.output.fields);
    expect(r.passed).toBe(false);
    expect(r.summary).toContain('street');
  });

  it('fails a draft with a nested quantifier', () => {
    const fields: Fields = rec.output.fields;
    const bad = { flags: 'i', patterns: { ...rec.output.template.patterns, items: 'Contents((?:\\s*\\.+)+)' } };
    expect(testTemplate(bad, body, fields).fields.find((f) => f.field === 'items')!.issues.map((i) => i.rule)).toContain('nested_quantifier');
  });
});
