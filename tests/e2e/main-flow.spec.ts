import { expect, test, type Page } from '@playwright/test';

const nav = (page: Page, name: string) => page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: new RegExp(`^${name}`) }).click();

/** The whole main flow through the dashboard, in replay mode. */
test('supplier emails become validated, uploaded, delivered tracking', async ({ page }) => {
  const problems: string[] = [];
  page.on('console', (m) => m.type() === 'error' && problems.push(m.text()));
  page.on('pageerror', (e) => problems.push(e.message));

  await page.goto('/#/overview');
  await page.getByRole('button', { name: /Reset demo/ }).click();
  await expect(page.getByText('Demo reset to the seed')).toBeVisible();
  await expect(page.getByText('Replay mode')).toBeVisible();
  await expect(page.getByText('Synthetic data').first()).toBeVisible();
  await page.getByRole('button', { name: 'flaky' }).click();

  // Batch 1: parsed by rule, check digit valid, matched with a score breakdown.
  await page.getByRole('button', { name: /Sync inbox/ }).click();
  await nav(page, 'Inbox');
  await page.getByText('Dispatched: order QH-88120').click();
  await expect(page.getByText('S10 check digit valid')).toBeVisible();
  await expect(page.getByText('rule parsed').first()).toBeVisible();
  await page.getByText('Matched to').click();
  await expect(page.getByRole('heading', { name: 'Match score' })).toBeVisible();
  await expect(page.getByText('Postal code').first()).toBeVisible();
  await page.keyboard.press('Escape');

  // Uploads: a 429 and a timeout, retried; one tracking per order.
  await nav(page, 'Uploads');
  await expect(page.getByText(/#1 429 RATE_LIMITED/)).toBeVisible();
  await expect(page.getByText(/#1 timeout/)).toBeVisible();
  await expect(page.getByText(/#2 (200|201) ok/).first()).toBeVisible({ timeout: 15_000 });

  // Batch 2: held, duplicate, dead letter.
  await page.getByRole('button', { name: /Sync inbox/ }).click();
  await expect(page.getByText('dead letter', { exact: true })).toBeVisible({ timeout: 15_000 });
  await nav(page, 'Inbox');
  await expect(page.getByText('held: check digit mismatch')).toBeVisible();
  await expect(page.getByText('held: carrier not accepted')).toBeVisible();
  await expect(page.getByText('duplicate', { exact: true })).toBeVisible();

  // Review: assign the repeat buyer's shipment.
  await nav(page, 'Review');
  await page.getByRole('button', { name: 'Assign to SO-24042' }).click();
  await expect(page.getByText('Nothing to review')).toBeVisible();

  // Batch 3: the recorded Claude draft, tested, then approved.
  await page.getByRole('button', { name: /Sync inbox/ }).click();
  await nav(page, 'Suppliers');
  await expect(page.getByText('Template test passed')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Recorded run (replay)')).toBeVisible();
  await page.getByRole('button', { name: /Approve template/ }).click();
  await expect(page.getByText('drafted by Claude, approved')).toBeVisible();

  // Batch 4: parsed by rule with zero LLM calls.
  await page.getByRole('button', { name: /Sync inbox/ }).click();
  await nav(page, 'Inbox');
  await page.getByText('A parcel is on its way').first().click();
  await expect(page.getByText('0 LLM calls')).toBeVisible();
  await expect(page.getByText('Matched to')).toBeVisible({ timeout: 15_000 });

  // Two simulated days later: delivered, buyer messages, late risk.
  await nav(page, 'Uploads');
  await expect
    .poll(async () => {
      const { jobs } = (await (await page.request.get('/api/uploads')).json()) as { jobs: { status: string }[] };
      return jobs.length >= 7 && jobs.every((j) => j.status === 'done' || j.status === 'dead');
    }, { timeout: 30_000 })
    .toBe(true);
  await page.getByRole('button', { name: /Advance 1 day/ }).click();
  await expect(page.getByText('Day 1')).toBeVisible();
  await page.getByRole('button', { name: /Advance 1 day/ }).click();
  await expect(page.getByText('Day 2')).toBeVisible();
  await nav(page, 'Messages');
  await expect(page.getByText('7 shipped')).toBeVisible();
  await expect(page.getByText('7 delivered')).toBeVisible();
  await nav(page, 'Overview');
  await expect(page.getByText('28 h overdue')).toBeVisible();

  expect(problems).toEqual([]);
});
