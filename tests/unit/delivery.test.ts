import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { many } from '../../src/server/db/client.js';
import type { AppContext } from '../../src/server/services/context.js';
import { advanceDay, applyDueScans, lateRisk, messageBody, sendBuyerMessage } from '../../src/server/services/delivery.js';
import type { OrderRow } from '../../src/server/services/rows.js';
import { getSetting } from '../../src/server/services/settings.js';
import { testContext } from '../helpers.js';

let ctx: AppContext;
beforeEach(async () => {
  ctx = await testContext();
});
afterEach(async () => {
  await ctx.db.close();
});

async function markUploaded(orderId: string, tracking: string, carrier: string) {
  await ctx.db.query(`UPDATE orders SET status = 'uploaded', tracking_number = $2, carrier_code = $3, uploaded_day = 0 WHERE id = $1`, [orderId, tracking, carrier]);
}

describe('delivery monitor', () => {
  it('moves an uploaded order to in transit after one day and delivered after two', async () => {
    await markUploaded('SO-24017', 'KP407318267ZZ', 'kestrelpost');
    expect(await applyDueScans(ctx)).toBe(0);
    await advanceDay(ctx);
    expect((await many<OrderRow>(ctx.db, `SELECT * FROM orders WHERE id = 'SO-24017'`))[0]!.status).toBe('in_transit');
    await advanceDay(ctx);
    expect((await many<OrderRow>(ctx.db, `SELECT * FROM orders WHERE id = 'SO-24017'`))[0]!.status).toBe('delivered');
    expect(await getSetting(ctx.db, 'offsetDays')).toBe(2);
  });

  it('sends exactly one delivered message however often the monitor runs', async () => {
    await markUploaded('SO-24017', 'KP407318267ZZ', 'kestrelpost');
    await advanceDay(ctx);
    await advanceDay(ctx);
    await applyDueScans(ctx);
    await advanceDay(ctx);
    const msgs = await many<{ kind: string }>(ctx.db, `SELECT kind FROM buyer_messages WHERE order_id = 'SO-24017'`);
    expect(msgs.map((m) => m.kind)).toEqual(['delivered']);
  });

  it('refuses a second message for the same order and stage', async () => {
    const order = (await many<OrderRow>(ctx.db, `SELECT * FROM orders WHERE id = 'SO-24017'`))[0]!;
    expect(await sendBuyerMessage(ctx.db, order, 'shipped', ctx.clock.now())).toBe(true);
    expect(await sendBuyerMessage(ctx.db, order, 'shipped', ctx.clock.now())).toBe(false);
  });

  it('writes plain buyer messages with the carrier name and tracking', () => {
    const body = messageBody({ id: 'SO-1', buyer_name: 'Maren Holloway', carrier_code: 'kestrelpost', tracking_number: 'KP407318267ZZ', items: [{ title: 'Linen cushion cover', qty: 1 }] }, 'shipped');
    expect(body).toBe('Hi Maren, your Linen cushion cover (order SO-1) has shipped with Kestrelpost. Tracking: KP407318267ZZ.');
  });
});

describe('late risk', () => {
  it('flags orders with no tracking near the deadline, then overdue in hours', async () => {
    let risk = await lateRisk(ctx);
    expect(risk.map((r) => r.orderId)).toEqual([]);
    await advanceDay(ctx);
    risk = await lateRisk(ctx);
    expect(risk[0]).toMatchObject({ orderId: 'SO-24019', state: 'overdue', hoursOverdue: 4 });
    await advanceDay(ctx);
    risk = await lateRisk(ctx);
    expect(risk.find((r) => r.orderId === 'SO-24019')?.hoursOverdue).toBe(28);
    expect(risk.find((r) => r.orderId === 'SO-24027')?.hoursOverdue).toBe(8);
  });
  it('drops an order from the list once it has tracking', async () => {
    await advanceDay(ctx);
    await markUploaded('SO-24019', 'KP407318267ZZ', 'kestrelpost');
    expect((await lateRisk(ctx)).map((r) => r.orderId)).not.toContain('SO-24019');
  });
});
