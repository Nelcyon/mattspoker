import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareKeys, evaluate, fullDeck } from '../src/shared/cards.ts';
import {
  act,
  buildPots,
  dealNextStreet,
  foldOutOfTurn,
  type Hand,
  legalActions,
  startHand,
} from '../src/shared/holdem.ts';

const ev = (s: string) => evaluate(s.split(' '));
const beats = (a: string, b: string) => compareKeys(ev(a).key, ev(b).key) > 0;
const ties = (a: string, b: string) => compareKeys(ev(a).key, ev(b).key) === 0;

test('hand categories and names', () => {
  assert.equal(ev('As Ks Qs Js Ts 2d 3c').name, 'Royal flush');
  assert.equal(ev('5h 4h 3h 2h Ah Kd Kc').name, 'Straight flush, five high');
  assert.equal(ev('9c 9d 9h 9s 2d 3c 4h').name, 'Four of a kind, nines');
  assert.equal(ev('Kc Kd Kh 3s 3d 2c 2h').name, 'Full house, kings full of threes');
  assert.equal(ev('Kc Kd Kh 3s 3d 3c 2h').name, 'Full house, kings full of threes');
  assert.equal(ev('Ac 9c 7c 4c 2c Kd Qh').name, 'Flush, ace high');
  assert.equal(ev('Ac 2d 3h 4s 5c Kd Kh').name, 'Straight, five high');
  assert.equal(ev('Tc Jd Qh Ks Ac 2d 2h').name, 'Straight, ace high');
  assert.equal(ev('7c 7d 7h As Kc 2d 4h').name, 'Three of a kind, sevens');
  assert.equal(ev('7c 7d 4h 4s Kc Kd 2h').name, 'Two pair, kings and sevens');
  assert.equal(ev('Jc Jd 4h 5s 8c 9d 2h').name, 'Pair of jacks');
  assert.equal(ev('Ac Td 4h 5s 8c 9d 2h').name, 'Ace high');
  assert.equal(ev('Ac Td 4h 5s 8c 9d 2h').best.length, 5);
});

test('hand comparisons', () => {
  assert.ok(beats('Ah Kh Qh Jh Th', '9h 9c 9d 9s Ah'));
  assert.ok(beats('2c 3c 4c 5c 7c', 'Ah Kd Qc Js Th'));
  assert.ok(beats('6c 2d 3h 4s 5c', 'Ac 2d 3h 4s 5c')); // six-high straight beats the wheel
  assert.ok(beats('Ac Ad Kc Kd 3h', 'Ac Ad Qc Qd Kh'));
  assert.ok(beats('Ac Ad Kc Kd 4h', 'Ah As Kh Ks 3h')); // kicker on two pair
  assert.ok(beats('Ac Ad Kc 7d 3h', 'Ah As Qh Js Th')); // kicker on pair
  assert.ok(ties('Ac Kd Qh Js 9c', 'Ad Kh Qs Jc 9d'));
  assert.ok(beats('8c 8d 8h 2c 2d', '7c 7d 7h Ac Ad'));
  assert.ok(beats('Kc Qc 9c 5c 3c', 'Kd Qd 9d 5d 2d'));
});

// --- Engine helpers ---
function deckWith(top: string[]): string[] {
  const rest = fullDeck().filter((c) => !top.includes(c));
  return [...top, ...rest];
}

const totalChips = (h: Hand) => h.seats.reduce((a, s) => a + s.stack + s.total, 0) - (h.phase === 'done' ? h.seats.reduce((a, s) => a + s.total, 0) : 0);
const idx = (h: Hand, pid: string) => h.seats.findIndex((s) => s.pid === pid);

function runToEnd(h: Hand) {
  let guard = 0;
  while (h.phase === 'deal' && guard++ < 10) dealNextStreet(h);
}

test('blinds, button and first to act with three players', () => {
  const h = startHand(1, [
    { pid: 'a', seat: 0, stack: 100 },
    { pid: 'b', seat: 3, stack: 100 },
    { pid: 'c', seat: 5, stack: 100 },
  ], -1, 1, 2);
  assert.equal(h.buttonSeat, 0);
  assert.equal(h.seats[h.sbIndex].pid, 'b');
  assert.equal(h.seats[h.bbIndex].pid, 'c');
  assert.equal(h.seats[h.toAct].pid, 'a');
  assert.equal(h.seats[idx(h, 'b')].stack, 99);
  assert.equal(h.seats[idx(h, 'c')].stack, 98);
  // Next hand: button moves to seat 3.
  const h2 = startHand(2, h.seats.map((s) => ({ pid: s.pid, seat: s.seat, stack: 100 })), h.buttonSeat, 1, 2);
  assert.equal(h2.buttonSeat, 3);
  // Wraps around.
  const h3 = startHand(3, h.seats.map((s) => ({ pid: s.pid, seat: s.seat, stack: 100 })), 5, 1, 2);
  assert.equal(h3.buttonSeat, 0);
});

test('heads up: button posts small blind and acts first preflop, last after', () => {
  const h = startHand(1, [
    { pid: 'a', seat: 2, stack: 100 },
    { pid: 'b', seat: 7, stack: 100 },
  ], 2, 5, 10);
  assert.equal(h.buttonSeat, 7);
  assert.equal(h.seats[h.sbIndex].pid, 'b');
  assert.equal(h.seats[h.toAct].pid, 'b');
  act(h, h.toAct, { type: 'call' });
  // Big blind gets the option.
  assert.equal(h.seats[h.toAct].pid, 'a');
  assert.ok(legalActions(h, h.toAct).canCheck);
  assert.ok(legalActions(h, h.toAct).canRaise);
  act(h, h.toAct, { type: 'check' });
  assert.equal(h.phase, 'deal');
  dealNextStreet(h);
  assert.equal(h.board.length, 3);
  assert.equal(h.seats[h.toAct].pid, 'a'); // non-button acts first after the flop
});

test('everyone folds to the big blind: uncontested, blinds only', () => {
  const h = startHand(1, [
    { pid: 'a', seat: 0, stack: 100 },
    { pid: 'b', seat: 1, stack: 100 },
    { pid: 'c', seat: 2, stack: 100 },
  ], -1, 1, 2);
  act(h, h.toAct, { type: 'fold' }); // a
  act(h, h.toAct, { type: 'fold' }); // b (sb)
  assert.equal(h.phase, 'done');
  assert.ok(h.result!.uncontested);
  assert.equal(h.seats[idx(h, 'c')].stack, 101);
  assert.equal(h.seats[idx(h, 'b')].stack, 99);
  assert.equal(h.result!.pots[0].amount, 2); // the big blind's unmatched chip went straight back
});

test('uncalled bet is returned', () => {
  const h = startHand(1, [
    { pid: 'a', seat: 0, stack: 100 },
    { pid: 'b', seat: 1, stack: 100 },
    { pid: 'c', seat: 2, stack: 100 },
  ], -1, 1, 2);
  act(h, h.toAct, { type: 'raise', to: 50 }); // a
  act(h, h.toAct, { type: 'fold' });
  act(h, h.toAct, { type: 'fold' });
  assert.equal(h.phase, 'done');
  assert.equal(h.seats[idx(h, 'a')].stack, 103);
  assert.equal(h.result!.returned!.amount, 48);
});

test('minimum raise rules and incomplete all-in raise does not reopen betting', () => {
  const h = startHand(1, [
    { pid: 'a', seat: 0, stack: 1000 },
    { pid: 'b', seat: 1, stack: 1000 },
    { pid: 'c', seat: 2, stack: 1000 },
    { pid: 'd', seat: 3, stack: 130 },
  ], -1, 5, 10);
  // button a, sb b, bb c, d first
  assert.equal(h.seats[h.toAct].pid, 'd');
  act(h, h.toAct, { type: 'call' }); // d calls 10
  // a raises to 100 (raise of 90)
  assert.equal(legalActions(h, h.toAct).minRaiseTo, 20);
  act(h, h.toAct, { type: 'raise', to: 100 });
  assert.equal(legalActions(h, h.toAct).minRaiseTo, 190);
  assert.throws(() => act(h, h.toAct, { type: 'raise', to: 150 }));
  act(h, h.toAct, { type: 'fold' }); // b
  act(h, h.toAct, { type: 'fold' }); // c
  // d goes all in for 130 total: raise of only 30, less than 90
  assert.equal(h.seats[h.toAct].pid, 'd');
  act(h, h.toAct, { type: 'raise', to: 130 });
  // a can only call or fold
  assert.equal(h.seats[h.toAct].pid, 'a');
  const l = legalActions(h, h.toAct);
  assert.equal(l.canRaise, false);
  assert.equal(l.callAmount, 30);
  act(h, h.toAct, { type: 'call' });
  assert.equal(h.phase, 'deal');
  assert.ok(h.runout);
  runToEnd(h);
  assert.equal(h.phase, 'done');
  assert.equal(h.board.length, 5);
  const sum = h.seats.reduce((a, s) => a + s.stack, 0);
  assert.equal(sum, 1000 * 3 + 130);
});

test('side pots with three different all-ins', () => {
  // Rig the deck: a gets AA, b gets KK, c gets QQ, d gets 72o; board blanks.
  // Deal order starts left of button. Button seat 0 (a): order b c d a, twice.
  const deck = deckWith([
    'Kc', 'Qc', '7d', 'Ac',
    'Kd', 'Qd', '2s', 'Ad',
    '3h', '8s', '9h', 'Jd', '4c',
  ]);
  const h = startHand(1, [
    { pid: 'a', seat: 0, stack: 50 },
    { pid: 'b', seat: 1, stack: 200 },
    { pid: 'c', seat: 2, stack: 100 },
    { pid: 'd', seat: 3, stack: 300 },
  ], -1, 1, 2, deck);
  assert.deepEqual(h.seats[0].cards, ['Ac', 'Ad']);
  // d first, raise all in 300
  act(h, h.toAct, { type: 'raise', to: 300 });
  act(h, h.toAct, { type: 'call' }); // a all in 50
  act(h, h.toAct, { type: 'call' }); // b all in 200
  act(h, h.toAct, { type: 'call' }); // c all in 100
  runToEnd(h);
  assert.equal(h.phase, 'done');
  const r = h.result!;
  // main pot 50*4 = 200 -> a ; side 1: 50*3 = 150 -> b (KK beats QQ & 72) ; side 2: 100*2 = 200 -> b ; d gets 100 back
  assert.equal(r.returned!.amount, 100);
  assert.equal(h.seats[0].stack, 200);
  assert.equal(h.seats[1].stack, 350);
  assert.equal(h.seats[2].stack, 0);
  assert.equal(h.seats[3].stack, 100);
});

test('split pot with odd chip goes left of button', () => {
  // Both play the board (royal flush on board).
  const deck = deckWith(['2c', '2d', '3c', '3d', '4h', '4d', 'As', 'Ks', 'Qs', 'Js', 'Ts']);
  // b c d a? Use three players: button a(0), b(1), c(2). Deal order: b c a b c a.
  const h = startHand(1, [
    { pid: 'a', seat: 0, stack: 100 },
    { pid: 'b', seat: 1, stack: 100 },
    { pid: 'c', seat: 2, stack: 100 },
  ], -1, 1, 2, deck);
  // a calls, b folds (leaving 1 in pot), c checks: pot 2+2+1 = 5
  act(h, h.toAct, { type: 'call' });
  act(h, h.toAct, { type: 'fold' });
  act(h, h.toAct, { type: 'check' });
  for (let i = 0; i < 3; i++) {
    dealNextStreet(h);
    act(h, h.toAct, { type: 'check' });
    act(h, h.toAct, { type: 'check' });
  }
  assert.equal(h.phase, 'done');
  // pot 5 split between a and c: c is first left of button (b folded), gets 3.
  assert.equal(h.seats[2].stack, 101);
  assert.equal(h.seats[0].stack, 100);
});

test('short big blind still means calling the full blind', () => {
  const h = startHand(1, [
    { pid: 'a', seat: 0, stack: 100 },
    { pid: 'b', seat: 1, stack: 100 },
    { pid: 'c', seat: 2, stack: 3 },
  ], -1, 5, 10);
  assert.ok(h.seats[2].allIn);
  assert.equal(legalActions(h, h.toAct).callAmount, 10);
});

test('player leaving out of turn folds and play continues', () => {
  const h = startHand(1, [
    { pid: 'a', seat: 0, stack: 100 },
    { pid: 'b', seat: 1, stack: 100 },
    { pid: 'c', seat: 2, stack: 100 },
  ], -1, 1, 2);
  assert.equal(h.seats[h.toAct].pid, 'a');
  foldOutOfTurn(h, idx(h, 'c'));
  assert.equal(h.seats[h.toAct].pid, 'a');
  act(h, h.toAct, { type: 'fold' });
  assert.equal(h.phase, 'done');
  assert.equal(h.seats[idx(h, 'b')].stack, 102);
});

test('pot building merges equal levels', () => {
  const h = startHand(1, [
    { pid: 'a', seat: 0, stack: 100 },
    { pid: 'b', seat: 1, stack: 100 },
  ], -1, 1, 2);
  act(h, h.toAct, { type: 'call' });
  act(h, h.toAct, { type: 'check' });
  assert.equal(buildPots(h).length, 1);
  assert.equal(buildPots(h)[0].amount, 4);
});

// Random play: chips are never created or lost, and every hand finishes.
test('random play keeps chips constant and always finishes', () => {
  let seed = 12345;
  const rnd = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  for (let game = 0; game < 3000; game++) {
    const n = 2 + rnd(8);
    const players = Array.from({ length: n }, (_, i) => ({ pid: 'p' + i, seat: i * 1 + (rnd(2) ? 0 : 0), stack: 1 + rnd(400) }));
    const start = players.reduce((a, p) => a + p.stack, 0);
    const h = startHand(game, players, rnd(n) - 1, 1 + rnd(3), 4 + rnd(4));
    let steps = 0;
    while (h.phase !== 'done') {
      assert.ok(steps++ < 500, 'hand did not finish');
      if (h.phase === 'deal') {
        dealNextStreet(h);
        continue;
      }
      const i = h.toAct;
      assert.ok(i >= 0);
      const s = h.seats[i];
      assert.ok(!s.folded && !s.allIn);
      const l = legalActions(h, i);
      const r = rnd(10);
      if (rnd(25) === 0) {
        // someone else leaves
        const j = rnd(n);
        foldOutOfTurn(h, j);
        continue;
      }
      if (r < 2) act(h, i, { type: 'fold' });
      else if (r < 6) act(h, i, { type: l.canCheck ? 'check' : 'call' });
      else if (l.canRaise) {
        const to = l.minRaiseTo + rnd(Math.max(1, l.maxRaiseTo - l.minRaiseTo + 1));
        act(h, i, { type: 'raise', to: Math.min(to, l.maxRaiseTo) });
      } else act(h, i, { type: 'call' });
    }
    const end = h.seats.reduce((a, s) => a + s.stack, 0);
    assert.equal(end, start, `chips changed in game ${game}`);
    const paid = h.result!.pots.reduce((a, p) => a + p.amount, 0);
    const putIn = h.seats.reduce((a, s) => a + s.total, 0);
    assert.equal(paid, putIn);
  }
});
void totalChips;
