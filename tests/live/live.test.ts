import { describe, expect, it } from 'vitest';
import { applyTemplate, testTemplate } from '../../src/server/domain/template.js';
import { loadFixtures } from '../../src/server/fixtures.js';
import { LiveDrafter } from '../../src/server/llm/live.js';
import { DEFAULT_MODEL } from '../../src/server/llm/select.js';

/** Opt-in: makes one real Agent SDK call. Run with LIVE=1 (npm run test:live). */
describe.skipIf(process.env.LIVE !== '1')('live drafter (LIVE=1)', () => {
  it('drafts a template for the unknown supplier that passes the app test', async () => {
    const mailbox = loadFixtures().mailbox;
    const email = mailbox.batches.find((b) => b.batch === 3)!.emails[0]!;
    const second = mailbox.batches.find((b) => b.batch === 4)!.emails[0]!;
    const run = await new LiveDrafter({ model: process.env.LLM_MODEL || DEFAULT_MODEL }).draft({
      supplierName: email.fromName,
      senderDomain: 'fernwhistle.example.com',
      subject: email.subject,
      body: email.body,
      contentType: email.contentType,
    });
    expect(run.mode).toBe('live');
    expect(run.output.fields.tracking_number).toBe('KP512093445ZZ');
    expect(testTemplate(run.output.template, email.body, run.output.fields).passed).toBe(true);
    expect(run.trace.some((s) => s.kind === 'tool_call')).toBe(true);
    // The supplier's next email uses another carrier; the drafted rule must still parse it.
    expect(applyTemplate(run.output.template, second.body).fields).toMatchObject({ tracking_number: 'SX702155391205', carrier: 'Swiftmere Express', buyer_name: 'Corin Blackwood' });
  }, 180_000);
});
