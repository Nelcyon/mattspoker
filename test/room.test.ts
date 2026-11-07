import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type Conn, newRoomState, Room, type RoomState } from '../src/server/room.ts';
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
  wake: number | null = null;
  room: Room;
  constructor(state?: RoomState) {
    this.room = new Room(state ?? newRoomState('ABCD', this.clock), {
      conns: () => this.conns.filter((c) => c.open),
      now: () => this.clock,
      persist: (s) => (this.saved = JSON.stringify(s)),
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
      if (this.wake !== null && this.wake <= this.clock) this.room.tick();
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
