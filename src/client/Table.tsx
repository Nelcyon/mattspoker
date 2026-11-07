import { useEffect, useMemo, useRef, useState } from 'react';
import { evaluate } from '../shared/cards.ts';
import { QUICK_REACTIONS, type PlayerView, type TableView } from '../shared/protocol.ts';
import type { Reaction, Send } from './App.tsx';
import { EmptySlot, PlayingCard } from './Card.tsx';
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

const AVATAR_COLORS = ['#e76f51', '#2a9d8f', '#e9c46a', '#8ab17d', '#9b5de5', '#f15bb5', '#00bbf9', '#f4a261', '#43aa8b', '#ef476f'];
function colorFor(name: string) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

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
  const [sheet, setSheet] = useState<null | 'settings' | 'log' | 'react'>(null);
  const [pre, setPre] = useState<Pre>(null);
  const hand = view.hand;
  const me = view.players.find((p) => p.id === view.you) ?? null;
  const isHost = view.hostId === view.you;
  const yourTurn = view.you_turn;
  const needsClock = !!(hand?.actDeadline || view.nextHandAt || view.nextLevelAt);
  const now = useNow(offset, needsClock);
  const portrait = useMedia('(orientation: portrait), (max-height: 520px)');

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

  const nextIn = view.nextHandAt ? Math.max(0, view.nextHandAt - now) : null;
  const levelIn = view.nextLevelAt ? view.nextLevelAt - now : null;

  return (
    <div className={`table-screen ${yourTurn ? 'my-turn' : ''}`} onPointerDown={unlockAudio}>
      <header className="topbar">
        <button className="icon-btn" onClick={() => setSheet('log')} aria-label="Hand history">
          <svg viewBox="0 0 24 24" aria-hidden>
            <path d="M4 6h16M4 12h16M4 18h10" />
          </svg>
        </button>
        <div className="blinds">
          <span>
            Blinds <b>{fmt(view.smallBlind)}/{fmt(view.bigBlind)}</b>
          </span>
          {levelIn !== null && <span className="sub">Up in {mmss(levelIn)}</span>}
        </div>
        <button className="code-btn" onClick={() => setSheet('settings')} aria-label={`Game code ${view.code}. Open settings`}>
          <span className="code">{view.code}</span>
          <svg viewBox="0 0 24 24" aria-hidden>
            <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
          </svg>
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
        <div className="felt-wrap">
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
              reaction={reactions.find((r) => r.pid === p.id)?.text}
            />
          ))}
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
    </div>
  );
}

function isInWinningHand(view: TableView, card: string) {
  const winners = view.hand?.winners ?? [];
  return view.players.some((p) => winners.includes(p.id) && p.best?.includes(card));
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
}: {
  p: PlayerView;
  index: number;
  count: number;
  portrait: boolean;
  view: TableView;
  now: number;
  isMe: boolean;
  reaction?: string;
}) {
  const hand = view.hand;
  // Angle 90° is the bottom of the table; go clockwise.
  const angle = ((90 + (index * 360) / count) * Math.PI) / 180;
  // Tall screens use a squarer path so the side seats hug the edges and leave the middle for the cards.
  const e = portrait ? 0.55 : 1;
  const c = Math.cos(angle);
  const sn = Math.sin(angle);
  const x = 50 + 50 * Math.sign(c) * Math.abs(c) ** e;
  const y = 50 + 50 * Math.sign(sn) * Math.abs(sn) ** e;
  // Unit vector from the seat towards the middle, for the bet and the dealer button.
  const len = Math.hypot(x - 50, y - 50) || 1;
  const dx = -(x - 50) / len;
  const dy = -(y - 50) / len;
  const at = (k: number, side = 0) => ({
    left: `calc(${x}% + ${(dx * k - dy * side).toFixed(3)} * var(--offx))`,
    top: `calc(${y}% + ${(dy * k + dx * side).toFixed(3)} * var(--offy))`,
  });
  const toAct = hand?.toAct === p.id;
  const isDealer = hand && p.seat === hand.buttonSeat;
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
  const label = `${p.name}${isMe ? ' (you)' : ''}, ${fmt(p.stack)} chips${p.folded ? ', folded' : ''}${toAct ? ', to act' : ''}${statusText ? `, ${statusText}` : ''}`;
  return (
    <>
      <div
        className={`seat ${isMe ? 'me' : ''} ${toAct ? 'to-act' : ''} ${p.folded ? 'folded' : ''} ${winner ? 'winner' : ''} ${
          !p.online || p.away ? 'gone' : ''
        } ${p.inHand ? '' : 'out'}`}
        style={{ left: `${x}%`, top: `${y}%` }}
        aria-label={label}
      >
        {showCards && (
          <div className={`seat-cards ${p.cards ? 'shown' : ''}`}>
            {p.cards ? (
              p.cards.map((c) => <PlayingCard key={c} card={c} size="sm" highlight={winner && !!p.best?.includes(c)} />)
            ) : (
              <>
                <PlayingCard card={null} size="sm" />
                <PlayingCard card={null} size="sm" />
              </>
            )}
          </div>
        )}
        <div
          className="avatar"
          style={{ ['--c' as string]: colorFor(p.name), ['--ring' as string]: ring === null ? 1 : ring }}
          data-ring={ring !== null}
        >
          <span>{p.name.slice(0, 1).toUpperCase()}</span>
          {p.isHost && (
            <span className="host-badge" title="Host" aria-hidden>
              ★
            </span>
          )}
        </div>
        <div className="plate">
          <div className="name">{isMe ? 'You' : p.name}</div>
          <div className="stack">{p.allIn && !hand?.done ? 'ALL IN' : fmt(p.stack)}</div>
        </div>
        {(statusText || p.lastAction || p.handName || (winner && p.won > 0)) && (
          <div className={`tag ${winner ? 'win' : ''}`}>
            {winner && p.won > 0 ? `+${fmt(p.won)}` : p.handName ?? (p.lastAction && !p.lastAction.startsWith('Small') && !p.lastAction.startsWith('Big') ? p.lastAction : statusText ?? p.lastAction)}
          </div>
        )}
        {winner && p.handName && <div className="tag hand-name">{p.handName}</div>}
        {reaction && (
          <div className="bubble" role="status">
            {reaction}
          </div>
        )}
      </div>
      {p.bet > 0 && (
        <div className="bet" style={at(1)}>
          <span className="chip" aria-hidden />
          {fmt(p.bet)}
        </div>
      )}
      {isDealer && (
        <div
          className="dealer"
          style={at(0.62, 0.62)}
          aria-label="Dealer button"
        >
          D
        </div>
      )}
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
          <span className="chip" aria-hidden /> {fmt(me.stack)}
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
