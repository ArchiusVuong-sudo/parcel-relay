import { z } from 'zod';
import { guardPattern, safeExec, type GuardIssue } from './regexGuard.js';

/** The fields a supplier template pulls out of a shipping email. */
export const FIELD_NAMES = ['tracking_number', 'carrier', 'buyer_name', 'street', 'postal_code', 'items'] as const;
export type FieldName = (typeof FIELD_NAMES)[number];
export type Fields = Record<FieldName, string>;

export const patternSchema = z.string().min(1).max(500);

/** A rule template: one regex per field, each with exactly one capture group. */
export const templatePatternsSchema = z.object({
  tracking_number: patternSchema,
  carrier: patternSchema,
  buyer_name: patternSchema,
  street: patternSchema,
  postal_code: patternSchema,
  items: patternSchema,
});
export type TemplatePatterns = z.infer<typeof templatePatternsSchema>;

export const templateSpecSchema = z.object({
  flags: z.string().max(3).default('i'),
  patterns: templatePatternsSchema,
});
export type TemplateSpec = z.infer<typeof templateSpecSchema>;

export interface Span {
  field: FieldName;
  start: number;
  end: number;
}

export interface ExtractResult {
  fields: Partial<Fields>;
  spans: Span[];
  missing: FieldName[];
  errors: { field: FieldName; message: string }[];
}

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };

export function cleanValue(raw: string): string {
  return raw
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (e) => ENTITIES[e] ?? e)
    .replace(/\s+/g, ' ')
    .trim();
}

/** Runs every field pattern on the email body through the guarded executor. */
export function applyTemplate(spec: TemplateSpec, body: string): ExtractResult {
  const result: ExtractResult = { fields: {}, spans: [], missing: [], errors: [] };
  for (const field of FIELD_NAMES) {
    const outcome = safeExec(spec.patterns[field], spec.flags, body);
    if (!outcome.ok) {
      result.errors.push({ field, message: outcome.message });
      result.missing.push(field);
    } else if (!outcome.match || cleanValue(outcome.match.value) === '') {
      result.missing.push(field);
    } else {
      result.fields[field] = cleanValue(outcome.match.value);
      result.spans.push({ field, start: outcome.match.start, end: outcome.match.end });
    }
  }
  return result;
}

export interface FieldTest {
  field: FieldName;
  expected: string;
  got: string | null;
  pass: boolean;
  issues: GuardIssue[];
}

export interface TemplateTest {
  passed: boolean;
  fields: FieldTest[];
  summary: string;
}

export function sameValue(a: string, b: string): boolean {
  const norm = (s: string) => cleanValue(s).toLowerCase().replace(/[\s,.;:]+$/g, '');
  return norm(a) === norm(b);
}

/**
 * Tests a template against a sample email and the values a reader (or a model) found in it.
 * Every pattern must pass the guard, and must extract the expected value.
 * The carrier name is exempt from the sample-value rule: carriers are a closed list.
 */
export function testTemplate(spec: TemplateSpec, body: string, expected: Fields): TemplateTest {
  const extracted = applyTemplate(spec, body);
  const fields: FieldTest[] = FIELD_NAMES.map((field) => {
    const sampleValues = FIELD_NAMES.filter((f) => f !== 'carrier').map((f) => expected[f]);
    const issues = guardPattern(spec.patterns[field], spec.flags, sampleValues);
    const got = extracted.fields[field] ?? null;
    const execError = extracted.errors.find((e) => e.field === field);
    if (execError) issues.push({ rule: 'syntax', message: execError.message });
    const pass = issues.length === 0 && got !== null && sameValue(got, expected[field]);
    return { field, expected: expected[field], got, pass, issues };
  });
  const failed = fields.filter((f) => !f.pass);
  return {
    passed: failed.length === 0,
    fields,
    summary: failed.length === 0 ? `All ${fields.length} fields extracted and guard checks passed` : `${failed.length} of ${fields.length} fields failed: ${failed.map((f) => f.field).join(', ')}`,
  };
}
