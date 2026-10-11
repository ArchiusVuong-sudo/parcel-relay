/**
 * Drives the whole flow over HTTP with no browser, in replay mode, on a throwaway data folder.
 * Exits 0 only if every step lands as expected.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/server/app.js';
import { ReplayDrafter } from '../src/server/llm/replay.js';

const dataDir = mkdtempSync(join(tmpdir(), 'parcel-relay-smoke-'));
const app = await buildApp({
  dataDir,
  drafter: { drafter: new ReplayDrafter(), mode: 'replay', reason: 'smoke test' },
  serveWeb: false,
  backoff: { baseMs: 200, maxMs: 2000 },
  workerPollMs: 50,
  clientTimeoutMs: 400,
  slowReplyMs: 700,
});
const base = await app.listen(0);

async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${base}/api${path}`, {
    method,
    ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  const json = (await res.json()) as T;
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
  return json;
}

async function until(what: string, check: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

const step = (msg: string) => console.log(`ok - ${msg}`);
const order = (id: string) => api('GET', `/orders/${id}`);
const uploadsSettled = async () => (await api('GET', '/uploads')).jobs.every((j: any) => j.status === 'done' || j.status === 'dead');

try {
  await api('POST', '/reset');
  await api('PUT', '/marketplace/mode', { mode: 'flaky' });
  step('reset, marketplace set to flaky');

  await api('POST', '/sync?wait=1');
  const b1 = await api('GET', '/emails');
  assert.equal(b1.length, 4);
  assert.ok(b1.every((e: any) => e.parseMethod === 'rule' && e.status === 'parsed'));
  await until('batch 1 uploads', uploadsSettled);
  const jobs1 = (await api('GET', '/uploads')).jobs;
  assert.ok(jobs1.some((j: any) => j.history.some((h: any) => h.httpStatus === 429)), 'a 429 was retried');
  assert.ok(jobs1.some((j: any) => j.history.some((h: any) => h.code === 'TIMEOUT')), 'a timeout was retried');
  const mp = (await api('GET', '/uploads')).marketplace;
  assert.ok(mp.orders.every((o: any) => o.trackings === 1), 'one tracking per order');
  step('batch 1: 4 emails parsed by rule, 429 and timeout retried, one tracking per order');

  await api('POST', '/sync?wait=1');
  const all2 = await api('GET', '/emails');
  const reasons = all2.map((e: any) => `${e.status}: ${e.reason ?? ''}`);
  assert.ok(reasons.some((r: string) => r.includes('check digit mismatch')));
  assert.ok(reasons.some((r: string) => r.includes('carrier not accepted')));
  assert.ok(all2.some((e: any) => e.status === 'duplicate'));
  await until('cancelled order dead-lettered', async () => (await order('SO-24039')).order.status === 'cancelled');
  const review = await api('GET', '/review');
  assert.equal(review.length, 1);
  assert.deepEqual(review[0].candidates.slice(0, 2).map((c: any) => c.orderId).sort(), ['SO-24042', 'SO-24044']);
  step('batch 2: held x2, duplicate, cancelled order in dead letter, repeat buyer in review');

  await api('POST', `/review/${review[0].shipmentId}/assign`, { orderId: 'SO-24042' });
  await until('assigned order uploaded', async () => (await order('SO-24042')).order.status === 'uploaded');
  step('review: reviewer assigned SO-24042 and it uploaded');

  await api('POST', '/sync?wait=1');
  const suppliers = await api('GET', '/suppliers');
  const fern = suppliers.find((s: any) => s.sender_domain === 'fernwhistle.example.com');
  assert.equal(fern.status, 'pending_approval');
  assert.equal(fern.templates.at(-1).test_result.passed, true);
  assert.equal((await order('SO-24047')).order.status, 'awaiting_tracking', 'nothing uploads before approval');
  step('batch 3: unknown supplier drafted (recorded run), template test passed, upload waits');

  await api('POST', `/suppliers/${fern.id}/approve`);
  await api('POST', '/sync?wait=1');
  const emails4 = await api('GET', '/emails');
  const second = emails4.find((e: any) => e.batch === 4);
  assert.equal(second.parseMethod, 'rule');
  assert.equal(second.llmCalls, 0);
  await until('fernwhistle orders uploaded', async () => (await order('SO-24047')).order.status === 'uploaded' && (await order('SO-24050')).order.status === 'uploaded');
  step('approved; batch 4 parsed by rule with 0 LLM calls; both orders uploaded');

  await until('uploads settled', uploadsSettled);
  await api('POST', '/clock/advance');
  await api('POST', '/clock/advance');
  const messages = await api('GET', '/messages');
  const delivered = (await api('GET', '/orders')).filter((o: any) => o.status === 'delivered');
  assert.ok(delivered.length >= 7, `delivered: ${delivered.length}`);
  for (const o of delivered) {
    assert.equal(messages.filter((m: any) => m.orderId === o.id && m.kind === 'shipped').length, 1);
    assert.equal(messages.filter((m: any) => m.orderId === o.id && m.kind === 'delivered').length, 1);
  }
  const overview = await api('GET', '/overview');
  assert.ok(overview.lateRisk.some((r: any) => r.orderId === 'SO-24019' && r.hoursOverdue > 0));
  step(`two days later: ${delivered.length} delivered, one shipped and one delivered message each, late-risk flagged`);
  console.log('SMOKE PASSED');
} finally {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
}
