// No-limit Texas Hold'em rules for one hand. Pure functions over a plain, serialisable object,
// so a hand can be saved after every action and picked up again after a server restart.
import { type Card, compareKeys, evaluate, shuffledDeck } from './cards.ts';

export type Street = 'preflop' | 'flop' | 'turn' | 'river';

export interface HandSeat {
  pid: string;
  seat: number;
  /** Chips still behind (not yet put in). */
  stack: number;
  /** Chips put in on the current street. */
  committed: number;
  /** Chips put in over the whole hand. */
  total: number;
  cards: Card[];
  folded: boolean;
  allIn: boolean;
  /** Has acted since the last full bet or raise (so may not re-raise an incomplete raise). */
  acted: boolean;
  /** Last thing this player did this street, for display. */
  lastAction: string | null;
}

export interface PotResult {
  amount: number;
  /** Seat indexes (into hand.seats) that could win this pot. */
  eligible: number[];
  winners: number[];
  /** Amount each winner got (same order as winners). */
  shares: number[];
  handName: string | null;
}

export interface HandResult {
  /** True when everyone else folded, so no cards had to be shown. */
  uncontested: boolean;
  pots: PotResult[];
  /** Net chips won by each seat index (amount received from pots). */
  won: Record<number, number>;
  /** Best five cards and hand name per seat index that went to showdown. */
  hands: Record<number, { best: Card[]; name: string }>;
  /** Uncalled chips handed back. */
  returned: { index: number; amount: number } | null;
}

export interface Hand {
  id: number;
  seats: HandSeat[];
  buttonSeat: number;
  sbIndex: number;
  bbIndex: number;
  smallBlind: number;
  bigBlind: number;
  deck: Card[];
  board: Card[];
  street: Street;
  currentBet: number;
  /** Size of the last full raise this street: the smallest allowed raise increment. */
  minRaise: number;
  /** Index into seats of the player to act, or -1 when nobody is to act. */
  toAct: number;
  /** What the room should do next. */
  phase: 'action' | 'deal' | 'done';
  /** True when the rest of the board is being dealt with nobody able to bet (all in). */
  runout: boolean;
  result: HandResult | null;
  /** Seat indexes that chose to show their cards after the hand. */
  shown: number[];
  /** Uncalled chips returned at the end of the last betting street, reported with the result. */
  pendingReturn?: { index: number; amount: number } | null;
}

export interface Participant {
  pid: string;
  seat: number;
  stack: number;
}

export interface Legal {
  canFold: boolean;
  canCheck: boolean;
  /** Chips needed to call (capped at stack). 0 when checking is possible. */
  callAmount: number;
  canRaise: boolean;
  /** Smallest legal "raise to" total for this street. */
  minRaiseTo: number;
  /** Largest legal "raise to" total (all in). */
  maxRaiseTo: number;
  /** True when no bet has been made this street, so a raise is called a bet. */
  isBet: boolean;
}

export type Action =
  | { type: 'fold' }
  | { type: 'check' }
  | { type: 'call' }
  | { type: 'raise'; to: number };

/** Next seat index after i (wrapping) that matches pred, or -1. */
function nextIndex(hand: Hand, i: number, pred: (s: HandSeat) => boolean): number {
  const n = hand.seats.length;
  for (let k = 1; k <= n; k++) {
    const j = (i + k) % n;
    if (pred(hand.seats[j])) return j;
  }
  return -1;
}

const live = (s: HandSeat) => !s.folded;
const canAct = (s: HandSeat) => !s.folded && !s.allIn;

function put(s: HandSeat, amount: number) {
  const a = Math.min(amount, s.stack);
  s.stack -= a;
  s.committed += a;
  s.total += a;
  if (s.stack === 0) s.allIn = true;
  return a;
}

/**
 * Starts a hand. `players` are everyone dealt in (at least two, with chips), any order.
 * `prevButtonSeat` is the seat number that had the button last hand (or -1 for the first hand).
 */
export function startHand(
  id: number,
  players: Participant[],
  prevButtonSeat: number,
  smallBlind: number,
  bigBlind: number,
  deck: Card[] = shuffledDeck(),
): Hand {
  if (players.length < 2) throw new Error('Need at least two players');
  const sorted = [...players].sort((a, b) => a.seat - b.seat);
  const seats: HandSeat[] = sorted.map((p) => ({
    pid: p.pid,
    seat: p.seat,
    stack: p.stack,
    committed: 0,
    total: 0,
    cards: [],
    folded: false,
    allIn: false,
    acted: false,
    lastAction: null,
  }));
  // Button: first seat clockwise after the previous button.
  let buttonIndex = seats.findIndex((s) => s.seat > prevButtonSeat);
  if (buttonIndex < 0) buttonIndex = 0;

  const n = seats.length;
  const headsUp = n === 2;
  const sbIndex = headsUp ? buttonIndex : (buttonIndex + 1) % n;
  const bbIndex = (sbIndex + 1) % n;

  const hand: Hand = {
    id,
    seats,
    buttonSeat: seats[buttonIndex].seat,
    sbIndex,
    bbIndex,
    smallBlind,
    bigBlind,
    deck: [...deck],
    board: [],
    street: 'preflop',
    currentBet: 0,
    minRaise: bigBlind,
    toAct: -1,
    phase: 'action',
    runout: false,
    result: null,
    shown: [],
  };

  // Deal two cards each, one at a time, starting left of the button.
  for (let round = 0; round < 2; round++) {
    for (let k = 1; k <= n; k++) seats[(buttonIndex + k) % n].cards.push(hand.deck.shift()!);
  }

  const sbPaid = put(seats[sbIndex], smallBlind);
  seats[sbIndex].lastAction = `Small blind ${sbPaid}`;
  const bbPaid = put(seats[bbIndex], bigBlind);
  seats[bbIndex].lastAction = `Big blind ${bbPaid}`;
  // Everyone must call the full big blind, even when the big blind player is short.
  hand.currentBet = Math.max(bigBlind, sbPaid, bbPaid);

  // First to act preflop: left of the big blind (heads up that is the button / small blind).
  hand.toAct = nextIndex(hand, bbIndex, canAct);
  settle(hand, bbIndex);
  return hand;
}

export function legalActions(hand: Hand, index: number): Legal {
  const s = hand.seats[index];
  const toCall = Math.max(0, hand.currentBet - s.committed);
  const callAmount = Math.min(toCall, s.stack);
  const maxRaiseTo = s.committed + s.stack;
  const othersWhoCanAct = hand.seats.filter((o, i) => i !== index && canAct(o)).length;
  const minFull = hand.currentBet + hand.minRaise;
  const canRaise =
    hand.phase === 'action' &&
    hand.toAct === index &&
    !s.acted &&
    maxRaiseTo > hand.currentBet &&
    othersWhoCanAct > 0;
  return {
    canFold: true,
    canCheck: toCall === 0,
    callAmount,
    canRaise,
    minRaiseTo: Math.min(minFull, maxRaiseTo),
    maxRaiseTo,
    isBet: hand.currentBet === 0,
  };
}

export class ActionError extends Error {}

/** Applies an action for the player at `index`. Throws ActionError if it is not allowed. */
export function act(hand: Hand, index: number, action: Action): void {
  if (hand.phase !== 'action' || hand.toAct !== index) throw new ActionError("It isn't your turn");
  const s = hand.seats[index];
  const legal = legalActions(hand, index);
  switch (action.type) {
    case 'fold':
      s.folded = true;
      s.lastAction = 'Fold';
      break;
    case 'check':
      if (!legal.canCheck) throw new ActionError('You need to call or fold');
      s.lastAction = 'Check';
      break;
    case 'call': {
      if (legal.callAmount === 0) {
        s.lastAction = 'Check';
        break;
      }
      put(s, legal.callAmount);
      s.lastAction = s.allIn ? `All in ${s.total}` : `Call ${s.committed}`;
      break;
    }
    case 'raise': {
      if (!legal.canRaise) throw new ActionError("You can't raise now");
      const to = Math.floor(action.to);
      if (!Number.isFinite(to) || to < legal.minRaiseTo || to > legal.maxRaiseTo)
        throw new ActionError(`Raise must be between ${legal.minRaiseTo} and ${legal.maxRaiseTo}`);
      const raiseBy = to - hand.currentBet;
      const isBet = hand.currentBet === 0;
      put(s, to - s.committed);
      if (raiseBy >= hand.minRaise) {
        // A full raise reopens the betting for everyone else.
        hand.minRaise = raiseBy;
        for (const o of hand.seats) if (o !== s) o.acted = false;
      }
      hand.currentBet = to;
      s.lastAction = s.allIn ? `All in ${s.total}` : `${isBet ? 'Bet' : 'Raise to'} ${to}`;
      break;
    }
    default:
      throw new ActionError('Unknown action');
  }
  s.acted = true;
  settle(hand, index);
}

/**
 * Folds a player out of turn (they left the table). Works at any time during betting.
 */
export function foldOutOfTurn(hand: Hand, index: number): void {
  if (hand.phase === 'done') return;
  const s = hand.seats[index];
  if (s.folded) return;
  if (hand.phase === 'action' && hand.toAct === index) return act(hand, index, { type: 'fold' });
  s.folded = true;
  s.lastAction = 'Fold';
  if (hand.phase === 'action') settle(hand, hand.toAct === -1 ? index : prevIndex(hand, hand.toAct));
  else if (hand.seats.filter(live).length === 1) finishUncontested(hand);
}

function prevIndex(hand: Hand, i: number) {
  return (i - 1 + hand.seats.length) % hand.seats.length;
}

/** After a player acts, work out who acts next, or whether the street / hand is over. */
function settle(hand: Hand, lastIndex: number) {
  const remaining = hand.seats.filter(live);
  if (remaining.length === 1) return finishUncontested(hand);

  const needsToAct = (o: HandSeat) => canAct(o) && (!o.acted || o.committed < hand.currentBet);
  // Special case: nobody else can act and the only player who could has matched the bet.
  const next = nextIndex(hand, lastIndex, needsToAct);
  if (next >= 0) {
    // If this player is the only one who can still act and everyone else is all in for no more than
    // they have put in, they have nothing to decide.
    const actors = hand.seats.filter(canAct);
    if (actors.length === 1 && hand.seats[next].committed >= hand.currentBet) {
      // fall through to end of street
    } else {
      hand.toAct = next;
      hand.phase = 'action';
      return;
    }
  }
  endStreet(hand);
}

function returnUncalled(hand: Hand) {
  const bets = hand.seats.map((s) => s.committed);
  const max = Math.max(...bets);
  const top = hand.seats.filter((s) => s.committed === max);
  if (top.length !== 1 || max === 0 || top[0].folded) return null;
  const second = Math.max(0, ...hand.seats.filter((s) => s !== top[0]).map((s) => s.committed));
  const extra = max - second;
  if (extra <= 0) return null;
  const s = top[0];
  s.committed -= extra;
  s.total -= extra;
  s.stack += extra;
  if (s.stack > 0) s.allIn = false;
  return { index: hand.seats.indexOf(s), amount: extra };
}

function endStreet(hand: Hand) {
  const returned = returnUncalled(hand);
  if (returned) hand.pendingReturn = returned;
  for (const s of hand.seats) {
    s.committed = 0;
    s.acted = false;
  }
  hand.currentBet = 0;
  hand.minRaise = hand.bigBlind;
  hand.toAct = -1;
  if (hand.street === 'river') return showdown(hand);
  // Fewer than two players can still bet: deal the rest of the board without stopping.
  if (hand.seats.filter(canAct).length < 2) hand.runout = true;
  hand.phase = 'deal';
}

/** Deals the next street (call when phase is 'deal'). */
export function dealNextStreet(hand: Hand): void {
  if (hand.phase !== 'deal') return;
  if (hand.street === 'preflop') {
    hand.board.push(...hand.deck.splice(0, 3));
    hand.street = 'flop';
  } else if (hand.street === 'flop') {
    hand.board.push(hand.deck.shift()!);
    hand.street = 'turn';
  } else if (hand.street === 'turn') {
    hand.board.push(hand.deck.shift()!);
    hand.street = 'river';
  }
  for (const s of hand.seats) if (!s.folded && !s.allIn) s.lastAction = null;
  if (hand.seats.filter(canAct).length < 2) hand.runout = true;
  if (hand.runout) {
    if (hand.street === 'river') return showdown(hand);
    hand.phase = 'deal';
    return;
  }
  // First to act after the flop: first live player left of the button.
  const buttonIndex = hand.seats.findIndex((s) => s.seat === hand.buttonSeat);
  hand.phase = 'action';
  hand.toAct = nextIndex(hand, buttonIndex, canAct);
}

function finishUncontested(hand: Hand) {
  const returned = returnUncalled(hand) ?? hand.pendingReturn ?? null;
  const winner = hand.seats.findIndex(live);
  const amount = hand.seats.reduce((a, s) => a + s.total, 0);
  hand.seats[winner].stack += amount;
  hand.result = {
    uncontested: true,
    pots: [{ amount, eligible: [winner], winners: [winner], shares: [amount], handName: null }],
    won: { [winner]: amount },
    hands: {},
    returned,
  };
  hand.toAct = -1;
  hand.phase = 'done';
  delete hand.pendingReturn;
}

/** Builds main and side pots from what everyone put in. */
export function buildPots(hand: Hand): { amount: number; eligible: number[] }[] {
  const remaining = hand.seats.map((s) => s.total);
  const pots: { amount: number; eligible: number[] }[] = [];
  for (;;) {
    const liveWithChips = hand.seats.map((s, i) => i).filter((i) => !hand.seats[i].folded && remaining[i] > 0);
    if (liveWithChips.length === 0) break;
    const level = Math.min(...liveWithChips.map((i) => remaining[i]));
    let amount = 0;
    for (let i = 0; i < remaining.length; i++) {
      const take = Math.min(remaining[i], level);
      amount += take;
      remaining[i] -= take;
    }
    const last = pots[pots.length - 1];
    if (last && last.eligible.length === liveWithChips.length && last.eligible.every((e) => liveWithChips.includes(e)))
      last.amount += amount;
    else pots.push({ amount, eligible: liveWithChips });
  }
  // Chips from folded players beyond every live player's total (rare) go to the last pot.
  const leftover = remaining.reduce((a, b) => a + b, 0);
  if (leftover > 0 && pots.length) pots[pots.length - 1].amount += leftover;
  return pots;
}

/** Pots as they stand during the hand (for display): chips from finished streets only. */
export function potsForDisplay(hand: Hand): { amount: number; eligible: number[] }[] {
  const saved = hand.seats.map((s) => s.total);
  for (const s of hand.seats) s.total -= s.committed;
  const pots = buildPots(hand);
  hand.seats.forEach((s, i) => (s.total = saved[i]));
  return pots.filter((p) => p.amount > 0);
}

function showdown(hand: Hand) {
  const returned = hand.pendingReturn ?? null;
  delete hand.pendingReturn;
  const pots = buildPots(hand);
  const hands: HandResult['hands'] = {};
  const values = new Map<number, ReturnType<typeof evaluate>>();
  hand.seats.forEach((s, i) => {
    if (s.folded) return;
    const v = evaluate([...s.cards, ...hand.board]);
    values.set(i, v);
    hands[i] = { best: v.best, name: v.name };
  });
  const won: Record<number, number> = {};
  const buttonIndex = hand.seats.findIndex((s) => s.seat === hand.buttonSeat);
  const n = hand.seats.length;
  const results: PotResult[] = pots.map((pot) => {
    let bestKey: number[] | null = null;
    let winners: number[] = [];
    for (const i of pot.eligible) {
      const k = values.get(i)!.key;
      const c = bestKey ? compareKeys(k, bestKey) : 1;
      if (c > 0) {
        bestKey = k;
        winners = [i];
      } else if (c === 0) winners.push(i);
    }
    // Odd chips go to the first winners clockwise from the button.
    winners.sort((a, b) => ((a - buttonIndex - 1 + n) % n) - ((b - buttonIndex - 1 + n) % n));
    const base = Math.floor(pot.amount / winners.length);
    let odd = pot.amount - base * winners.length;
    const shares = winners.map(() => base + (odd-- > 0 ? 1 : 0));
    winners.forEach((w, k) => {
      hand.seats[w].stack += shares[k];
      won[w] = (won[w] ?? 0) + shares[k];
    });
    return { ...pot, winners, shares, handName: values.get(winners[0])!.name };
  });
  hand.result = { uncontested: false, pots: results, won, hands, returned };
  hand.toAct = -1;
  hand.phase = 'done';
}

