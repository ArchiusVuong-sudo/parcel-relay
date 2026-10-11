import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { testTemplate } from '../domain/template.js';
import { TEST_TOOL, TOOL_SERVER } from './prompt.js';
import type { TraceStep } from './types.js';

const fieldShape = {
  tracking_number: z.string().max(80),
  carrier: z.string().max(80),
  buyer_name: z.string().max(120),
  street: z.string().max(160),
  postal_code: z.string().max(20),
  items: z.string().max(200),
};
const patternShape = {
  tracking_number: z.string().max(500),
  carrier: z.string().max(500),
  buyer_name: z.string().max(500),
  street: z.string().max(500),
  postal_code: z.string().max(500),
  items: z.string().max(500),
};

export const testToolInput = {
  fields: z.object(fieldShape).describe('The values you read from the email'),
  flags: z.string().regex(/^[ims]{0,3}$/).describe('Regex flags, from i, m, s'),
  patterns: z.object(patternShape).describe('One regex per field, one capture group each'),
};

/**
 * The only tool the model gets: it runs the app's own guard and template test on the email being parsed.
 * The app re-runs the same test after the call; the model's own claim is never trusted.
 */
export function buildTestToolServer(body: string, trace: TraceStep[], startedAt: number, maxCalls = 3) {
  let calls = 0;
  const testTool = tool(
    TEST_TOOL,
    'Test a draft template on the current email with the guard. Returns, per field, the value it extracted and any guard issues.',
    testToolInput,
    async (args) => {
      calls += 1;
      if (calls > maxCalls) {
        return { content: [{ type: 'text', text: 'Test limit reached. Return your best structured output now.' }], isError: true };
      }
      const result = testTemplate({ flags: args.flags, patterns: args.patterns }, body, args.fields);
      trace.push({
        kind: 'tool_result',
        label: `${TEST_TOOL} #${calls}: ${result.passed ? 'passed' : 'failed'}`,
        atMs: Date.now() - startedAt,
        detail: { passed: result.passed, summary: result.summary },
      });
      const compact = result.fields.map((f) => ({ field: f.field, pass: f.pass, got: f.got, issues: f.issues.map((i) => i.message) }));
      const variants = result.variants.filter((v) => !v.pass).map((v) => ({ carrier: v.carrier, number: v.tracking, got: v.got }));
      return { content: [{ type: 'text', text: JSON.stringify({ passed: result.passed, summary: result.summary, fields: compact, failedCarrierVariants: variants }) }] };
    },
  );
  return createSdkMcpServer({ name: TOOL_SERVER, version: '0.1.0', tools: [testTool] });
}
