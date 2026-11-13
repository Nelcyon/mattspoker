import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { evaluate } from '../shared/cards.ts';
import { QUICK_REACTIONS, type PlayerView, type TableView } from '../shared/protocol.ts';
import type { Reaction, Send } from './App.tsx';
import { EmptySlot, FlipCard, PlayingCard } from './Card.tsx';
import { HelpCard } from './Help.tsx';
import type { NetStatus } from './net.ts';
import { sounds, unlockAudio } from './prefs.ts';
import { SettingsSheet } from './Settings.tsx';

export function useNow(offset: number, active = true, every = 250) {
  const [now, setNow] = useState(() => Date.now() + offset);
  useEffect(() => {
    if (!active) return;
    setNow(Date.now() + offset);
    const t = setInterval(() => setNow(Date.now() + offset), every);
    return () => clearInterval(t);
  }, [offset, active, every]);
  return now;
}

export function useMedia(q: string) {
  const [m, setM] = useState(() => matchMedia(q).matches);
  useEffect(() => {
    const mq = matchMedia(q);
    const on = () => setM(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [q]);
  return m;
}

const fmt = (n: number) => n.toLocaleString('en-US');

function mmss(ms: number) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** The left half of the table's edge, from the bottom (you) up to the top, as points in % with the distance along it. */
const halfPaths = new Map<string, { x: number; y: number; d: number }[]>();
function halfPath(e: number, ar: number) {
  const key = `${e}:${ar}`;
  let pts = halfPaths.get(key);
  if (pts) return pts;
  pts = [];
  let d = 0;
  for (let i = 0; i <= 120; i++) {
    const a = ((90 + (180 * i) / 120) * Math.PI) / 180;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const x = 50 + 50 * Math.sign(c) * Math.abs(c) ** e;
    const y = 50 + 50 * Math.sign(s) * Math.abs(s) ** e;
    if (i) d += Math.hypot(x - pts[i - 1].x, (y - pts[i - 1].y) * ar);
    pts.push({ x, y, d });
  }
  halfPaths.set(key, pts);
  return pts;
}

/** The point a fraction (0 = bottom, 1 = top) of the way up one side of the table, for equal gaps between seats. */
function edgePoint(frac: number, mirrored: boolean, e: number, ar: number) {
  const pts = halfPath(e, ar);
  const target = frac * pts[pts.length - 1].d;
  let i = 1;
  while (i < pts.length - 1 && pts[i].d < target) i++;
  const p0 = pts[i - 1];
  const p1 = pts[i];
  const k = p1.d > p0.d ? (target - p0.d) / (p1.d - p0.d) : 0;
  const x = p0.x + (p1.x - p0.x) * k;
  return { x: mirrored ? 100 - x : x, y: p0.y + (p1.y - p0.y) * k };
}

/**
 * Where a seat sits on the table, in % of the felt area (you at the bottom, the others spread evenly along the edge, with the
 * spot at the very top kept free for the house dealer), plus the unit vector from the seat towards the middle.
 * `ar` is the height of the table divided by its width.
 */
function seatSpot(index: number, count: number, portrait: boolean, ar: number) {
  // Tall screens use a squarer path so the side seats hug the edges and leave the middle for the cards.
  const e = portrait ? 0.55 : 1;
  let x = 50;
  let y = 100;
  if (index > 0) {
    const others = count - 1;
    const left = Math.ceil(others / 2);
    const p = index <= left ? edgePoint(index / (left + 1), false, e, ar) : edgePoint(1 - (index - left) / (others - left + 1), true, e, ar);
    x = p.x;
    y = p.y;
  }
  const len = Math.hypot(x - 50, y - 50) || 1;
  return { x, y, dx: -(x - 50) / len, dy: -(y - 50) / len };
}

/** A hand that has been turned over at the end of the hand (showdown, or shown after everyone folded) goes out on the felt. */
function isTabled(view: TableView, p: PlayerView) {
  const hand = view.hand;
  if (!hand?.done || !p.inHand || p.folded || !p.cards || p.seat === null) return false;
  // Your own cards are always visible to you, so only count them once you have actually turned them over.
  return p.id !== view.you || !!p.handName || hand.shown.includes(p.id);
}

/** Tabled hands sit on a ring between the seats and the board: this is how far in from the seat they go. */
const RING = { portrait: 0.62, wide: 0.7 };

type Pre = null | 'checkFold' | 'check';

export function TableScreen({
  view,
  send,
  status,
  offset,
  reactions,
  toast,
  onLeave,
}: {
  view: TableView;
  send: Send;
  status: NetStatus;
  offset: number;
  reactions: Reaction[];
  toast: string | null;
  onLeave: () => void;
}) {
  const [sheet, setSheet] = useState<null | 'settings' | 'log' | 'react' | 'help'>(null);
  const [pre, setPre] = useState<Pre>(null);
  const hand = view.hand;
  const me = view.players.find((p) => p.id === view.you) ?? null;
  const isHost = view.hostId === view.you;
  const yourTurn = view.you_turn;
  const needsClock = !!(hand?.actDeadline || view.nextHandAt || view.nextLevelAt);
  const now = useNow(offset, needsClock);
  const portrait = useMedia('(orientation: portrait), (max-height: 520px)');
  // The table's shape (height / width) decides where seats go so they are evenly spaced.
  const wrapRef = useRef<HTMLDivElement>(null);
  const [ar, setAr] = useState(portrait ? 1.5 : 0.45);
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => el.offsetWidth > 0 && setAr(Math.round((el.offsetHeight / el.offsetWidth) * 20) / 20);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ----- your-turn alert, pre-actions -----
  const turnKey = yourTurn && hand ? `${hand.id}:${hand.street}:${hand.currentBet}` : null;
  const lastTurnKey = useRef<string | null>(null);
  useEffect(() => {
    if (!turnKey || turnKey === lastTurnKey.current) {
      if (!turnKey) lastTurnKey.current = null;
      return;
    }
    lastTurnKey.current = turnKey;
    if (pre && yourTurn && hand) {
      const p = pre;
      setPre(null);
      if (p === 'checkFold') {
        send({ t: 'act', handId: hand.id, action: yourTurn.canCheck ? 'check' : 'fold' });
        return;
      }
      if (p === 'check' && yourTurn.canCheck) {
        send({ t: 'act', handId: hand.id, action: 'check' });
        return;
      }
    }
    sounds.yourTurn();
  }, [turnKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Pre-actions only last for one betting round.
  const roundKey = hand ? `${hand.id}:${hand.street}` : '';
  useEffect(() => setPre(null), [roundKey]);

  // Tab title shows when it's your turn (handy on a computer with other windows open).
  useEffect(() => {
    document.title = yourTurn ? '▶ Your turn · Poker Night' : `Poker Night · ${view.code}`;
  }, [!!yourTurn, view.code]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sounds for cards and wins.
  const boardLen = hand?.board.length ?? 0;
  useEffect(() => {
    if (boardLen) sounds.card();
  }, [boardLen]);
  const iWon = !!hand?.done && hand.winners.includes(view.you);
  useEffect(() => {
    if (iWon) sounds.win();
  }, [iWon, hand?.id]);

  // ----- seat layout: everyone seated, in seat order, with you at the bottom -----
  const seated = useMemo(
    () => view.players.filter((p) => p.seat !== null).sort((a, b) => a.seat! - b.seat!),
    [view.players],
  );
  const myIdx = seated.findIndex((p) => p.id === view.you);
  const ordered = myIdx >= 0 ? [...seated.slice(myIdx), ...seated.slice(0, myIdx)] : seated;
  const spectators = view.players.filter((p) => p.seat === null);
  // Hands turned over at the end of the hand, in the order they go out on the table.
  const tabledOrder = new Map(ordered.filter((p) => isTabled(view, p)).map((p, i) => [p.id, i]));

  const toActName = hand?.toAct ? view.players.find((p) => p.id === hand.toAct)?.name : null;
  const myCards = me?.cards ?? null;
  const myHandName = useMemo(() => {
    if (!myCards || !hand) return null;
    if (hand.board.length >= 3) return evaluate([...myCards, ...hand.board]).name;
    if (myCards[0][0] === myCards[1][0]) return evaluate([...myCards]).name.replace('Pair of', 'Pocket');
    return null;
  }, [myCards?.join(), hand?.board.join()]); // eslint-disable-line react-hooks/exhaustive-deps

  let statusLine: string[] = [];
  if (!view.started) {
    const host = view.players.find((p) => p.id === view.hostId);
    statusLine = [isHost ? 'Share the game code, then press Start game.' : `Waiting for ${host?.name ?? 'the host'} to start the game`];
  } else if (view.paused) statusLine = ['Paused by the host'];
  else if (hand?.done) statusLine = hand.summary;
  else if (hand && hand.toAct) statusLine = [hand.toAct === view.you ? 'Your turn' : `${toActName} to act`];
  else if (hand?.runout) statusLine = ['All in: dealing the rest'];
  else if (!hand) statusLine = ['Waiting for at least two players with chips'];

  const says = dealerSays(view);
  // Cards are dealt from the dealer: every card that is dealing in gets the distance back to the dealer to start from.
  const screenRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = screenRef.current;
    const from = root?.querySelector('.dealer-figure')?.getBoundingClientRect();
    if (!root || !from) return;
    const cx = from.left + from.width / 2;
    const cy = from.top + from.height / 2;
    root.querySelectorAll<HTMLElement>('.deal-in').forEach((el) => {
      const r = el.getBoundingClientRect();
      el.style.setProperty('--dx', `${Math.round(cx - (r.left + r.width / 2))}px`);
      el.style.setProperty('--dy', `${Math.round(cy - (r.top + r.height / 2))}px`);
    });
  }, [hand?.id, boardLen]);

  const nextIn = view.nextHandAt ? Math.max(0, view.nextHandAt - now) : null;
  const levelIn = view.nextLevelAt ? view.nextLevelAt - now : null;

  return (
    <div ref={screenRef} className={`table-screen ${yourTurn ? 'my-turn' : ''}`} onPointerDown={unlockAudio}>
      <header className="topbar">
        <div className="top-left">
          <button className="top-btn" onClick={() => setSheet('log')}>
            History
          </button>
          <button className="top-btn" onClick={() => setSheet('help')}>
            Help
          </button>
        </div>
        <div className="blinds">
          <span>
            Blinds <b>{fmt(view.smallBlind)}/{fmt(view.bigBlind)}</b>
          </span>
          {levelIn !== null && <span className="sub">Up in {mmss(levelIn)}</span>}
        </div>
        <button className="top-btn code-btn" onClick={() => setSheet('settings')} aria-label={`Game code ${view.code}. Open settings`}>
          <span className="code">{view.code}</span>
          <span className="lbl">Settings</span>
        </button>
      </header>

      {status !== 'open' && (
        <div className="net-banner" role="status">
          <span className="dot-pulse" aria-hidden /> Reconnecting… your seat is saved
        </div>
      )}
      {toast && (
        <div className="toast" role="alert">
          {toast}
        </div>
      )}

      <section className="table-area">
        <div className="felt-wrap" ref={wrapRef}>
          <div className="felt">
            <div className="center">
              {hand && (
                <div className="pot" aria-live="polite">
                  {!hand.done && hand.totalPot > 0 && <span>Pot {fmt(hand.totalPot)}</span>}
                  {!hand.done && hand.pots.length > 1 && (
                    <span className="side-pots">
                      {hand.pots.map((p, i) => (
                        <span key={i}>{i === 0 ? 'Main' : `Side ${i}`}: {fmt(p)}</span>
                      ))}
                    </span>
                  )}
                </div>
              )}
              <div className="board">
                {[0, 1, 2, 3, 4].map((i) =>
                  hand?.board[i] ? (
                    <PlayingCard
                      key={hand.board[i] + hand.id}
                      card={hand.board[i]}
                      size="md"
                      className="deal-in"
                      style={{ animationDelay: `${i < 3 ? i * 110 : 0}ms` }}
                      highlight={!!hand.done && isInWinningHand(view, hand.board[i])}
                    />
                  ) : (
                    <EmptySlot key={i} size="md" />
                  ),
                )}
              </div>
              <div className={`status-line ${hand?.done ? 'result' : ''}`} aria-live="polite">
                {statusLine.map((l, i) => (
                  <div key={i}>{l}</div>
                ))}
                {nextIn !== null && hand?.done && <div className="sub">Next hand in {Math.ceil(nextIn / 1000)}</div>}
              </div>
            </div>
          </div>
          <Dealer says={says} />
          {ordered.map((p, i) => (
            <Seat
              key={p.id}
              p={p}
              index={i}
              count={ordered.length}
              view={view}
              now={now}
              isMe={p.id === view.you}
              portrait={portrait}
              ar={ar}
              tabledIndex={tabledOrder.get(p.id)}
              reaction={reactions.find((r) => r.pid === p.id)?.text}
            />
          ))}
          {tabledOrder.size > 0 && <TabledHands view={view} ordered={ordered} order={tabledOrder} portrait={portrait} ar={ar} />}
        </div>
        {spectators.length > 0 && (
          <div className="watchers">Watching: {spectators.map((s) => s.name).join(', ')}</div>
        )}
      </section>

      <section className="me-panel">
        <MyHand me={me} view={view} handName={myHandName} />
        <ActionArea
          view={view}
          me={me}
          send={send}
          pre={pre}
          setPre={setPre}
          isHost={isHost}
          onReact={() => setSheet(sheet === 'react' ? null : 'react')}
        />
      </section>

      {sheet === 'react' && (
        <div className="react-pop" role="dialog" aria-label="Send a reaction">
          {QUICK_REACTIONS.map((r) => (
            <button
              key={r}
              onClick={() => {
                send({ t: 'react', text: r });
                setSheet(null);
              }}
            >
              {r}
            </button>
          ))}
        </div>
      )}
      {sheet === 'settings' && <SettingsSheet view={view} send={send} onClose={() => setSheet(null)} onLeave={onLeave} />}
      {sheet === 'log' && <LogSheet view={view} onClose={() => setSheet(null)} />}
      {sheet === 'help' && <HelpCard onClose={() => setSheet(null)} />}
    </div>
  );
}

function isInWinningHand(view: TableView, card: string) {
  const winners = view.hand?.winners ?? [];
  return view.players.some((p) => winners.includes(p.id) && p.best?.includes(card));
}

// ---------------- The house dealer ----------------

/** One short line for the dealer to say, built from what the table already knows (street, winner line). */
function dealerSays(view: TableView) {
  const hand = view.hand;
  if (!view.started) return 'Waiting to start';
  if (view.paused) return 'Paused';
  if (!hand) return 'Waiting for players';
  if (hand.done) {
    // "Sam wins 340 with a flush" becomes "Sam wins 340": the hand name is on their cards.
    const line = (hand.summary[0] ?? 'Hand over').replace(/ with .*$/, '').replace(/ (.*)$/, '');
    return view.players.some((p) => p.handName) ? `Showdown: ${line}` : line;
  }
  return { preflop: 'Dealing', flop: 'Flop', turn: 'Turn', river: 'River' }[hand.street];
}

/** The house dealer sits at the top of the table, opposite you. Every card is dealt from here. */
function Dealer({ says }: { says: string }) {
  return (
    <div className="dealer-seat" aria-label="Dealer">
      <div className="dealer-plate">
        <svg className="dealer-figure" viewBox="0 0 32 32" aria-hidden>
          <circle cx="16" cy="10" r="6" />
          <path d="M4 30c0-7 5-12 12-12s12 5 12 12z" />
          <path className="tie" d="M12.5 19.5 16 22l3.5-2.5v4L16 22l-3.5 2.5z" />
        </svg>
        <span>Dealer</span>
      </div>
      <div className="dealer-says" key={says} role="status">
        {says}
      </div>
    </div>
  );
}

// ---------------- Tabled hands ----------------

/** Where a tabled hand ends up (px from the felt area's top-left) and how far it slides in from its seat. */
type Spot = { x: number; y: number; dx: number; dy: number };
type Box = { l: number; t: number; r: number; b: number };

/**
 * Finds a spot for every tabled hand: start on the ring between the seat and the middle, then push away from anything
 * it would cover (the board, pot, dealer, seats, result text) and from the other hands. Runs once per hand.
 */
function layoutHands(layer: HTMLElement, homes: Map<string, { x: number; y: number }>): { spots: Record<string, Spot>; clean: boolean } {
  const W = layer.offsetWidth;
  const H = layer.offsetHeight;
  const origin = layer.getBoundingClientRect();
  const PAD = 2;
  const box = (r: DOMRect): Box => ({ l: r.left - origin.left - PAD, t: r.top - origin.top - PAD, r: r.right - origin.left + PAD, b: r.bottom - origin.top + PAD });
  const wrap = layer.parentElement!;
  const obstacles: Box[] = [];
  wrap
    .querySelectorAll('.board, .pot > span:first-child, .dealer-seat, .seat .plate, .seat .tag, .seat .roles, .seat:not(.folded) .seat-cards:not(.leaving)')
    .forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) obstacles.push(box(r));
    });
  wrap.querySelectorAll('.status-line > div').forEach((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    for (const r of range.getClientRects()) if (r.width > 0) obstacles.push(box(r));
  });

  const items = [...layer.querySelectorAll<HTMLElement>('.tabled')].flatMap((el) => {
    const home = homes.get(el.dataset.pid ?? '');
    if (!home) return [];
    return [{ id: el.dataset.pid!, on: false, w: el.offsetWidth, h: el.offsetHeight, hx: (home.x / 100) * W, hy: (home.y / 100) * H, x: (home.x / 100) * W, y: (home.y / 100) * H }];
  });
  type Item = (typeof items)[number];
  const bounds = (a: Item): Box => ({ l: a.x - a.w / 2, t: a.y - a.h / 2, r: a.x + a.w / 2, b: a.y + a.h / 2 });
  const overlap = (p: Box, q: Box) => Math.max(0, Math.min(p.r, q.r) - Math.max(p.l, q.l)) * Math.max(0, Math.min(p.b, q.b) - Math.max(p.t, q.t));
  const grow = (m: Box): Box => ({ l: m.l - PAD, t: m.t - PAD, r: m.r + PAD, b: m.b + PAD });
  // What is wrong with hand `a` where it stands: covering things is bad, covering another hand is bad, being far from its seat is a little bad.
  const trouble = (a: Item) => {
    const m = bounds(a);
    let s = 0;
    for (const o of obstacles) s += 20 * overlap(m, o);
    for (const b of items) if (b !== a && b.on) s += 10 * overlap(grow(m), bounds(b));
    s += 0.004 * ((a.x - a.hx) ** 2 + (a.y - a.hy) ** 2);
    return s;
  };
  // First put each hand at the best free spot on a coarse grid (so none starts boxed in by a seat, the result text or the dealer),
  // then polish with simulated annealing.
  for (const a of items) {
    let bestCost = Infinity;
    let bx = a.hx;
    let by = a.hy;
    for (let y = a.h / 2; y <= H - a.h / 2; y += 8) {
      for (let x = a.w / 2; x <= W - a.w / 2; x += 8) {
        a.x = x;
        a.y = y;
        const cost = trouble(a);
        if (cost < bestCost) {
          bestCost = cost;
          bx = x;
          by = y;
        }
      }
    }
    a.x = bx;
    a.y = by;
    a.on = true;
  }
  const start = items.map((a) => ({ x: a.x, y: a.y }));
  // Simulated annealing from a few fixed seeds, keeping the best: the same table always gives the same layout.
  // A few thousand cheap moves, once per hand.
  const total = () => items.reduce((s, a) => s + trouble(a), 0);
  const STEPS = 4000;
  let best: { x: number; y: number }[] | null = null;
  let bestScore = Infinity;
  for (const seed0 of [7, 19, 31, 43]) {
    if (!items.length) break;
    let seed = seed0;
    const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
    items.forEach((a, i) => {
      a.x = start[i].x;
      a.y = start[i].y;
    });
    for (let n = 0; n < STEPS; n++) {
      const k = 1 - n / STEPS;
      const a = items[Math.floor(rnd() * items.length)];
      const before = trouble(a);
      const { x, y } = a;
      const step = 3 + 40 * k;
      a.x = Math.max(a.w / 2, Math.min(W - a.w / 2, x + (rnd() - 0.5) * 2 * step));
      a.y = Math.max(a.h / 2, Math.min(H - a.h / 2, y + (rnd() - 0.5) * 2 * step));
      const delta = trouble(a) - before;
      if (delta > 0 && rnd() > Math.exp(-delta / (1 + 80 * k * k))) {
        a.x = x;
        a.y = y;
      }
    }
    const score = total();
    if (score < bestScore) {
      bestScore = score;
      best = items.map((a) => ({ x: a.x, y: a.y }));
    }
  }
  best?.forEach((p, i) => {
    items[i].x = p.x;
    items[i].y = p.y;
  });
  // Clean means nothing is covered and no two hands touch. If it isn't, the caller can try again with smaller hands.
  const clash = (a: Item) => {
    const m = bounds(a);
    let s = 0;
    for (const o of obstacles) s += overlap(m, o);
    for (const b of items) if (b !== a) s += overlap(m, bounds(b));
    return s;
  };
  const clean = items.every((a) => clash(a) < 1);
  const out: Record<string, Spot> = {};
  for (const a of items) {
    const av = wrap.querySelector(`[data-pid="${a.id}"] .plate`)?.getBoundingClientRect();
    const sx = av ? av.left - origin.left + av.width / 2 : a.x;
    const sy = av ? av.top - origin.top + av.height / 2 : a.y;
    out[a.id] = { x: Math.round(a.x), y: Math.round(a.y), dx: Math.round(sx - a.x), dy: Math.round(sy - a.y) };
  }
  return { spots: out, clean };
}

/** Revealed hands, out on the felt: the cards slide from the seat, flip face-up, and wait under a name pill. */
function TabledHands({
  view,
  ordered,
  order,
  portrait,
  ar,
}: {
  view: TableView;
  ordered: PlayerView[];
  order: Map<string, number>;
  portrait: boolean;
  ar: number;
}) {
  const hand = view.hand!;
  const ring = portrait ? RING.portrait : RING.wide;
  // Past this many hands the cards and pills shrink. Tall phone screens have the least room, so they shrink sooner.
  const baseLevel = order.size > (portrait ? (ar < 1 ? 3 : 4) : 6) ? 1 : 0;
  const layerRef = useRef<HTMLDivElement>(null);
  const [spots, setSpots] = useState<Record<string, Spot>>({});
  // Size level: 0 normal, 1 compact, 2 tight. If a level cannot fit without covering something (10 hands on a small screen),
  // the next smaller one is used for that hand.
  const [bumped, setBumped] = useState<{ key: string; by: number } | null>(null);
  const [size, setSize] = useState('');
  const homes = new Map(
    ordered.map((p, index) => {
      const { x, y } = seatSpot(index, ordered.length, portrait, ar);
      return [p.id, { x: 50 + ring * (x - 50), y: 50 + ring * (y - 50) }] as const;
    }),
  );
  // Start each hand on the ring, then nudge it clear of the board, seats, bets and its neighbours (once per hand, not per frame).
  const key = `${hand.id}:${[...order.keys()].join()}:${portrait}:${ar}:${size}`;
  const level = Math.min(2, baseLevel + (bumped?.key === key ? bumped.by : 0));
  const compact = level >= 1;
  const tight = level >= 2;
  const levelKey = `${key}:${level}`;
  useLayoutEffect(() => {
    if (!layerRef.current) return;
    const { spots: next, clean } = layoutHands(layerRef.current, homes);
    setSpots(next);
    if (!clean && level < 2) setBumped({ key, by: level - baseLevel + 1 });
  }, [levelKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const el = layerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize(`${el.offsetWidth}x${el.offsetHeight}`));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={layerRef} className={`tabled-layer ${compact ? 'compact' : ''} ${tight ? 'tight' : ''}`}>
      {ordered.map((p) => {
        const i = order.get(p.id);
        if (i === undefined || !p.cards) return null;
        const home = homes.get(p.id)!;
        const spot = spots[p.id];
        const winner = hand.winners.includes(p.id);
        return (
          <div
            key={`${hand.id}:${p.id}`}
            data-pid={p.id}
            className={`tabled ${winner ? 'win' : ''}`}
            style={{
              left: spot ? `${spot.x}px` : `${home.x}%`,
              top: spot ? `${spot.y}px` : `${home.y}%`,
              ['--dx' as string]: `${spot?.dx ?? 0}px`,
              ['--dy' as string]: `${spot?.dy ?? 0}px`,
              ['--delay' as string]: `${i * 120}ms`,
            }}
            aria-label={`${p.id === view.you ? 'You' : p.name}${p.handName ? `: ${p.handName}` : ''}${winner && p.won > 0 ? `, won ${fmt(p.won)}` : ''}`}
          >
            <div className="tabled-cards">
              {p.cards.map((c) => (
                <FlipCard key={c} card={c} highlight={winner && !!p.best?.includes(c)} />
              ))}
            </div>
            <div className="tabled-pill">
              <span className="nm">
                {p.id === view.you ? 'You' : p.name}
                {winner && p.won > 0 ? ` won ${fmt(p.won)}` : ''}
              </span>
              {p.handName && <span className="hn">{compact || portrait ? p.handName.split(',')[0] : p.handName}</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------- Seat ----------------

function Seat({
  p,
  index,
  count,
  view,
  now,
  isMe,
  reaction,
  portrait,
  ar,
  tabledIndex,
}: {
  p: PlayerView;
  index: number;
  count: number;
  portrait: boolean;
  /** Height of the table divided by its width. */
  ar: number;
  view: TableView;
  now: number;
  isMe: boolean;
  reaction?: string;
  /** Set when this player's hand has gone out onto the table (and in what order). */
  tabledIndex?: number;
}) {
  const hand = view.hand;
  const { x, y } = seatSpot(index, count, portrait, ar);
  const tabled = tabledIndex !== undefined;
  const toAct = hand?.toAct === p.id;
  const winner = !!hand?.done && hand.winners.includes(p.id);
  let ring: number | null = null;
  if (toAct && hand?.actDeadline) {
    const total = view.settings.turnSeconds > 0 ? view.settings.turnSeconds * 1000 : 30_000;
    ring = Math.max(0, Math.min(1, (hand.actDeadline - now) / total));
  }
  const showCards = p.inHand && !isMe;
  const statusText = !p.online
    ? 'Offline'
    : p.away
      ? 'Away'
      : p.status === 'sittingOut'
        ? 'Sitting out'
        : p.status === 'busted'
          ? 'Out of chips'
          : p.status === 'waiting'
            ? 'Next hand'
            : null;
  // One main label under the name tag, in plain words. A tabled hand shows its hand name and winnings on its own pill out on the felt.
  const posted = !!p.lastAction && /^(Small|Big) blind/.test(p.lastAction);
  let main: { text: string; kind: '' | 'act' | 'win' | 'hand' } | null = null;
  if (toAct) main = { text: isMe ? 'Your turn' : 'To act', kind: 'act' };
  else if (tabled) main = statusText ? { text: statusText, kind: '' } : null;
  else if (winner && p.won > 0) main = { text: `Winner +${fmt(p.won)}`, kind: 'win' };
  else if (p.handName) main = { text: p.handName, kind: 'hand' };
  else if (p.lastAction && !posted) main = { text: p.lastAction, kind: '' };
  else if (posted && p.bet > 0) main = { text: `Posted ${fmt(p.bet)}`, kind: '' };
  else if (statusText) main = { text: statusText, kind: '' };
  // Small plain-word roles: who is paying the blinds this hand, and who is the host.
  const roles: string[] = [];
  if (hand && !hand.done && p.inHand) {
    if (p.seat === hand.sbSeat) roles.push('Small blind');
    if (p.seat === hand.bbSeat) roles.push('Big blind');
  }
  if (p.isHost) roles.push('Host');
  const label = `${p.name}${isMe ? ' (you)' : ''}, ${fmt(p.stack)} chips${p.folded ? ', folded' : ''}${toAct ? ', to act' : ''}${statusText ? `, ${statusText}` : ''}${roles.length ? `, ${roles.join(', ')}` : ''}`;
  return (
    <>
      <div
        data-pid={p.id}
        className={`seat ${isMe ? 'me' : ''} ${y > 85 ? 'low' : ''} ${toAct ? 'to-act' : ''} ${p.folded ? 'folded' : ''} ${winner ? 'winner' : ''} ${
          !p.online || p.away ? 'gone' : ''
        } ${p.inHand ? '' : 'out'}`}
        style={{ left: `${x}%`, top: `${y}%` }}
        aria-label={label}
      >
        {showCards && (
          // Dealt from the dealer at the start of each hand. Face-down cards stay at the seat until the hand is turned over,
          // then they leave as the tabled cards slide out.
          <div
            key={hand?.id}
            className={`seat-cards ${tabled ? 'leaving' : 'deal-in'}`}
            style={{ ['--delay' as string]: `${(tabled ? tabledIndex : 0) * 120}ms`, animationDelay: tabled ? undefined : `${index * 70}ms` }}
          >
            <PlayingCard card={null} size="sm" />
            <PlayingCard card={null} size="sm" />
          </div>
        )}
        <div className="plate">
          <div className="name">{isMe ? 'You' : p.name}</div>
          <div className="stack">{p.allIn && !hand?.done ? 'ALL IN' : fmt(p.stack)}</div>
          {ring !== null && (
            <div className="clock" aria-hidden>
              <i style={{ width: `${ring * 100}%` }} />
            </div>
          )}
        </div>
        {main && <div className={`tag ${main.kind}`}>{main.text}</div>}
        {roles.length > 0 && (
          <div className="roles">
            {roles.map((r) => (
              <span key={r} className="tag role">
                {r}
              </span>
            ))}
          </div>
        )}
        {reaction && (
          <div className="bubble" role="status">
            {reaction}
          </div>
        )}
      </div>
    </>
  );
}

// ---------------- Your cards ----------------

function MyHand({ me, view, handName }: { me: PlayerView | null; view: TableView; handName: string | null }) {
  const hand = view.hand;
  if (!me) return null;
  const inHand = me.inHand && hand;
  return (
    <div className="my-hand">
      <div className={`my-cards ${me.folded ? 'folded' : ''}`}>
        {inHand && me.cards ? (
          me.cards.map((c) => (
            <PlayingCard key={c + hand!.id} card={c} size="lg" className="deal-in" highlight={!!hand?.done && hand.winners.includes(me.id) && !!me.best?.includes(c)} />
          ))
        ) : (
          <>
            <EmptySlot size="lg" />
            <EmptySlot size="lg" />
          </>
        )}
      </div>
      <div className="my-info">
        <div className="my-stack">
          {fmt(me.stack)} <span className="unit">chips</span>
        </div>
        {inHand && !me.folded && handName && <div className="my-hand-name">{handName}</div>}
        {me.folded && hand && !hand.done && <div className="my-hand-name muted">Folded</div>}
      </div>
    </div>
  );
}

// ---------------- Actions ----------------

function ActionArea({
  view,
  me,
  send,
  pre,
  setPre,
  isHost,
  onReact,
}: {
  view: TableView;
  me: PlayerView | null;
  send: Send;
  pre: Pre;
  setPre: (p: Pre) => void;
  isHost: boolean;
  onReact: () => void;
}) {
  const hand = view.hand;
  const yt = view.you_turn;
  const reactBtn = (
    <button className="icon-btn react-btn" onClick={onReact} aria-label="Send a reaction">
      😊
    </button>
  );

  if (!me) return null;

  if (yt && hand) return <TurnControls view={view} yt={yt} send={send} reactBtn={reactBtn} />;

  let content: React.ReactNode = null;
  const freeSeat = () => {
    const taken = new Set(view.players.map((p) => p.seat));
    for (let s = 0; s < 10; s++) if (!taken.has(s)) return s;
    return null;
  };

  if (!view.started) {
    const seatedCount = view.players.filter((p) => p.seat !== null && p.stack > 0).length;
    content = isHost ? (
      <button className="btn primary big grow" disabled={seatedCount < 2} onClick={() => send({ t: 'host', op: 'start' })}>
        {seatedCount < 2 ? 'Waiting for players…' : `Start game (${seatedCount} players)`}
      </button>
    ) : (
      <div className="wait-msg">You're in! The game starts when the host is ready.</div>
    );
  } else if (me.seat === null) {
    const s = freeSeat();
    content =
      s === null ? (
        <div className="wait-msg">The table is full. You're watching.</div>
      ) : (
        <button className="btn primary big grow" onClick={() => send({ t: 'sit', seat: s })}>
          Take a seat
        </button>
      );
  } else if (me.status === 'busted' && !(hand && !hand.done && me.inHand)) {
    content =
      view.settings.allowRebuys || isHost ? (
        <button className="btn primary big grow" onClick={() => send({ t: 'rebuy' })}>
          Buy back in ({fmt(view.settings.startingStack)})
        </button>
      ) : (
        <div className="wait-msg">You're out of chips. Thanks for playing!</div>
      );
  } else if (me.status === 'sittingOut' && !(hand && !hand.done && me.inHand && !me.folded)) {
    content = (
      <button className="btn primary big grow" onClick={() => send({ t: 'sitIn' })}>
        I'm back: deal me in
      </button>
    );
  } else if (hand && hand.done && me.inHand && !hand.shown.includes(me.id) && !me.handName && me.cards) {
    content = (
      <button className="btn big grow" onClick={() => send({ t: 'show' })}>
        Show my cards
      </button>
    );
  } else if (hand && !hand.done && me.inHand && !me.folded && !me.allIn && hand.toAct) {
    content = (
      <div className="pre-actions" role="group" aria-label="Choose ahead of your turn">
        <button className={`toggle ${pre === 'checkFold' ? 'on' : ''}`} aria-pressed={pre === 'checkFold'} onClick={() => setPre(pre === 'checkFold' ? null : 'checkFold')}>
          Check / Fold
        </button>
        <button className={`toggle ${pre === 'check' ? 'on' : ''}`} aria-pressed={pre === 'check'} onClick={() => setPre(pre === 'check' ? null : 'check')}>
          Check
        </button>
      </div>
    );
  } else if (me.status === 'waiting') {
    content = <div className="wait-msg">You'll be dealt in next hand.</div>;
  } else {
    content = <div className="wait-msg">{hand && me.folded && !hand.done ? 'Folded. Next hand soon.' : view.paused ? 'Paused' : ' '}</div>;
  }

  return (
    <div className="actions idle">
      {content}
      {reactBtn}
    </div>
  );
}

function TurnControls({
  view,
  yt,
  send,
  reactBtn,
}: {
  view: TableView;
  yt: NonNullable<TableView['you_turn']>;
  send: Send;
  reactBtn: React.ReactNode;
}) {
  const hand = view.hand!;
  const [raising, setRaising] = useState(false);
  const [confirmFold, setConfirmFold] = useState(false);
  const step = Math.max(1, view.smallBlind);
  const [amount, setAmount] = useState(yt.minRaiseTo);
  const key = `${hand.id}:${hand.street}:${hand.currentBet}`;
  useEffect(() => {
    setRaising(false);
    setConfirmFold(false);
    setAmount(yt.minRaiseTo);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const clamp = (n: number) => Math.max(yt.minRaiseTo, Math.min(yt.maxRaiseTo, Math.round(n)));
  const act = (action: 'fold' | 'check' | 'call' | 'raise', to?: number) => {
    send({ t: 'act', handId: hand.id, action, to });
    setRaising(false);
    setConfirmFold(false);
  };
  const potAfterCall = hand.totalPot + yt.callAmount;
  const preset = (f: number) => {
    const raw = hand.currentBet + f * potAfterCall;
    return clamp(Math.round(raw / step) * step);
  };
  const allInOnly = yt.minRaiseTo >= yt.maxRaiseTo;
  const raiseWord = yt.isBet ? 'Bet' : 'Raise to';
  const callIsAllIn = yt.callAmount > 0 && yt.callAmount >= view.players.find((p) => p.id === view.you)!.stack;

  // Keyboard shortcuts for computers: F fold, C check/call, R raise, Enter confirm, Esc cancel, arrows adjust.
  const stateRef = useRef({ raising, amount, confirmFold });
  stateRef.current = { raising, amount, confirmFold };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const s = stateRef.current;
      const k = e.key.toLowerCase();
      if (k === 'f') {
        if (yt.canCheck && !s.confirmFold) setConfirmFold(true);
        else act('fold');
      } else if (k === 'c' || k === 'k') act(yt.canCheck ? 'check' : 'call');
      else if (k === 'r' || k === 'b') {
        if (yt.canRaise) setRaising(true);
      } else if (k === 'enter' && s.raising) act('raise', s.amount);
      else if (k === 'escape') {
        setRaising(false);
        setConfirmFold(false);
      } else if ((k === 'arrowup' || k === 'arrowright') && s.raising) setAmount((a) => clamp(a + view.bigBlind));
      else if ((k === 'arrowdown' || k === 'arrowleft') && s.raising) setAmount((a) => clamp(a - view.bigBlind));
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  if (confirmFold) {
    return (
      <div className="actions turn">
        <div className="confirm-text">Checking is free. Fold anyway?</div>
        <button className="btn big" onClick={() => setConfirmFold(false)}>
          Cancel
        </button>
        <button className="btn danger big" onClick={() => act('fold')}>
          Fold
        </button>
        <button className="btn primary big" onClick={() => act('check')}>
          Check
        </button>
      </div>
    );
  }

  if (raising) {
    const presets: [string, number][] = allInOnly
      ? []
      : ([
          ['Min', yt.minRaiseTo],
          ['½ pot', preset(0.5)],
          ['¾ pot', preset(0.75)],
          ['Pot', preset(1)],
        ] as [string, number][]);
    return (
      <div className="actions raise-panel" role="dialog" aria-label={yt.isBet ? 'Choose your bet' : 'Choose your raise'}>
        <div className="raise-info">
          <div className="raise-cards">
            {(view.players.find((p) => p.id === view.you)?.cards ?? []).map((c) => (
              <PlayingCard key={c} card={c} size="sm" />
            ))}
          </div>
          <span>
            Pot {fmt(hand.totalPot)}
            {yt.callAmount > 0 ? ` · ${fmt(yt.callAmount)} to call` : ''}
          </span>
        </div>
        <div className="raise-top">
          <button className="btn round" aria-label="Less" onClick={() => setAmount((a) => clamp(a - view.bigBlind))} disabled={amount <= yt.minRaiseTo}>
            −
          </button>
          <div className="raise-amount" aria-live="polite">
            <span className="lbl">{raiseWord.replace(' to', '')}</span>
            <span className="val">{fmt(amount)}</span>
            {amount === yt.maxRaiseTo && <span className="lbl allin">ALL IN</span>}
          </div>
          <button className="btn round" aria-label="More" onClick={() => setAmount((a) => clamp(a + view.bigBlind))} disabled={amount >= yt.maxRaiseTo}>
            +
          </button>
        </div>
        {!allInOnly && (
          <input
            type="range"
            className="slider"
            min={yt.minRaiseTo}
            max={yt.maxRaiseTo}
            step={1}
            value={amount}
            onChange={(e) => setAmount(clamp(Number(e.target.value)))}
            aria-label="Raise amount"
          />
        )}
        <div className="presets">
          {presets.map(([label, v]) => (
            <button key={label} className={`chip-btn ${amount === v ? 'on' : ''}`} onClick={() => setAmount(v)}>
              {label}
            </button>
          ))}
          <button className={`chip-btn ${amount === yt.maxRaiseTo ? 'on' : ''}`} onClick={() => setAmount(yt.maxRaiseTo)}>
            All in
          </button>
        </div>
        <div className="raise-bottom">
          <button className="btn big" onClick={() => setRaising(false)}>
            Back
          </button>
          <button className="btn gold big grow" onClick={() => act('raise', amount)}>
            {amount === yt.maxRaiseTo ? `All in ${fmt(amount)}` : `${raiseWord} ${fmt(amount)}`}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="actions turn">
      <button className="btn danger big" onClick={() => (yt.canCheck ? setConfirmFold(true) : act('fold'))}>
        Fold
      </button>
      {yt.canCheck ? (
        <button className="btn primary big" onClick={() => act('check')}>
          Check
        </button>
      ) : (
        <button className="btn primary big" onClick={() => act('call')}>
          {callIsAllIn ? `All in ${fmt(yt.callAmount)}` : `Call ${fmt(yt.callAmount)}`}
        </button>
      )}
      {yt.canRaise && (
        <button className="btn gold big" onClick={() => setRaising(true)}>
          {allInOnly ? 'All in…' : yt.isBet ? 'Bet…' : 'Raise…'}
        </button>
      )}
      {reactBtn}
    </div>
  );
}

// ---------------- History ----------------

function LogSheet({ view, onClose }: { view: TableView; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollTo(0, ref.current.scrollHeight);
  }, []);
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-label="What happened" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h2>What happened</h2>
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="log" ref={ref}>
          {view.log.map((l, i) => (
            <div key={i} className={l.text.startsWith('Hand ') ? 'log-hand' : ''}>
              <time>{new Date(l.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time> {l.text}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
