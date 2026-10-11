import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ReplayDrafter } from '../../src/server/llm/replay.js';
import type { DraftInput, DraftRun, ParserDrafter } from '../../src/server/llm/types.js';
import { CountingDrafter, startApp, until, type RunningApp } from '../helpers.js';

/** The main flow end to end over HTTP, in replay mode, with no network beyond 127.0.0.1. */
describe('main flow (replay mode)', () => {
  let t: RunningApp;
  let drafter: CountingDrafter;
  beforeEach(async () => {
    drafter = new CountingDrafter();
    t = await startApp(drafter);
  });
  afterEach(async () => {
    await t.close();
  });

  const order = async (id: string) => (await t.api('GET', `/orders/${id}`)).body;
  const settled = async () => (await t.api('GET', '/uploads')).body.jobs.every((j: any) => j.status === 'done' || j.status === 'dead');

  it('runs inbox to delivered: rule parsing, holds, dedupe, retries, review, new supplier, delivery', async () => {
    expect((await t.api('PUT', '/marketplace/mode', { mode: 'flaky' })).status).toBe(200);

    // Batch 1: known suppliers, parsed by rule; flaky marketplace.
    expect((await t.api('POST', '/sync?wait=1')).status).toBe(200);
    let emails = (await t.api('GET', '/emails')).body;
    expect(emails).toHaveLength(4);
    expect(emails.every((e: any) => e.status === 'parsed' && e.parseMethod === 'rule' && e.llmCalls === 0 && e.check.ok)).toBe(true);
    await until('batch 1 uploads', settled);
    const uploads = (await t.api('GET', '/uploads')).body;
    const history = uploads.jobs.flatMap((j: any) => j.history);
    expect(history.filter((h: any) => h.httpStatus === 429)).toHaveLength(1);
    expect(history.filter((h: any) => h.code === 'TIMEOUT')).toHaveLength(1);
    expect(uploads.marketplace.orders.map((o: any) => o.trackings)).toEqual([1, 1, 1, 1]);
    const timeline = (await order('SO-24021')).events.map((e: any) => e.kind);
    expect(timeline).toEqual(expect.arrayContaining(['tracking_found', 'matched', 'upload_queued', 'upload_retry', 'uploaded', 'buyer_message']));
    const drawer = await order('SO-24017');
    expect(drawer.match.candidate.breakdown.map((b: any) => b.criterion)).toEqual(['name', 'street', 'postal', 'items', 'date']);
    expect(drawer.marketplace.trackings).toBe(1);

    // Batch 2: edge cases.
    await t.api('POST', '/sync?wait=1');
    emails = (await t.api('GET', '/emails')).body.filter((e: any) => e.batch === 2);
    const byStatus = (s: string) => emails.filter((e: any) => e.status === s);
    expect(byStatus('held').map((e: any) => e.reason.split('.')[0]).sort()).toEqual(['held: carrier not accepted', 'held: check digit mismatch']);
    expect(byStatus('duplicate')).toHaveLength(1);
    await until('cancelled order dead-lettered', async () => (await order('SO-24039')).order.status === 'cancelled');
    const dead = (await t.api('GET', '/uploads')).body.jobs.find((j: any) => j.orderId === 'SO-24039');
    expect(dead).toMatchObject({ status: 'dead', attempts: 1 });
    expect((await order('SO-24033')).order.status).toBe('awaiting_tracking');

    // Review: one buyer, two open orders.
    const review = (await t.api('GET', '/review')).body;
    expect(review).toHaveLength(1);
    expect(review[0].reason).toBe('tie');
    expect((await t.api('POST', `/review/${review[0].shipmentId}/assign`, { orderId: 'SO-24023' })).status).toBe(409);
    expect((await t.api('POST', `/review/${review[0].shipmentId}/assign`, { orderId: 'SO-24042' })).status).toBe(200);
    expect((await t.api('POST', `/review/${review[0].shipmentId}/assign`, { orderId: 'SO-24044' })).status).toBe(409);
    await until('assigned order uploaded', async () => (await order('SO-24042')).order.status === 'uploaded');
    expect((await order('SO-24042')).events.map((e: any) => e.kind)).toContain('assigned');
    expect((await order('SO-24044')).events.map((e: any) => e.kind)).toContain('review_resolved');

    // Batch 3: unknown supplier, one drafter call, nothing uploads before approval.
    await t.api('POST', '/sync?wait=1');
    expect(drafter.calls).toBe(1);
    let suppliers = (await t.api('GET', '/suppliers')).body;
    const fern = suppliers.find((s: any) => s.sender_domain === 'fernwhistle.example.com');
    expect(fern.status).toBe('pending_approval');
    expect(fern.templates[0]).toMatchObject({ status: 'draft', source: 'llm' });
    expect(fern.templates[0].test_result.passed).toBe(true);
    expect(fern.runs[0]).toMatchObject({ mode: 'replay', ok: true });
    expect((await order('SO-24047')).order.status).toBe('awaiting_tracking');
    expect((await t.api('GET', '/uploads')).body.jobs.some((j: any) => j.orderId === 'SO-24047')).toBe(false);

    // Approve, then batch 4 is parsed by rule with no LLM call.
    expect((await t.api('POST', `/suppliers/${fern.id}/approve`)).status).toBe(200);
    await t.api('POST', '/sync?wait=1');
    expect(drafter.calls).toBe(1);
    const second = (await t.api('GET', '/emails')).body.find((e: any) => e.batch === 4);
    expect(second).toMatchObject({ parseMethod: 'rule', llmCalls: 0, status: 'parsed', orderId: 'SO-24050' });
    await until('new supplier orders uploaded', async () => (await order('SO-24047')).order.status === 'uploaded' && (await order('SO-24050')).order.status === 'uploaded');
    suppliers = (await t.api('GET', '/suppliers')).body;
    expect(suppliers.find((s: any) => s.id === fern.id).stats).toMatchObject({ emails: 2, rule: 1, llm_calls: 1 });

    // Two simulated days: delivered, one message per stage, late risk.
    await until('uploads settled', settled);
    await t.api('POST', '/clock/advance');
    expect((await order('SO-24017')).order.status).toBe('in_transit');
    await t.api('POST', '/clock/advance');
    const orders = (await t.api('GET', '/orders')).body;
    const delivered = orders.filter((o: any) => o.status === 'delivered').map((o: any) => o.id).sort();
    expect(delivered).toEqual(['SO-24017', 'SO-24021', 'SO-24025', 'SO-24030', 'SO-24042', 'SO-24047', 'SO-24050']);
    const messages = (await t.api('GET', '/messages')).body;
    expect(messages).toHaveLength(14);
    for (const id of delivered) expect(messages.filter((m: any) => m.orderId === id).map((m: any) => m.kind).sort()).toEqual(['delivered', 'shipped']);
    const overview = (await t.api('GET', '/overview')).body;
    expect(overview.lateRisk.find((r: any) => r.orderId === 'SO-24019')).toMatchObject({ state: 'overdue', hoursOverdue: 28 });
    expect(overview.tiles).toMatchObject({ delivered: 7, held: 2, dead_letter: 1, emails_total: 11, rule_parsed: 10, llm_calls: 1, buyer_messages: 14 });

    // The mailbox is empty now.
    expect((await t.api('POST', '/sync')).status).toBe(409);
  }, 60_000);

  it('holds an email from a supplier whose draft waits for approval, with no extra LLM call', async () => {
    for (let i = 0; i < 4; i++) await t.api('POST', '/sync?wait=1');
    expect(drafter.calls).toBe(1);
    const second = (await t.api('GET', '/emails')).body.find((e: any) => e.batch === 4);
    expect(second).toMatchObject({ status: 'waiting_approval', llmCalls: 0 });
    const fern = (await t.api('GET', '/suppliers')).body.find((s: any) => s.status === 'pending_approval');
    await t.api('POST', `/suppliers/${fern.id}/approve`);
    const after = (await t.api('GET', '/emails')).body.find((e: any) => e.batch === 4);
    expect(after).toMatchObject({ status: 'parsed', parseMethod: 'rule', llmCalls: 0 });
    expect(drafter.calls).toBe(1);
  }, 30_000);

  it('reset restores the seed: clock, marketplace mode, queue and mailbox', async () => {
    await t.api('PUT', '/marketplace/mode', { mode: 'flaky' });
    await t.api('POST', '/sync?wait=1');
    await t.api('POST', '/clock/advance');
    expect((await t.api('POST', '/reset')).status).toBe(200);
    const meta = (await t.api('GET', '/meta')).body;
    expect(meta).toMatchObject({ marketplaceMode: 'normal', sim: { day: 0 }, inbox: { nextBatch: 1 } });
    expect((await t.api('GET', '/emails')).body).toEqual([]);
    expect((await t.api('GET', '/uploads')).body.jobs).toEqual([]);
    expect((await t.api('GET', '/overview')).body.tiles.awaiting_tracking).toBe(24);
  });

  it('validates input and answers 404 for unknown records', async () => {
    expect((await t.api('PUT', '/marketplace/mode', { mode: 'chaos' })).status).toBe(400);
    expect((await t.api('GET', '/orders/SO-99999')).status).toBe(404);
    expect((await t.api('GET', '/orders/not-an-id')).status).toBe(400);
    expect((await t.api('POST', '/review/999/assign', { orderId: 'SO-24017' })).status).toBe(404);
  });
});

describe('template approval guard', () => {
  it('blocks approval of a draft that failed its test, and rejecting drops the waiting shipment', async () => {
    const replay = new ReplayDrafter();
    const broken: ParserDrafter = {
      mode: 'replay',
      model: 'recorded',
      async draft(input: DraftInput): Promise<DraftRun> {
        const run = await replay.draft(input);
        return { ...run, output: { ...run.output, template: { ...run.output.template, patterns: { ...run.output.template.patterns, buyer_name: '(Ilse Varga)' } } } };
      },
    };
    const t = await startApp(broken);
    try {
      for (let i = 0; i < 3; i++) await t.api('POST', '/sync?wait=1');
      const fern = (await t.api('GET', '/suppliers')).body.find((s: any) => s.status === 'pending_approval');
      expect(fern.templates[0].test_result.passed).toBe(false);
      const res = await t.api('POST', `/suppliers/${fern.id}/approve`);
      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/failed its template test/);
      expect((await t.api('POST', `/suppliers/${fern.id}/reject`)).status).toBe(200);
      const email = (await t.api('GET', '/emails')).body.find((e: any) => e.batch === 3);
      expect(email.status).toBe('failed');
      expect((await t.api('GET', '/uploads')).body.jobs.some((j: any) => j.orderId === 'SO-24047')).toBe(false);
    } finally {
      await t.close();
    }
  });
});
