/**
 * Scores a parsed shipment against open orders.
 * Auto-match only when the best score is high and clearly ahead; everything else goes to a person.
 */

export const WEIGHTS = { name: 0.3, street: 0.25, postal: 0.2, items: 0.15, date: 0.1 } as const;
export const AUTO_MATCH_MIN = 0.85;
export const AUTO_MATCH_LEAD = 0.1;
export const REVIEW_MIN = 0.4;
/** Orders scoring below this are not worth showing as candidates. */
export const CANDIDATE_MIN = 0.3;
/** Ship date may trail the handling deadline by this much and still count. */
const DATE_GRACE_MS = 48 * 3600_000;

export type Criterion = keyof typeof WEIGHTS;

export interface ShipmentFacts {
  buyerName: string;
  street: string;
  postalCode: string;
  items: string;
  shippedAt: Date;
}

export interface OrderFacts {
  id: string;
  buyerName: string;
  street: string;
  postalCode: string;
  itemTitles: string[];
  placedAt: Date;
  handlingDeadline: Date;
}

export interface Breakdown {
  criterion: Criterion;
  weight: number;
  similarity: number;
  points: number;
  note: string;
}

export interface Candidate {
  orderId: string;
  score: number;
  breakdown: Breakdown[];
}

export type MatchDecision =
  | { kind: 'auto'; orderId: string; score: number; lead: number; candidates: Candidate[] }
  | { kind: 'review'; reason: 'tie' | 'low_score'; candidates: Candidate[] }
  | { kind: 'none'; candidates: Candidate[] };

const STOPWORDS = new Set(['a', 'an', 'and', 'the', 'of', 'for', 'with', 'set', 'pcs', 'pc', 'x', 'in', 'to', 'item', 'items', 'piece', 'pieces']);
const STREET_ABBR: Record<string, string> = { st: 'street', rd: 'road', ave: 'avenue', av: 'avenue', ln: 'lane', dr: 'drive', ct: 'court', pl: 'place', sq: 'square', blvd: 'boulevard' };

export function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function jaccard(a: string[], b: string[]): number {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 && sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter += 1;
  return inter / (sa.size + sb.size - inter);
}

export function nameSimilarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.join(' ') === tb.join(' ')) return 1;
  const lastA = ta.at(-1);
  const lastB = tb.at(-1);
  if (lastA && lastA === lastB && ta[0]?.[0] === tb[0]?.[0]) return 0.8;
  return jaccard(ta, tb);
}

export function normalizeStreet(s: string): string[] {
  return tokens(s).map((t) => STREET_ABBR[t] ?? t);
}

export function streetSimilarity(a: string, b: string): number {
  const ta = normalizeStreet(a);
  const tb = normalizeStreet(b);
  if (ta.join(' ') === tb.join(' ')) return 1;
  return jaccard(ta, tb);
}

export function itemWords(text: string): string[] {
  return tokens(text).filter((t) => !STOPWORDS.has(t) && !/^\d+$/.test(t));
}

/** Share of the email's item words found in the order's item titles. */
export function itemSimilarity(emailItems: string, orderTitles: string[]): number {
  const words = [...new Set(itemWords(emailItems))];
  if (words.length === 0) return 0;
  const orderWords = new Set(orderTitles.flatMap(itemWords));
  return words.filter((w) => orderWords.has(w)).length / words.length;
}

function round(n: number, places = 2): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

export function scoreOrder(s: ShipmentFacts, o: OrderFacts): Candidate {
  const name = nameSimilarity(s.buyerName, o.buyerName);
  const street = streetSimilarity(s.street, o.street);
  const postal = s.postalCode.replace(/\D/g, '') === o.postalCode ? 1 : 0;
  const items = itemSimilarity(s.items, o.itemTitles);
  const inWindow = s.shippedAt >= o.placedAt && s.shippedAt.getTime() <= o.handlingDeadline.getTime() + DATE_GRACE_MS;
  const date = inWindow ? 1 : 0;
  const parts: [Criterion, number, string][] = [
    ['name', name, name === 1 ? 'exact' : name > 0 ? 'partial' : 'no match'],
    ['street', street, street === 1 ? 'exact' : street > 0 ? 'partial' : 'no match'],
    ['postal', postal, postal === 1 ? 'same postal code' : 'different postal code'],
    ['items', items, `${Math.round(items * 100)}% of item words found`],
    ['date', date, inWindow ? 'within order window' : 'outside order window'],
  ];
  const breakdown = parts.map(([criterion, similarity, note]) => ({
    criterion,
    weight: WEIGHTS[criterion],
    similarity: round(similarity),
    points: round(similarity * WEIGHTS[criterion], 3),
    note,
  }));
  const score = round(breakdown.reduce((sum, b) => sum + b.points, 0), 3);
  return { orderId: o.id, score, breakdown };
}

export function matchShipment(s: ShipmentFacts, openOrders: OrderFacts[], limit = 3): MatchDecision {
  const ranked = openOrders.map((o) => scoreOrder(s, o)).sort((a, b) => b.score - a.score || a.orderId.localeCompare(b.orderId));
  const candidates = ranked.filter((c) => c.score >= CANDIDATE_MIN).slice(0, limit);
  const top = ranked[0];
  if (!top || top.score < REVIEW_MIN) return { kind: 'none', candidates };
  const second = ranked[1]?.score ?? 0;
  const lead = round(top.score - second, 3);
  if (top.score >= AUTO_MATCH_MIN && lead >= AUTO_MATCH_LEAD) return { kind: 'auto', orderId: top.orderId, score: top.score, lead, candidates };
  return { kind: 'review', reason: top.score >= AUTO_MATCH_MIN ? 'tie' : 'low_score', candidates };
}
