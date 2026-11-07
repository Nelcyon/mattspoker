// Cards are two-character strings: rank then suit, e.g. "As", "Td", "9c".
export type Card = string;

export const RANKS = '23456789TJQKA';
export const SUITS = 'cdhs';

export function rankOf(card: Card): number {
  return RANKS.indexOf(card[0]) + 2; // 2..14
}

export function suitOf(card: Card): string {
  return card[1];
}

export function fullDeck(): Card[] {
  const deck: Card[] = [];
  for (const s of SUITS) for (const r of RANKS) deck.push(r + s);
  return deck;
}

/** Unbiased random integer in [0, n) using the platform's cryptographic random source. */
export function randomInt(n: number): number {
  const buf = new Uint32Array(1);
  const limit = Math.floor(0x100000000 / n) * n;
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % n;
  }
}

export function shuffledDeck(rand: (n: number) => number = randomInt): Card[] {
  const deck = fullDeck();
  for (let i = deck.length - 1; i > 0; i--) {
    const j = rand(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

// ---------- Hand evaluation ----------

export const CATEGORY_NAMES = [
  'High card',
  'Pair',
  'Two pair',
  'Three of a kind',
  'Straight',
  'Flush',
  'Full house',
  'Four of a kind',
  'Straight flush',
] as const;

export interface HandValue {
  /** 0 = high card ... 8 = straight flush */
  category: number;
  /** Comparison key: category followed by tiebreak ranks. Compare lexicographically. */
  key: number[];
  /** The five cards that make the hand. */
  best: Card[];
  /** Plain-language name, e.g. "Full house, kings full of threes". */
  name: string;
}

const RANK_WORD: Record<number, [string, string]> = {
  2: ['two', 'twos'],
  3: ['three', 'threes'],
  4: ['four', 'fours'],
  5: ['five', 'fives'],
  6: ['six', 'sixes'],
  7: ['seven', 'sevens'],
  8: ['eight', 'eights'],
  9: ['nine', 'nines'],
  10: ['ten', 'tens'],
  11: ['jack', 'jacks'],
  12: ['queen', 'queens'],
  13: ['king', 'kings'],
  14: ['ace', 'aces'],
};
const one = (r: number) => RANK_WORD[r][0];
const many = (r: number) => RANK_WORD[r][1];
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

export function compareKeys(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Highest straight top rank in a set of distinct ranks (ace can play low), or 0. */
function straightTop(ranks: Set<number>): number {
  for (let top = 14; top >= 5; top--) {
    let ok = true;
    for (let k = 0; k < 5; k++) {
      const r = top - k === 1 ? 14 : top - k;
      if (!ranks.has(r)) {
        ok = false;
        break;
      }
    }
    if (ok) return top;
  }
  return 0;
}

function straightCards(cards: Card[], top: number): Card[] {
  const out: Card[] = [];
  for (let k = 0; k < 5; k++) {
    const r = top - k === 1 ? 14 : top - k;
    out.push(cards.find((c) => rankOf(c) === r)!);
  }
  return out;
}

/** Evaluates the best five-card hand from 5 to 7 cards. */
export function evaluate(cards: Card[]): HandValue {
  const sorted = [...cards].sort((a, b) => rankOf(b) - rankOf(a));

  // Flush / straight flush
  const bySuit = new Map<string, Card[]>();
  for (const c of sorted) {
    const s = suitOf(c);
    if (!bySuit.has(s)) bySuit.set(s, []);
    bySuit.get(s)!.push(c);
  }
  let flush: Card[] | null = null;
  for (const group of bySuit.values()) if (group.length >= 5) flush = group;
  if (flush) {
    const top = straightTop(new Set(flush.map(rankOf)));
    if (top) {
      const best = straightCards(flush, top);
      const name = top === 14 ? 'Royal flush' : `Straight flush, ${one(top)} high`;
      return { category: 8, key: [8, top], best, name };
    }
  }

  // Group by rank
  const byRank = new Map<number, Card[]>();
  for (const c of sorted) {
    const r = rankOf(c);
    if (!byRank.has(r)) byRank.set(r, []);
    byRank.get(r)!.push(c);
  }
  // Groups sorted by size desc then rank desc
  const groups = [...byRank.entries()].sort((a, b) => b[1].length - a[1].length || b[0] - a[0]);
  const kickers = (exclude: number[], n: number) =>
    sorted.filter((c) => !exclude.includes(rankOf(c))).slice(0, n);

  if (groups[0][1].length === 4) {
    const q = groups[0][0];
    const k = kickers([q], 1);
    return { category: 7, key: [7, q, rankOf(k[0])], best: [...groups[0][1], ...k], name: `Four of a kind, ${many(q)}` };
  }

  const trips = groups.filter((g) => g[1].length === 3).map((g) => g[0]);
  const pairs = groups.filter((g) => g[1].length === 2).map((g) => g[0]);
  if (trips.length && (trips.length > 1 || pairs.length)) {
    const t = trips[0];
    const p = Math.max(trips[1] ?? 0, pairs[0] ?? 0);
    const best = [...byRank.get(t)!, ...byRank.get(p)!.slice(0, 2)];
    return { category: 6, key: [6, t, p], best, name: `Full house, ${many(t)} full of ${many(p)}` };
  }

  if (flush) {
    const best = flush.slice(0, 5);
    return { category: 5, key: [5, ...best.map(rankOf)], best, name: `Flush, ${one(rankOf(best[0]))} high` };
  }

  const top = straightTop(new Set(byRank.keys()));
  if (top) {
    return { category: 4, key: [4, top], best: straightCards(sorted, top), name: `Straight, ${one(top)} high` };
  }

  if (trips.length) {
    const t = trips[0];
    const k = kickers([t], 2);
    return { category: 3, key: [3, t, ...k.map(rankOf)], best: [...byRank.get(t)!, ...k], name: `Three of a kind, ${many(t)}` };
  }

  if (pairs.length >= 2) {
    const [a, b] = pairs;
    const k = kickers([a, b], 1);
    return {
      category: 2,
      key: [2, a, b, rankOf(k[0])],
      best: [...byRank.get(a)!, ...byRank.get(b)!, ...k],
      name: `Two pair, ${many(a)} and ${many(b)}`,
    };
  }

  if (pairs.length === 1) {
    const p = pairs[0];
    const k = kickers([p], 3);
    return { category: 1, key: [1, p, ...k.map(rankOf)], best: [...byRank.get(p)!, ...k], name: `Pair of ${many(p)}` };
  }

  const best = sorted.slice(0, 5);
  return { category: 0, key: [0, ...best.map(rankOf)], best, name: `${cap(one(rankOf(best[0])))} high` };
}
