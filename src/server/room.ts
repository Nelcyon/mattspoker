// One poker game: its players, seats, settings and the hand in progress.
// The room keeps its whole state in one plain object that the host (Cloudflare Durable Object or the Node server)
// saves after every change, so a restart or redeploy picks up exactly where the game was.
import { type Card } from '../shared/cards.ts';
import {
  act,
  ActionError,
  dealNextStreet,
  foldOutOfTurn,
  type Hand,
  legalActions,
  potsForDisplay,
  startHand,
} from '../shared/holdem.ts';
import {
  AWAY_GRACE_SECONDS,
  BLIND_LEVELS,
  BLIND_MINUTES_OPTIONS,
  type ClientMsg,
  DEFAULT_SETTINGS,
  MAX_SEATS,
  type PlayerStatus,
  type PlayerView,
  QUICK_REACTIONS,
  type ServerMsg,
  type Settings,
  type TableView,
  TURN_SECONDS_OPTIONS,
} from '../shared/protocol.ts';

/** A connection from one browser tab. */
export interface Conn {
  pid: string | null;
  hidden: boolean;
  /** Last time we heard anything from this connection (ms). */
  lastSeen(): number;
  send(msg: ServerMsg): void;
  close(code: number, reason: string): void;
  /** Saves pid/hidden so they survive the host going to sleep. */
  save(): void;
  /** The table this connection was last sent (without the clock). Kept by the Room so it can skip identical sends. */
  lastView?: string;
}

export interface RoomHost {
  /** Open connections to this room. */
  conns(): Conn[];
  now(): number;
  persist(state: RoomState): void;
  /** Ask to be woken (call tick) at this time, or never. */
  wakeAt(at: number | null): void;
}

export interface PlayerRec {
  id: string;
  name: string;
  token: string;
  seat: number | null;
  stack: number;
  sittingOut: boolean;
  /** Turns in a row that were played automatically. */
  timeouts: number;
  rebuys: number;
  /** Chips set by the host while this player was in a hand; applied when it ends. */
  pendingStack: number | null;
  left: boolean;
  /** When this player was last seen without a working, visible connection (ms), or null if here now. */
  awaySince: number | null;
  joinedAt: number;
}

export interface RoomState {
  v: 1;
  code: string;
  createdAt: number;
  lastActivity: number;
  hostId: string | null;
  settings: Settings;
  started: boolean;
  paused: boolean;
  pausedAt: number | null;
  players: PlayerRec[];
  hand: Hand | null;
  handCount: number;
  lastButtonSeat: number;
  turnStartedAt: number | null;
  /** Host started a short clock on the player to act. */
  clockDeadline: number | null;
  dealAt: number | null;
  nextHandAt: number | null;
  level: number;
  levelStartedAt: number | null;
  log: { at: number; text: string }[];
  summary: string[];
}

/** Rooms with nobody around for this long are deleted. */
export const IDLE_DELETE_MS = 3 * 24 * 60 * 60 * 1000;
/** A connection we have not heard from (no heartbeat) for this long is treated as gone. */
export const STALE_MS = 40_000;
/** A connection that already looks dead is re-checked this often (it may have come back without sending anything). */
const PRESENCE_CHECK_MS = 10_000;
/** ...but only for this long after it went quiet; after that a message or a close is what brings it back. */
const STALE_RECHECK_MAX_MS = 3 * 60_000;
/** lastActivity only needs to be right to within this much (rooms are deleted after days). */
const ACTIVITY_BUMP_MS = 10 * 60_000;
const DEAL_DELAY_MS = 900;
const RUNOUT_DELAY_MS = 1700;
const NEXT_HAND_MS = 4000;
const NEXT_HAND_SHOWDOWN_MS = 7000;
const AUTO_SIT_OUT_OFFLINE_MS = 2 * 60_000;
const HOST_CLAIM_MS = 60_000;
const HOST_CLOCK_MS = 20_000;
const LOG_MAX = 60;

const SUIT_SYMBOL: Record<string, string> = { s: '♠', h: '♥', d: '♦', c: '♣' };
const cardText = (c: Card) => (c[0] === 'T' ? '10' : c[0]) + SUIT_SYMBOL[c[1]];

export function randomId(len = 16): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

/** Letters that can't be mistaken for each other or for numbers. */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
export function randomCode(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}
export function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
}
export function isValidCode(code: string): boolean {
  return /^[A-Z]{4}$/.test(code) && [...code].every((c) => CODE_ALPHABET.includes(c));
}

export function cleanName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 16)
    .trim();
}

export function newRoomState(code: string, now: number): RoomState {
  return {
    v: 1,
    code,
    createdAt: now,
    lastActivity: now,
    hostId: null,
    settings: { ...DEFAULT_SETTINGS },
    started: false,
    paused: false,
    pausedAt: null,
    players: [],
    hand: null,
    handCount: 0,
    lastButtonSeat: -1,
    turnStartedAt: null,
    clockDeadline: null,
    dealAt: null,
    nextHandAt: null,
    level: 0,
    levelStartedAt: null,
    log: [],
    summary: [],
  };
}

type Presence = 'online' | 'away' | 'offline';

export class Room {
  private lastReaction = new Map<string, number>();
  /** The state as last handed to host.persist (or known to be saved already), to skip writes that change nothing. */
  private saved: string | null = null;

  state: RoomState;
  private host: RoomHost;

  constructor(state: RoomState, host: RoomHost) {
    this.state = state;
    this.host = host;
  }

  // ---------------- helpers ----------------

  private now() {
    return this.host.now();
  }

  private player(pid: string | null | undefined): PlayerRec | undefined {
    return pid ? this.state.players.find((p) => p.id === pid) : undefined;
  }

  private presence(pid: string): Presence {
    const now = this.now();
    const conns = this.host.conns().filter((c) => c.pid === pid && now - c.lastSeen() < STALE_MS);
    if (conns.length === 0) return 'offline';
    return conns.some((c) => !c.hidden) ? 'online' : 'away';
  }

  private log(text: string) {
    this.state.log.push({ at: this.now(), text });
    if (this.state.log.length > LOG_MAX) this.state.log.splice(0, this.state.log.length - LOG_MAX);
  }

  private handActive(): boolean {
    return !!this.state.hand && this.state.hand.phase !== 'done';
  }

  private handIndex(pid: string): number {
    return this.state.hand ? this.state.hand.seats.findIndex((s) => s.pid === pid) : -1;
  }

  /** Is this player dealt into the hand that is being played right now? */
  private inActiveHand(pid: string): boolean {
    return this.handActive() && this.handIndex(pid) >= 0;
  }

  private blinds(level = this.state.level): { sb: number; bb: number } {
    const m = BLIND_LEVELS[Math.min(level, BLIND_LEVELS.length - 1)];
    return { sb: this.state.settings.smallBlind * m, bb: this.state.settings.bigBlind * m };
  }

  private freeSeat(): number | null {
    const taken = new Set(this.state.players.filter((p) => !p.left && p.seat !== null).map((p) => p.seat));
    for (let s = 0; s < MAX_SEATS; s++) if (!taken.has(s)) return s;
    return null;
  }

  private seatTaken(seat: number): boolean {
    return this.state.players.some((p) => !p.left && p.seat === seat);
  }

  private eligible(): PlayerRec[] {
    return this.state.players.filter((p) => !p.left && p.seat !== null && !p.sittingOut && p.stack > 0);
  }

  // ---------------- entry points ----------------

  /** Handles a message from a connection. */
  message(conn: Conn, raw: string): void {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object' || typeof (msg as { t?: unknown }).t !== 'string') return;
    try {
      if (msg.t === 'join') return this.join(conn, msg);
      const me = this.player(conn.pid);
      if (!me || me.left) {
        conn.send({ t: 'error', message: 'Please join the game first.' });
        return;
      }
      this.handle(conn, me, msg);
    } catch (e) {
      if (e instanceof ActionError) conn.send({ t: 'error', message: e.message });
      else {
        console.error('room error', e);
        conn.send({ t: 'error', message: 'Something went wrong. Please try again.' });
      }
    }
  }

  /** A connection closed or went quiet. */
  disconnect(_conn: Conn): void {
    this.commit();
  }

  /** Called by the host at (or after) the time it asked for, and whenever presence may have changed. */
  tick(): void {
    this.commit();
  }

  /** Time-driven events: dealing the next street, auto-acting for absent players, the next hand. */
  private runTimers() {
    const s = this.state;
    for (let guard = 0; guard < 20; guard++) {
      const now = this.now();
      if (s.paused) return;
      const hand = s.hand;
      if (hand && hand.phase === 'deal' && s.dealAt !== null && now >= s.dealAt) {
        s.dealAt = null;
        dealNextStreet(hand);
        if (hand.board.length) this.log(`${street(hand)}: ${hand.board.map(cardText).join(' ')}`);
        this.afterAction();
        continue;
      }
      const deadline = this.actDeadline();
      if (hand && hand.phase === 'action' && deadline !== null && now >= deadline) {
        this.autoAct();
        continue;
      }
      if ((!hand || hand.phase === 'done') && s.nextHandAt !== null && now >= s.nextHandAt) {
        s.nextHandAt = null;
        this.startNextHand();
        continue;
      }
      return;
    }
  }

  /** When the player to act will be played for automatically, or null. */
  actDeadline(): number | null {
    const s = this.state;
    const hand = s.hand;
    if (!hand || hand.phase !== 'action' || s.paused || s.turnStartedAt === null) return null;
    const pid = hand.seats[hand.toAct].pid;
    const p = this.player(pid);
    const times: number[] = [];
    if (s.settings.turnSeconds > 0) times.push(s.turnStartedAt + s.settings.turnSeconds * 1000);
    if (s.clockDeadline !== null) times.push(s.clockDeadline);
    if (!p || p.left) times.push(s.turnStartedAt);
    else if (p.awaySince !== null) times.push(Math.max(p.awaySince, s.turnStartedAt) + AWAY_GRACE_SECONDS * 1000);
    return times.length ? Math.min(...times) : null;
  }

  private autoAct() {
    const hand = this.state.hand!;
    const i = hand.toAct;
    const seat = hand.seats[i];
    const p = this.player(seat.pid);
    const legal = legalActions(hand, i);
    act(hand, i, { type: legal.canCheck ? 'check' : 'fold' });
    if (p) {
      p.timeouts++;
      this.log(`${p.name} ${legal.canCheck ? 'checked' : 'folded'} automatically (out of time)`);
      if (p.timeouts >= 2 && !p.sittingOut) {
        p.sittingOut = true;
        this.log(`${p.name} is sitting out until they come back`);
      }
    }
    this.afterAction();
  }

  // ---------------- joining ----------------

  private join(conn: Conn, msg: Extract<ClientMsg, { t: 'join' }>) {
    const s = this.state;
    const name = cleanName(msg.name);
    if (!name) {
      conn.send({ t: 'error', message: 'Please type your name.', fatal: 'badName' });
      return;
    }
    let p = typeof msg.token === 'string' && msg.token ? s.players.find((x) => x.token === msg.token) : undefined;
    if (p && p.name.toLowerCase() !== name.toLowerCase()) {
      // Same device, but a different name typed: if that name belongs to someone else, treat as them.
      const other = s.players.find((x) => x.name.toLowerCase() === name.toLowerCase());
      if (other) p = undefined;
      else if (!s.players.some((x) => x !== p && x.name.toLowerCase() === name.toLowerCase())) p.name = name;
    }
    if (!p) {
      const existing = s.players.find((x) => x.name.toLowerCase() === name.toLowerCase());
      if (existing) {
        if (this.presence(existing.id) !== 'offline' && !msg.takeover && !existing.left) {
          conn.send({ t: 'takeoverPrompt', name: existing.name });
          return;
        }
        // Taking the seat back (e.g. the browser was closed). Other devices on this seat are signed out.
        existing.token = randomId(24);
        for (const c of this.host.conns()) {
          if (c.pid === existing.id && c !== conn) {
            c.send({ t: 'replaced' });
            c.pid = null;
            c.save();
            c.close(4001, 'replaced');
          }
        }
        p = existing;
      }
    }
    if (!p) {
      if (s.players.filter((x) => !x.left).length >= 40) {
        conn.send({ t: 'error', message: 'This game is full.', fatal: 'badName' });
        return;
      }
      p = {
        id: randomId(10),
        name,
        token: randomId(24),
        seat: this.freeSeat(),
        stack: s.settings.startingStack,
        sittingOut: false,
        timeouts: 0,
        rebuys: 0,
        pendingStack: null,
        left: false,
        awaySince: null,
        joinedAt: this.now(),
      };
      s.players.push(p);
      this.log(`${name} joined${p.seat === null ? ' (watching: the table is full)' : ''}`);
    } else if (p.left) {
      p.left = false;
      p.seat = this.freeSeat();
      this.log(`${p.name} is back`);
    } else {
      // Coming back after being away resets the auto-play counter, but they stay sitting out until they say so.
      p.timeouts = 0;
    }
    if (!s.hostId || !this.player(s.hostId) || this.player(s.hostId)!.left) s.hostId = p.id;
    conn.pid = p.id;
    conn.hidden = false;
    conn.lastView = undefined; // a (re)join always gets a fresh table
    conn.save();
    conn.send({ t: 'welcome', pid: p.id, token: p.token, code: s.code });
    this.scheduleNextHandIfReady();
    this.commit();
  }

  // ---------------- player and host actions ----------------

  private handle(conn: Conn, me: PlayerRec, msg: ClientMsg) {
    const s = this.state;
    const isHost = s.hostId === me.id;
    switch (msg.t) {
      case 'act': {
        const hand = s.hand;
        if (!hand || hand.id !== msg.handId || hand.phase !== 'action') throw new ActionError('That hand is over.');
        const i = this.handIndex(me.id);
        if (i < 0 || hand.toAct !== i) throw new ActionError("It isn't your turn.");
        const type = msg.action;
        if (type === 'raise') act(hand, i, { type, to: Number(msg.to) });
        else if (type === 'fold' || type === 'check' || type === 'call') act(hand, i, { type });
        else throw new ActionError('Unknown action');
        me.timeouts = 0;
        this.log(`${me.name}: ${hand.seats[i].lastAction}`);
        this.afterAction();
        break;
      }
      case 'visibility':
        conn.hidden = !!msg.hidden;
        conn.save();
        break;
      case 'sitOut':
        if (!me.sittingOut) {
          me.sittingOut = true;
          this.log(`${me.name} is sitting out`);
        }
        break;
      case 'sitIn':
        if (me.seat === null) throw new ActionError('Pick a seat first.');
        me.sittingOut = false;
        me.timeouts = 0;
        this.log(`${me.name} is back in`);
        this.scheduleNextHandIfReady();
        break;
      case 'rebuy':
        if (!s.settings.allowRebuys && !isHost) throw new ActionError('Rebuys are turned off for this game.');
        if (me.stack > 0 || this.inActiveHand(me.id)) throw new ActionError('You can buy back in once you are out of chips.');
        me.stack = s.settings.startingStack;
        me.rebuys++;
        me.sittingOut = false;
        me.timeouts = 0;
        this.log(`${me.name} bought back in for ${me.stack}`);
        this.scheduleNextHandIfReady();
        break;
      case 'sit':
        this.moveSeat(me, msg.seat);
        break;
      case 'leave':
        this.leave(me);
        break;
      case 'show': {
        const hand = s.hand;
        const i = this.handIndex(me.id);
        if (hand && hand.phase === 'done' && i >= 0 && !hand.shown.includes(i)) {
          hand.shown.push(i);
          this.log(`${me.name} shows ${hand.seats[i].cards.map(cardText).join(' ')}`);
        }
        break;
      }
      case 'react': {
        const text = String(msg.text ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 60);
        if (!text) return;
        const last = this.lastReaction.get(me.id) ?? 0;
        if (this.now() - last < 1200) return;
        this.lastReaction.set(me.id, this.now());
        for (const c of this.host.conns()) if (c.pid) c.send({ t: 'reaction', pid: me.id, text });
        if (!QUICK_REACTIONS.includes(text)) this.log(`${me.name}: “${text}”`);
        return; // no state change
      }
      case 'claimHost': {
        const h = this.player(s.hostId);
        const hostGone = !h || h.left || (this.presence(h.id) === 'offline' && h.awaySince !== null && this.now() - h.awaySince >= HOST_CLAIM_MS);
        if (!hostGone) throw new ActionError('The host is still here.');
        s.hostId = me.id;
        this.log(`${me.name} is now the host`);
        break;
      }
      case 'host':
        if (!isHost) throw new ActionError('Only the host can do that.');
        this.hostOp(me, msg);
        break;
      default:
        return;
    }
    this.commit();
  }

  private hostOp(me: PlayerRec, msg: Extract<ClientMsg, { t: 'host' }>) {
    const s = this.state;
    switch (msg.op) {
      case 'start':
        if (s.started) return;
        if (this.eligible().length < 2) throw new ActionError('You need at least two players with seats to start.');
        s.started = true;
        s.levelStartedAt = this.now();
        this.log('The game has started. Good luck!');
        this.startNextHand();
        return;
      case 'pause':
        if (s.paused) return;
        s.paused = true;
        s.pausedAt = this.now();
        this.log('Game paused by the host');
        return;
      case 'resume': {
        if (!s.paused) return;
        const now = this.now();
        const pausedFor = now - (s.pausedAt ?? now);
        s.paused = false;
        s.pausedAt = null;
        if (s.levelStartedAt !== null) s.levelStartedAt += pausedFor;
        if (s.hand?.phase === 'action') this.startTurn();
        if (s.dealAt !== null) s.dealAt = now + DEAL_DELAY_MS;
        if (s.nextHandAt !== null) s.nextHandAt = now + 2500;
        this.log('Game resumed');
        this.scheduleNextHandIfReady();
        return;
      }
      case 'settings':
        this.applySettings(msg.settings ?? {});
        return;
      case 'setStack': {
        const p = this.player(msg.pid);
        const n = Math.floor(Number(msg.stack));
        if (!p || !Number.isFinite(n) || n < 0 || n > 100_000_000) throw new ActionError('Please enter a chip count.');
        if (this.inActiveHand(p.id)) {
          p.pendingStack = n;
          this.log(`${p.name}'s chips will be set to ${n} after this hand`);
        } else {
          p.stack = n;
          this.log(`The host set ${p.name}'s chips to ${n}`);
          this.scheduleNextHandIfReady();
        }
        return;
      }
      case 'remove': {
        const p = this.player(msg.pid);
        if (!p || p.left) return;
        if (p.id === me.id) throw new ActionError("You can't remove yourself. Use Leave game instead.");
        for (const c of this.host.conns()) {
          if (c.pid === p.id) {
            c.send({ t: 'removed' });
            c.pid = null;
            c.save();
            c.close(4002, 'removed');
          }
        }
        this.leave(p, `${p.name} was removed by the host`);
        return;
      }
      case 'makeHost': {
        const p = this.player(msg.pid);
        if (!p || p.left) return;
        s.hostId = p.id;
        this.log(`${p.name} is now the host`);
        return;
      }
      case 'clock': {
        const hand = s.hand;
        if (!hand || hand.phase !== 'action' || hand.seats[hand.toAct].pid !== msg.pid) return;
        s.clockDeadline = this.now() + HOST_CLOCK_MS;
        const p = this.player(msg.pid);
        if (p) this.log(`The host started a ${HOST_CLOCK_MS / 1000}-second clock on ${p.name}`);
        return;
      }
      case 'moveSeat': {
        const p = this.player(msg.pid);
        if (p) this.moveSeat(p, msg.seat);
        return;
      }
    }
  }

  private applySettings(input: Partial<Settings>) {
    const s = this.state;
    const cur = s.settings;
    const next: Settings = { ...cur };
    const int = (v: unknown, min: number, max: number) => {
      const n = Math.floor(Number(v));
      if (!Number.isFinite(n) || n < min || n > max) throw new ActionError('One of those numbers is out of range.');
      return n;
    };
    if (input.startingStack !== undefined) next.startingStack = int(input.startingStack, 10, 10_000_000);
    if (input.smallBlind !== undefined) next.smallBlind = int(input.smallBlind, 1, 1_000_000);
    if (input.bigBlind !== undefined) next.bigBlind = int(input.bigBlind, 1, 2_000_000);
    if (next.bigBlind < next.smallBlind) throw new ActionError('The big blind must be at least the small blind.');
    if (input.turnSeconds !== undefined) {
      const t = Number(input.turnSeconds);
      if (!TURN_SECONDS_OPTIONS.includes(t)) throw new ActionError('Pick one of the turn clock choices.');
      next.turnSeconds = t;
    }
    if (input.blindLevelMinutes !== undefined) {
      const m = Number(input.blindLevelMinutes);
      if (!BLIND_MINUTES_OPTIONS.includes(m)) throw new ActionError('Pick one of the blind timer choices.');
      next.blindLevelMinutes = m;
    }
    if (input.allowRebuys !== undefined) next.allowRebuys = !!input.allowRebuys;

    const changed: string[] = [];
    if (next.smallBlind !== cur.smallBlind || next.bigBlind !== cur.bigBlind) {
      changed.push(`blinds ${next.smallBlind}/${next.bigBlind}`);
      s.level = 0;
      s.levelStartedAt = s.started ? this.now() : null;
    }
    if (next.blindLevelMinutes !== cur.blindLevelMinutes) {
      changed.push(next.blindLevelMinutes ? `blinds go up every ${next.blindLevelMinutes} minutes` : 'blinds stay the same');
      if (s.started) s.levelStartedAt = this.now();
    }
    if (next.startingStack !== cur.startingStack) changed.push(`starting chips ${next.startingStack}`);
    if (next.turnSeconds !== cur.turnSeconds)
      changed.push(next.turnSeconds ? `turn clock ${next.turnSeconds} seconds` : 'no turn clock');
    if (next.allowRebuys !== cur.allowRebuys) changed.push(next.allowRebuys ? 'rebuys on' : 'rebuys off');
    s.settings = next;
    // Before the game starts, everyone gets the new starting stack.
    if (!s.started && next.startingStack !== cur.startingStack)
      for (const p of s.players) if (p.rebuys === 0) p.stack = next.startingStack;
    if (changed.length) this.log(`Host changed: ${changed.join(', ')}`);
  }

  private moveSeat(p: PlayerRec, seat: number) {
    if (!Number.isInteger(seat) || seat < 0 || seat >= MAX_SEATS) throw new ActionError('That seat does not exist.');
    if (this.inActiveHand(p.id)) throw new ActionError('You can change seats after this hand.');
    if (this.seatTaken(seat)) throw new ActionError('That seat is taken.');
    p.seat = seat;
    this.scheduleNextHandIfReady();
  }

  private leave(p: PlayerRec, text = `${p.name} left the table`) {
    const s = this.state;
    const hand = s.hand;
    const i = this.handIndex(p.id);
    if (hand && hand.phase !== 'done' && i >= 0 && !hand.seats[i].folded) {
      const wasToAct = hand.phase === 'action' && hand.toAct === i;
      const before = hand.phase;
      foldOutOfTurn(hand, i);
      if (wasToAct || hand.phase !== before) this.afterAction();
    }
    // Their chips are remembered in case they come back with the same name.
    if (hand && i >= 0) p.stack = hand.seats[i].stack;
    p.left = true;
    p.seat = null;
    p.sittingOut = false;
    this.log(text);
    if (s.hostId === p.id) {
      const next = s.players.find((x) => !x.left && this.presence(x.id) !== 'offline') ?? s.players.find((x) => !x.left);
      s.hostId = next?.id ?? null;
      if (next) this.log(`${next.name} is now the host`);
    }
  }

  // ---------------- hand flow ----------------

  /** After any change to the hand: schedule dealing, start the next player's turn, or finish up. */
  private afterAction(newTurn = true) {
    const s = this.state;
    const hand = s.hand;
    if (!hand) return;
    s.clockDeadline = newTurn ? null : s.clockDeadline;
    if (hand.phase === 'deal') {
      s.turnStartedAt = null;
      s.dealAt = this.now() + (hand.runout ? RUNOUT_DELAY_MS : DEAL_DELAY_MS);
    } else if (hand.phase === 'action') {
      if (newTurn) this.startTurn();
    } else this.finishHand();
  }

  private startTurn() {
    this.state.turnStartedAt = this.now();
    this.state.clockDeadline = null;
  }

  private finishHand() {
    const s = this.state;
    const hand = s.hand!;
    s.turnStartedAt = null;
    s.dealAt = null;
    s.clockDeadline = null;
    const r = hand.result!;
    const name = (i: number) => this.player(hand.seats[i].pid)?.name ?? 'Someone';
    const lines: string[] = [];
    if (r.uncontested) {
      const w = r.pots[0].winners[0];
      lines.push(`${name(w)} wins ${r.pots[0].amount}`);
    } else {
      r.pots.forEach((pot, k) => {
        const label = r.pots.length > 1 ? (k === 0 ? 'Main pot: ' : `Side pot ${r.pots.length > 2 ? k : ''}: `.replace('  ', ' ')) : '';
        if (pot.winners.length === 1) lines.push(`${label}${name(pot.winners[0])} wins ${pot.amount} with ${lower(pot.handName)}`);
        else
          lines.push(
            `${label}${pot.winners.map(name).join(' and ')} split ${pot.amount} (${lower(pot.handName)})`,
          );
      });
    }
    s.summary = lines;
    for (const l of lines) this.log(l);
    // Write chip counts back to the players.
    hand.seats.forEach((seat) => {
      const p = this.player(seat.pid);
      if (!p) return;
      p.stack = seat.stack;
      if (p.pendingStack !== null) {
        p.stack = p.pendingStack;
        p.pendingStack = null;
        this.log(`${p.name}'s chips are now ${p.stack}`);
      }
      if (p.stack === 0 && !p.left) this.log(`${p.name} is out of chips${s.settings.allowRebuys ? ' (they can buy back in)' : ''}`);
    });
    s.lastButtonSeat = hand.buttonSeat;
    s.nextHandAt = this.now() + (r.uncontested ? NEXT_HAND_MS : NEXT_HAND_SHOWDOWN_MS + (hand.runout ? 1000 : 0));
  }

  private scheduleNextHandIfReady() {
    const s = this.state;
    if (!s.started || s.paused || this.handActive() || s.nextHandAt !== null) return;
    if (this.eligible().length >= 2) s.nextHandAt = this.now() + 2500;
  }

  private startNextHand() {
    const s = this.state;
    if (!s.started || s.paused || this.handActive()) return;
    const now = this.now();
    // People who have been gone for a while stop being dealt in (so they don't lose blinds) until they're back.
    for (const p of s.players) {
      if (!p.left && p.seat !== null && !p.sittingOut && p.awaySince !== null && now - p.awaySince > AUTO_SIT_OUT_OFFLINE_MS && this.presence(p.id) === 'offline') {
        p.sittingOut = true;
        this.log(`${p.name} is sitting out (not connected)`);
      }
    }
    const players = this.eligible();
    if (players.length < 2) {
      s.hand = s.hand && s.hand.phase === 'done' ? s.hand : null;
      return;
    }
    // Blinds go up on a timer.
    if (s.settings.blindLevelMinutes > 0 && s.levelStartedAt !== null) {
      const len = s.settings.blindLevelMinutes * 60_000;
      let moved = false;
      while (now >= s.levelStartedAt + len && s.level < BLIND_LEVELS.length - 1) {
        s.level++;
        s.levelStartedAt += len;
        moved = true;
      }
      if (moved) {
        const b = this.blinds();
        this.log(`Blinds are now ${b.sb}/${b.bb}`);
      }
    }
    const { sb, bb } = this.blinds();
    s.handCount++;
    s.summary = [];
    s.hand = startHand(
      s.handCount,
      players.map((p) => ({ pid: p.id, seat: p.seat!, stack: p.stack })),
      s.lastButtonSeat,
      sb,
      bb,
    );
    this.log(`Hand ${s.handCount} (blinds ${sb}/${bb})`);
    this.afterAction();
  }

  // ---------------- presence, saving and sending ----------------

  private refreshPresence() {
    const now = this.now();
    for (const p of this.state.players) {
      const here = this.presence(p.id) === 'online';
      if (here && p.awaySince !== null) p.awaySince = null;
      else if (!here && p.awaySince === null) p.awaySince = now;
    }
  }

  /** Tells the room that its current state is already saved (the host just loaded it, or wrote it itself). */
  markPersisted() {
    this.saved = JSON.stringify(this.state);
  }

  /** Runs timers, saves if anything changed, sends the new table to whoever's view changed, and asks to be woken. */
  commit() {
    const s = this.state;
    this.refreshPresence();
    this.runTimers();
    this.refreshPresence();
    const now = this.now();
    if (now - s.lastActivity >= ACTIVITY_BUMP_MS && this.host.conns().some((c) => c.pid)) s.lastActivity = now;
    const json = JSON.stringify(s);
    if (json !== this.saved) {
      this.saved = json;
      this.host.persist(s);
    }
    this.broadcast();
    this.host.wakeAt(this.nextWake());
  }

  nextWake(): number | null {
    const s = this.state;
    const now = this.now();
    const times: number[] = [s.lastActivity + IDLE_DELETE_MS];
    if (!s.paused) {
      if (s.dealAt !== null) times.push(s.dealAt);
      const d = this.actDeadline();
      if (d !== null) times.push(d);
      if (s.nextHandAt !== null) times.push(s.nextHandAt);
    }
    const live = this.host.conns().filter((c) => c.pid);
    if (live.length > 0) {
      // Wake when the quietest connection would first count as gone, not on a fixed beat. Heartbeats are answered
      // without waking us, so on waking we look again and, if everyone is still fine, sleep until the next one.
      let recheck = false;
      for (const c of live) {
        const seen = c.lastSeen();
        const age = now - seen;
        if (age < STALE_MS) times.push(seen + STALE_MS);
        else if (age < STALE_MS + STALE_RECHECK_MAX_MS) recheck = true;
      }
      if (recheck) times.push(now + PRESENCE_CHECK_MS);
      // The host is gone: the others get "take over as host" once they have been away long enough.
      const h = this.player(s.hostId);
      if (h && !h.left && h.awaySince !== null && this.presence(h.id) === 'offline' && h.awaySince + HOST_CLAIM_MS > now)
        times.push(h.awaySince + HOST_CLAIM_MS);
    }
    return Math.min(...times);
  }

  /** True when nobody has been here for long enough that the game can be thrown away. */
  expired(): boolean {
    return this.now() - this.state.lastActivity >= IDLE_DELETE_MS && !this.host.conns().some((c) => c.pid);
  }

  /** Sends each connection its table, unless it is exactly what that connection already has (apart from the clock). */
  broadcast() {
    const views = new Map<string, { v: TableView; key: string }>();
    for (const c of this.host.conns()) {
      if (!c.pid) continue;
      let e = views.get(c.pid);
      if (!e) {
        const v = this.view(c.pid);
        e = { v, key: JSON.stringify({ ...v, serverTime: 0 }) };
        views.set(c.pid, e);
      }
      if (c.lastView === e.key) continue;
      c.lastView = e.key;
      c.send({ t: 'state', s: e.v });
    }
  }

  view(pid: string): TableView {
    const s = this.state;
    const hand = s.hand;
    const now = this.now();
    const done = hand?.phase === 'done';
    const r = hand?.result ?? null;
    const showdown = done && r && !r.uncontested;
    const winners = new Set<number>();
    if (r) for (const pot of r.pots) for (const w of pot.winners) winners.add(w);

    const players: PlayerView[] = s.players
      .filter((p) => !p.left)
      .map((p) => {
        const i = hand ? hand.seats.findIndex((x) => x.pid === p.id) : -1;
        const hs = i >= 0 ? hand!.seats[i] : null;
        const pres = this.presence(p.id);
        let status: PlayerStatus;
        if (p.seat === null) status = 'spectating';
        else if (hs && !done) status = 'playing';
        else if (p.stack <= 0 && !hs) status = 'busted';
        else if (hs && done && hs.stack === 0) status = 'busted';
        else if (p.sittingOut) status = 'sittingOut';
        else status = s.started && !hs ? 'waiting' : 'playing';
        const reveal =
          hs && (p.id === pid || (showdown && !hs.folded) || hand!.shown.includes(i));
        return {
          id: p.id,
          name: p.name,
          seat: p.seat,
          stack: hs && !done ? hs.stack : p.stack,
          status,
          sittingOut: p.sittingOut,
          online: pres !== 'offline',
          away: pres === 'away',
          isHost: s.hostId === p.id,
          inHand: !!hs,
          bet: hs && !done ? hs.committed : 0,
          folded: !!hs?.folded,
          allIn: !!hs?.allIn,
          cards: reveal ? hs!.cards : null,
          lastAction: hs && !done ? hs.lastAction : null,
          won: done && r ? (r.won[i] ?? 0) : 0,
          handName: showdown && hs && !hs.folded ? (r!.hands[i]?.name ?? null) : null,
          best: showdown && hs && !hs.folded ? (r!.hands[i]?.best ?? null) : null,
          rebuys: p.rebuys,
        };
      });

    let yourTurn: TableView['you_turn'] = null;
    if (hand && hand.phase === 'action' && hand.seats[hand.toAct].pid === pid && !s.paused) {
      const l = legalActions(hand, hand.toAct);
      yourTurn = {
        canCheck: l.canCheck,
        callAmount: l.callAmount,
        canRaise: l.canRaise,
        minRaiseTo: l.minRaiseTo,
        maxRaiseTo: l.maxRaiseTo,
        isBet: l.isBet,
        committed: hand.seats[hand.toAct].committed,
      };
    }
    const host = this.player(s.hostId);
    const canClaimHost =
      !!host && host.id !== pid && (host.left || (this.presence(host.id) === 'offline' && host.awaySince !== null && now - host.awaySince >= HOST_CLAIM_MS));
    const { sb, bb } = this.blinds();
    const lvlLen = s.settings.blindLevelMinutes * 60_000;
    return {
      code: s.code,
      you: pid,
      hostId: s.hostId,
      settings: s.settings,
      started: s.started,
      paused: s.paused,
      players,
      smallBlind: sb,
      bigBlind: bb,
      blindLevel: s.level,
      nextLevelAt:
        s.started && !s.paused && lvlLen > 0 && s.levelStartedAt !== null && s.level < BLIND_LEVELS.length - 1
          ? s.levelStartedAt + lvlLen
          : null,
      hand: hand
        ? {
            id: hand.id,
            street: hand.street,
            board: hand.board,
            pots: done ? [] : potsForDisplay(hand).map((p) => p.amount),
            totalPot: hand.seats.reduce((a, x) => a + x.total, 0),
            currentBet: hand.currentBet,
            buttonSeat: hand.buttonSeat,
            sbSeat: hand.seats[hand.sbIndex].seat,
            bbSeat: hand.seats[hand.bbIndex].seat,
            toAct: hand.phase === 'action' ? hand.seats[hand.toAct].pid : null,
            actDeadline: this.actDeadline(),
            done: !!done,
            runout: hand.runout,
            summary: done ? s.summary : [],
            winners: done ? [...winners].map((w) => hand.seats[w].pid) : [],
            shown: hand.shown.map((i) => hand.seats[i].pid),
          }
        : null,
      you_turn: yourTurn,
      nextHandAt: s.paused ? null : s.nextHandAt,
      log: s.log.slice(-40),
      serverTime: now,
      canClaimHost,
    };
  }
}

function street(hand: Hand) {
  return hand.street === 'flop' ? 'Flop' : hand.street === 'turn' ? 'Turn' : 'River';
}

function lower(name: string | null) {
  if (!name) return 'the best hand';
  return name[0].toLowerCase() + name.slice(1);
}
