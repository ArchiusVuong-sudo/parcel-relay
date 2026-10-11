import { describe, expect, it } from 'vitest';
import { AUTO_MATCH_LEAD, AUTO_MATCH_MIN, itemSimilarity, matchShipment, nameSimilarity, scoreOrder, streetSimilarity, type OrderFacts, type ShipmentFacts } from '../../src/server/domain/matcher.js';

const day = 24 * 3600_000;
const now = new Date('2026-10-11T10:00:00Z');

function order(id: string, over: Partial<OrderFacts> = {}): OrderFacts {
  return {
    id,
    buyerName: 'Maren Holloway',
    street: '14 Larkspur Lane',
    postalCode: '40311',
    itemTitles: ['Linen cushion cover, oat'],
    placedAt: new Date(now.getTime() - day),
    handlingDeadline: new Date(now.getTime() + 2 * day),
    ...over,
  };
}

const shipment: ShipmentFacts = { buyerName: 'Maren Holloway', street: '14 Larkspur Ln', postalCode: '40311', items: 'Linen cushion cover x2', shippedAt: now };

describe('similarities', () => {
  it('treats street abbreviations as equal', () => {
    expect(streetSimilarity('88 Gullhaven Rd', '88 Gullhaven Road')).toBe(1);
    expect(streetSimilarity('14 Larkspur Ln.', '14 larkspur lane')).toBe(1);
  });
  it('scores names: exact, same surname and initial, partial', () => {
    expect(nameSimilarity('Maren Holloway', 'maren  holloway')).toBe(1);
    expect(nameSimilarity('M. Holloway', 'Maren Holloway')).toBe(0.8);
    expect(nameSimilarity('Odile Pemberton', 'Ruben Okonedo')).toBe(0);
  });
  it('counts the email item words found in the order titles, ignoring quantities', () => {
    expect(itemSimilarity('Linen cushion cover x2', ['Linen cushion cover, oat'])).toBe(1);
    expect(itemSimilarity('Enamel tableware (2 pcs)', ['Enamel mug, set of 2'])).toBe(0.5);
    expect(itemSimilarity('', ['anything'])).toBe(0);
  });
});

describe('scoreOrder', () => {
  it('breaks the score down by criterion and the weights sum to 1', () => {
    const c = scoreOrder(shipment, order('SO-1'));
    expect(c.breakdown.map((b) => b.criterion)).toEqual(['name', 'street', 'postal', 'items', 'date']);
    expect(c.breakdown.reduce((s, b) => s + b.weight, 0)).toBeCloseTo(1);
    expect(c.score).toBe(1);
  });
  it('gives no date points outside the order window', () => {
    const c = scoreOrder({ ...shipment, shippedAt: new Date(now.getTime() - 3 * day) }, order('SO-1'));
    expect(c.breakdown.find((b) => b.criterion === 'date')!.points).toBe(0);
  });
});

describe('matchShipment', () => {
  it('auto-matches a clear winner', () => {
    const d = matchShipment(shipment, [order('SO-1'), order('SO-2', { buyerName: 'Tomas Wexley', street: '3 Orchard Steps', postalCode: '40418', itemTitles: ['Vase'] })]);
    expect(d.kind).toBe('auto');
    if (d.kind === 'auto') {
      expect(d.orderId).toBe('SO-1');
      expect(d.score).toBeGreaterThanOrEqual(AUTO_MATCH_MIN);
      expect(d.lead).toBeGreaterThanOrEqual(AUTO_MATCH_LEAD);
    }
  });
  it('sends a repeat buyer with two similar open orders to review', () => {
    const s = { ...shipment, items: 'Enamel tableware (2 pcs)' };
    const d = matchShipment(s, [order('SO-A', { itemTitles: ['Enamel mug, set of 2'] }), order('SO-B', { itemTitles: ['Enamel pie dish'] })]);
    expect(d).toMatchObject({ kind: 'review', reason: 'tie' });
    expect(d.candidates.map((c) => c.orderId)).toEqual(['SO-A', 'SO-B']);
  });
  it('does not auto-match below the minimum score even when far ahead', () => {
    const s = { ...shipment, street: '1 Other Road', items: 'Garden hose' };
    const d = matchShipment(s, [order('SO-1')]);
    expect(d).toMatchObject({ kind: 'review', reason: 'low_score' });
  });
  it('returns none when nothing is close', () => {
    const d = matchShipment({ buyerName: 'Nobody', street: '9 Nowhere', postalCode: '00000', items: 'thing', shippedAt: new Date(0) }, [order('SO-1')]);
    expect(d.kind).toBe('none');
    expect(d.candidates).toEqual([]);
  });
  it('returns none with no open orders', () => {
    expect(matchShipment(shipment, []).kind).toBe('none');
  });
});
