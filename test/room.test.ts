import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type Conn, newRoomState, Room, type RoomState, STALE_MS } from '../src/server/room.ts';
import type { ClientMsg, ServerMsg, TableView } from '../src/shared/protocol.ts';

class FakeConn implements Conn {
  pid: string | null = null;
  hidden = false;
  open = true;
  seen: number;
  inbox: ServerMsg[] = [];
  t: Table;
  constructor(t: Table) {
    this.t = t;
    this.seen = t.clock;
  }
  lastSeen() {
    return this.seen;
  }
  send(m: ServerMsg) {
    this.inbox.push(m);
  }
  close() {
    this.open = false;
  }
  save() {}
  say(m: ClientMsg) {
    this.seen = this.t.clock;
    this.t.room.message(this, JSON.stringify(m));
  }
  get view(): TableView {
    const s = [...this.inbox].reverse().find((m) => m.t === 'state');
    return (s as { s: TableView }).s;
  }
  get welcome() {
    return this.inbox.find((m) => m.t === 'welcome') as Extract<ServerMsg, { t: 'welcome' }> | undefined;
  }
  last(t: ServerMsg['t']) {
    return [...this.inbox].reverse().find((m) => m.t === t);
  }
}

class Table {
  clock = 1_000_000;
  conns: FakeConn[] = [];
  saved: string = '';
  /** How many times the room asked the host to write the table, and how many times it was woken. */
  saves = 0;
  ticks = 0;
  wake: number | null = null;
  room: Room;
  constructor(state?: RoomState) {
    this.room = new Room(state ?? newRoomState('ABCD', this.clock), {
      conns: () => this.conns.filter((c) => c.open),
      now: () => this.clock,
      persist: (s) => {
        this.saves++;
        this.saved = JSON.stringify(s);
      },
      wakeAt: (at) => (this.wake = at),
    });
  }
  connect() {
    const c = new FakeConn(this);
    this.conns.push(c);
    return c;
  }
  join(name: string, token?: string) {
    const c = this.connect();
    c.say({ t: 'join', name, token });
    return c;
  }
  /** Advance time, keeping these connections' heartbeats fresh, and fire any due wake. */
  advance(ms: number, alive: FakeConn[] = this.conns) {
    const end = this.clock + ms;
    while (this.clock < end) {
      const step = Math.min(1000, end - this.clock);
      this.clock += step;
      for (const c of alive) c.seen = this.clock;
      if (this.wake !== null && this.wake <= this.clock) {
        this.ticks++;
        this.room.tick();
      }
    }
  }
}

function toActConn(t: Table): FakeConn {
  const v = t.conns.find((c) => c.open && c.pid)!.view;
  return t.conns.find((c) => c.open && c.pid === v.hand!.toAct)!;
}

test('join, start, and play a hand to the end', () => {
  const t = new Table();
  const a = t.join('Alice');
  const b = t.join('Bob');
  assert.equal(a.view.hostId, a.welcome!.pid);
  assert.equal(a.view.players.length, 2);
  b.say({ t: 'host', op: 'start' });
  assert.match((b.last('error') as { message: string }).message, /host/);
  a.say({ t: 'host', op: 'start' });
  const v = a.view;
  assert.ok(v.started);
  assert.ok(v.hand);
  assert.equal(v.hand!.board.length, 0);
  // Each player sees only their own cards.
  const me = v.players.find((p) => p.id === a.pid)!;
  const them = v.players.find((p) => p.id === b.pid)!;
  assert.equal(me.cards!.length, 2);
  assert.equal(them.cards, null);
  // Play: call, check down.
  let guard = 0;
  while (!a.view.hand!.done && guard++ < 50) {
    if (a.view.hand!.toAct) {
      const c = toActConn(t);
      const yt = c.view.you_turn!;
      c.say({ t: 'act', handId: c.view.hand!.id, action: yt.canCheck ? 'check' : 'call' });
    } else t.advance(2000);
  }
  assert.ok(a.view.hand!.done);
  assert.equal(a.view.hand!.board.length, 5);
  assert.ok(a.view.hand!.summary.length > 0);
  const total = a.view.players.reduce((x, p) => x + p.stack, 0);
  assert.equal(total, 2000);
  // Next hand deals by itself.
  t.advance(8000);
  assert.equal(a.view.hand!.id, 2);
});

test('closing the browser and coming back with the same name keeps the seat and chips', () => {
  const t = new Table();
  const a = t.join('Alice');
  const b = t.join('Bob');
  a.say({ t: 'host', op: 'start' });
  const bobId = b.pid;
  const seat = b.view.players.find((p) => p.id === bobId)!.seat;
  b.close();
  t.room.disconnect(b);
  // Bob opens a new browser (no token), types his name.
  const b2 = t.join('bob');
  assert.equal(b2.welcome!.pid, bobId);
  assert.equal(b2.view.players.find((p) => p.id === bobId)!.seat, seat);
  assert.equal(b2.view.players.length, 2);
});

test('same token reconnects silently; a second device with the same name asks first', () => {
  const t = new Table();
  const a = t.join('Alice');
  const token = a.welcome!.token;
  // Tab reconnects with its token (e.g. after the phone slept).
  const a2 = t.join('Alice', token);
  assert.equal(a2.welcome!.pid, a.pid);
  // Someone else types "Alice" while Alice is connected.
  const imposter = t.join('ALICE');
  assert.ok(imposter.last('takeoverPrompt'));
  assert.equal(imposter.welcome, undefined);
  // They confirm it's really them (e.g. switched devices): old devices are signed out.
  const aliceId = a.pid;
  imposter.say({ t: 'join', name: 'Alice', takeover: true });
  assert.equal(imposter.welcome!.pid, aliceId);
  assert.ok(a.last('replaced'));
  assert.equal(a.open, false);
});

test('switching apps does not remove a player; an away player is auto-checked/folded and keeps the seat', () => {
  const t = new Table();
  const a = t.join('Alice');
  const b = t.join('Bob');
  const c = t.join('Cara');
  a.say({ t: 'host', op: 'start' });
  const actor = toActConn(t);
  // The player to act puts the game in the background.
  actor.say({ t: 'visibility', hidden: true });
  assert.ok(a.view.players.find((p) => p.id === actor.pid)!.away);
  const handId = a.view.hand!.id;
  t.advance(29_000);
  assert.equal(a.view.hand!.toAct, actor.pid, 'still their turn within the grace period');
  t.advance(2_000);
  assert.notEqual(a.view.hand!.toAct, actor.pid);
  const pv = a.view.players.find((p) => p.id === actor.pid)!;
  assert.ok(pv.seat !== null, 'still seated');
  assert.equal(a.view.hand!.id, handId);
  void b;
  void c;
});

test('no turn clock by default: a present player can take as long as they like', () => {
  const t = new Table();
  const a = t.join('Alice');
  t.join('Bob');
  a.say({ t: 'host', op: 'start' });
  const actor = toActConn(t);
  t.advance(10 * 60_000);
  assert.equal(a.view.hand!.toAct, actor.pid);
  assert.equal(a.view.hand!.actDeadline, null);
});

test('turn clock when turned on, and two timeouts in a row sits a player out', () => {
  const t = new Table();
  const a = t.join('Alice');
  const b = t.join('Bob');
  a.say({ t: 'host', op: 'settings', settings: { turnSeconds: 20 } });
  a.say({ t: 'host', op: 'start' });
  let guard = 0;
  // Bob never acts; Alice always checks/calls.
  while (!a.view.players.find((p) => p.id === b.pid)!.status.includes('sittingOut') && guard++ < 40) {
    const v = a.view;
    if (v.hand?.toAct === a.pid) a.say({ t: 'act', handId: v.hand!.id, action: v.you_turn!.canCheck ? 'check' : 'call' });
    else t.advance(5000);
  }
  assert.equal(a.view.players.find((p) => p.id === b.pid)!.status, 'sittingOut');
  // Bob comes back.
  b.say({ t: 'sitIn' });
  assert.notEqual(a.view.players.find((p) => p.id === b.pid)!.status, 'sittingOut');
});

test('everyone gone: the game stops dealing instead of draining chips', () => {
  const t = new Table();
  const a = t.join('Alice');
  const b = t.join('Bob');
  a.say({ t: 'host', op: 'start' });
  a.close();
  b.close();
  t.room.disconnect(a);
  t.advance(30 * 60_000, []);
  const hands = JSON.parse(t.saved).handCount;
  t.advance(30 * 60_000, []);
  assert.equal(JSON.parse(t.saved).handCount, hands, 'no more hands dealt');
  const st = JSON.parse(t.saved) as RoomState;
  assert.equal(st.players.reduce((x, p) => x + p.stack, 0), 2000);
});

test('state survives a restart (saved JSON reloaded)', () => {
  const t = new Table();
  const a = t.join('Alice');
  t.join('Bob');
  a.say({ t: 'host', op: 'start' });
  const before = a.view;
  const t2 = new Table(JSON.parse(t.saved));
  t2.clock = t.clock;
  const a2 = t2.join('Alice', a.welcome!.token);
  const after = a2.view;
  assert.equal(after.hand!.id, before.hand!.id);
  assert.deepEqual(after.players.find((p) => p.id === a.pid)!.cards, before.players.find((p) => p.id === a.pid)!.cards);
  assert.equal(after.hand!.toAct, before.hand!.toAct);
});

test('leaving mid-hand folds, and rejoining restores chips', () => {
  const t = new Table();
  const a = t.join('Alice');
  const b = t.join('Bob');
  const c = t.join('Cara');
  a.say({ t: 'host', op: 'start' });
  const actor = toActConn(t);
  actor.say({ t: 'act', handId: actor.view.hand!.id, action: 'raise', to: 100 });
  // Someone else leaves.
  const leaver = [a, b, c].find((x) => x !== actor && x.view.hand!.toAct !== x.pid)!;
  const stackBefore = leaver.view.players.find((p) => p.id === leaver.pid)!.stack;
  leaver.say({ t: 'leave' });
  assert.equal(actor.view.players.find((p) => p.id === leaver.pid), undefined);
  const back = t.join(leaver.view.players.find((p) => p.id === leaver.pid)?.name ?? (leaver === a ? 'Alice' : leaver === b ? 'Bob' : 'Cara'));
  const me = back.view.players.find((p) => p.id === back.pid)!;
  assert.equal(me.stack, stackBefore);
  assert.ok(me.seat !== null);
});

test('host can pause, change blinds, and set stacks', () => {
  const t = new Table();
  const a = t.join('Alice');
  const b = t.join('Bob');
  a.say({ t: 'host', op: 'settings', settings: { smallBlind: 25, bigBlind: 50, startingStack: 5000 } });
  assert.equal(b.view.players.find((p) => p.id === b.pid)!.stack, 5000);
  a.say({ t: 'host', op: 'start' });
  assert.equal(a.view.bigBlind, 50);
  a.say({ t: 'host', op: 'pause' });
  assert.ok(a.view.paused);
  assert.equal(b.view.you_turn, null);
  a.say({ t: 'host', op: 'resume' });
  a.say({ t: 'host', op: 'setStack', pid: b.pid!, stack: 1234 });
  // in a hand: applied after
  assert.match(a.view.log.at(-1)!.text, /after this hand/);
});

test('blinds go up on a timer', () => {
  const t = new Table();
  const a = t.join('Alice');
  const b = t.join('Bob');
  a.say({ t: 'host', op: 'settings', settings: { blindLevelMinutes: 10 } });
  a.say({ t: 'host', op: 'start' });
  assert.equal(a.view.bigBlind, 10);
  t.advance(11 * 60_000);
  // finish the current hand by folding
  const c = toActConn(t);
  c.say({ t: 'act', handId: c.view.hand!.id, action: 'fold' });
  t.advance(8000);
  assert.equal(a.view.bigBlind, 20);
  void b;
});

test('host who disappears can be replaced', () => {
  const t = new Table();
  const a = t.join('Alice');
  const b = t.join('Bob');
  a.close();
  t.room.disconnect(a);
  t.advance(30_000, [b]);
  assert.equal(b.view.canClaimHost, false);
  t.advance(40_000, [b]);
  assert.equal(b.view.canClaimHost, true);
  b.say({ t: 'claimHost' });
  assert.equal(b.view.hostId, b.pid);
});

const stateCount = (c: FakeConn) => c.inbox.filter((m) => m.t === 'state').length;

test('an idle table with everyone connected writes and sends nothing new', () => {
  const t = new Table();
  const a = t.join('Alice');
  const b = t.join('Bob');
  const saves = t.saves;
  const sentA = stateCount(a);
  const sentB = stateCount(b);
  const ticks = t.ticks;
  t.advance(30 * 60_000);
  assert.ok(t.ticks - ticks >= 30, 'the room still wakes now and then to look for dropped connections');
  // The only writes allowed are the occasional "someone is still here" mark (at most one per 10 minutes).
  assert.ok(t.saves - saves <= 3, `saves went from ${saves} to ${t.saves}`);
  assert.equal(stateCount(a), sentA, 'identical tables are not sent again');
  assert.equal(stateCount(b), sentB);
  // A real action is still saved and sent.
  a.say({ t: 'host', op: 'settings', settings: { smallBlind: 10, bigBlind: 20 } });
  assert.equal(t.saves - saves >= 1, true);
  assert.equal(stateCount(a), sentA + 1);
  assert.equal(stateCount(b), sentB + 1);
});

test('the next wake is when the quietest connection would count as dropped', () => {
  const t = new Table();
  const a = t.join('Alice');
  const b = t.join('Bob');
  a.seen = t.clock - 5_000;
  b.seen = t.clock - 2_000;
  t.room.tick();
  assert.equal(t.wake, a.seen + STALE_MS);
  // Nobody connected: nothing to watch, only the long idle cleanup remains.
  a.close();
  b.close();
  t.room.tick();
  assert.ok(t.wake! > t.clock + 24 * 3600_000);
});

test('a connection that goes silent is noticed as soon as it counts as dropped', () => {
  const t = new Table();
  const a = t.join('Alice');
  const b = t.join('Bob');
  t.advance(20_000);
  const lastHeard = a.seen;
  let noticed = -1;
  for (let i = 0; i < 120 && noticed < 0; i++) {
    t.advance(1000, [b]);
    if (!b.view.players.find((p) => p.id === a.pid)!.online) noticed = t.clock - lastHeard;
  }
  assert.ok(noticed >= STALE_MS && noticed <= STALE_MS + 1000, `noticed after ${noticed} ms`);
});

test('a connection that looked dropped but is still open comes back without a message', () => {
  const t = new Table();
  const a = t.join('Alice');
  const b = t.join('Bob');
  t.advance(60_000, [b]);
  assert.equal(b.view.players.find((p) => p.id === a.pid)!.online, false);
  a.seen = t.clock; // heartbeats resume (answered without waking the room)
  t.advance(11_000);
  assert.equal(b.view.players.find((p) => p.id === a.pid)!.online, true);
});

test('joining or reconnecting always gets the table, even if it has not changed', () => {
  const t = new Table();
  const a = t.join('Alice');
  const b = t.join('Bob');
  t.room.tick();
  const before = stateCount(a);
  // Same connection joins again (e.g. taking over / re-sending its join).
  a.say({ t: 'join', name: 'Alice', token: a.welcome!.token });
  assert.equal(stateCount(a), before + 1);
  // A brand new connection for the same seat.
  const a2 = t.join('Alice', a.welcome!.token);
  assert.equal(stateCount(a2), 1);
  assert.equal(a2.view.players.length, 2);
  assert.ok(b.view);
});

test('the host gets the take-over option right when the 60 seconds are up', () => {
  const t = new Table();
  const a = t.join('Alice');
  const b = t.join('Bob');
  a.close();
  t.room.disconnect(a);
  t.advance(59_000, [b]);
  assert.equal(b.view.canClaimHost, false);
  t.advance(2_000, [b]);
  assert.equal(b.view.canClaimHost, true);
});

test('elimination: a player at 0 chips is out, dealt no cards, pays no blinds, and cannot buy back in', () => {
  const t = new Table();
  const a = t.join('Alice');
  const b = t.join('Bob');
  const c = t.join('Cara');
  a.say({ t: 'host', op: 'setStack', pid: c.pid!, stack: 0 });
  a.say({ t: 'host', op: 'start' });
  const seatOf = (id: string) => a.view.players.find((p) => p.id === id)!.seat;
  for (let hands = 1; hands <= 2; hands++) {
    const v = a.view;
    assert.equal(v.hand!.id, hands);
    const cara = v.players.find((p) => p.id === c.pid)!;
    assert.equal(cara.status, 'busted');
    assert.equal(cara.inHand, false);
    assert.equal(cara.cards, null);
    assert.equal(cara.bet, 0);
    assert.equal(cara.stack, 0);
    assert.notEqual(v.hand!.sbSeat, cara.seat);
    assert.notEqual(v.hand!.bbSeat, cara.seat);
    assert.equal(v.players.filter((p) => p.inHand).length, 2);
    // She keeps her seat as a watcher, and sees the table but not anyone's hole cards.
    assert.ok(cara.seat !== null);
    assert.equal(seatOf(c.pid!), cara.seat);
    assert.equal(c.view.players.filter((p) => p.cards).length, 0);
    // Play the hand out and wait for the next one.
    let guard = 0;
    while (!a.view.hand!.done && guard++ < 50) {
      if (a.view.hand!.toAct) {
        const x = toActConn(t);
        x.say({ t: 'act', handId: x.view.hand!.id, action: x.view.you_turn!.canCheck ? 'check' : 'call' });
      } else t.advance(2000);
    }
    if (hands === 1) t.advance(8000);
  }
  // Rebuying no longer exists, even for the host.
  c.say({ t: 'rebuy' } as unknown as ClientMsg);
  a.say({ t: 'rebuy' } as unknown as ClientMsg);
  assert.equal(c.view.players.find((p) => p.id === c.pid)!.stack, 0);
  assert.equal(a.view.players.find((p) => p.id === a.pid)!.stack + b.view.players.find((p) => p.id === b.pid)!.stack, 2000);
  assert.equal('allowRebuys' in a.view.settings, false);
  assert.equal('rebuys' in a.view.players[0], false);
});

test('a game saved before rebuys were removed still loads, and the old fields are ignored', () => {
  const t = new Table();
  const a = t.join('Alice');
  t.join('Bob');
  a.say({ t: 'host', op: 'start' });
  const old = JSON.parse(t.saved);
  old.settings.allowRebuys = true;
  for (const p of old.players) p.rebuys = 1;
  const t2 = new Table(old);
  t2.clock = t.clock;
  const a2 = t2.join('Alice', a.welcome!.token);
  assert.equal(a2.view.hand!.id, a.view.hand!.id);
  assert.equal('allowRebuys' in a2.view.settings, false);
  assert.equal('rebuys' in a2.view.players[0], false);
  assert.equal('allowRebuys' in t2.room.state.settings, false);
});
