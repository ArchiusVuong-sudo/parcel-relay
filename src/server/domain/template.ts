import { z } from 'zod';
import { CARRIERS } from './carriers.js';
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

export interface VariantTest {
  carrier: string;
  tracking: string;
  pass: boolean;
  got: { tracking_number: string | null; carrier: string | null };
}

export interface TemplateTest {
  passed: boolean;
  fields: FieldTest[];
  /** The same email with each known carrier's name and number swapped in. */
  variants: VariantTest[];
  summary: string;
}

export function sameValue(a: string, b: string): boolean {
  const norm = (s: string) => cleanValue(s).toLowerCase().replace(/[\s,.;:]+$/g, '');
  return norm(a) === norm(b);
}

/**
 * A supplier can ship with any carrier, so a template must not be tied to the format of
 * the one number in its sample. Swap in each known carrier's name and example number and check both still come out.
 */
export function carrierVariants(spec: TemplateSpec, body: string, expected: Fields): VariantTest[] {
  if (!expected.tracking_number || !body.includes(expected.tracking_number)) return [];
  return CARRIERS.map((c) => {
    let variant = body.split(expected.tracking_number).join(c.example);
    if (expected.carrier && body.includes(expected.carrier)) variant = variant.split(expected.carrier).join(c.name);
    const r = applyTemplate(spec, variant);
    const got = { tracking_number: r.fields.tracking_number ?? null, carrier: r.fields.carrier ?? null };
    const carrierOk = !body.includes(expected.carrier) || (got.carrier !== null && sameValue(got.carrier, c.name));
    return { carrier: c.name, tracking: c.example, pass: got.tracking_number !== null && sameValue(got.tracking_number, c.example) && carrierOk, got };
  });
}

/**
 * Tests a template against a sample email and the values a reader (or a model) found in it.
 * Every pattern must pass the guard and extract the expected value, and the template must
 * still work when the email names another carrier.
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
  const variants = carrierVariants(spec, body, expected);
  const failed = fields.filter((f) => !f.pass);
  const badVariants = variants.filter((v) => !v.pass);
  const problems = [
    ...(failed.length ? [`${failed.length} of ${fields.length} fields failed: ${failed.map((f) => f.field).join(', ')}`] : []),
    ...(badVariants.length ? [`tracking or carrier not found when the email names ${badVariants.map((v) => v.carrier).join(', ')}`] : []),
  ];
  return {
    passed: problems.length === 0,
    fields,
    variants,
    summary: problems.length === 0 ? `All ${fields.length} fields extracted, guard checks passed, and ${variants.length} carrier variants parsed` : problems.join('; '),
  };
}
