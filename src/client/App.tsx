import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClientMsg, ServerMsg, TableView } from '../shared/protocol.ts';
import { Connection, lastGame, loadSaved, type NetStatus, storeSaved } from './net.ts';
import { HelpCard } from './Help.tsx';
import { keepAwake, unlockAudio, usePrefs } from './prefs.ts';
import { TableScreen } from './Table.tsx';

const CODE_RE = /^\/([A-Za-z]{4})\/?$/;

function codeFromPath(): string | null {
  const m = location.pathname.match(CODE_RE);
  return m ? m[1].toUpperCase() : null;
}

function savedName() {
  try {
    return localStorage.getItem('pn:name') ?? '';
  } catch {
    return '';
  }
}

export function App() {
  const prefs = usePrefs();
  const [route, setRoute] = useState<{ code: string; name: string } | null>(() => {
    const code = codeFromPath();
    if (!code) return null;
    const s = loadSaved(code);
    return s ? { code, name: s.name } : null;
  });
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    document.documentElement.classList.toggle('big-text', prefs.bigText);
    document.documentElement.classList.toggle('four-color', prefs.fourColor);
  }, [prefs.bigText, prefs.fourColor]);

  useEffect(() => {
    const onPop = () => {
      const code = codeFromPath();
      const s = code ? loadSaved(code) : null;
      setRoute(code && s ? { code, name: s.name } : null);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const enter = (code: string, name: string) => {
    try {
      localStorage.setItem('pn:name', name);
    } catch {
      /* ignore */
    }
    if (location.pathname !== `/${code}`) history.pushState(null, '', `/${code}`);
    setNotice(null);
    setRoute({ code, name });
  };

  const exit = (message?: string, forget = false) => {
    if (forget && route) storeSaved(route.code, null);
    setNotice(message ?? null);
    setRoute(null);
    if (location.pathname !== '/') history.pushState(null, '', forget ? '/' : location.pathname);
  };

  if (route) return <Game key={route.code + route.name} code={route.code} name={route.name} onExit={exit} keepScreenOn={prefs.keepAwake} />;
  return <Home onEnter={enter} notice={notice} />;
}

// ---------------- Home: join or start ----------------

function Home({ onEnter, notice }: { onEnter: (code: string, name: string) => void; notice: string | null }) {
  const pathCode = codeFromPath();
  const [mode, setMode] = useState<'join' | 'new'>(pathCode ? 'join' : 'join');
  const [code, setCode] = useState(pathCode ?? '');
  const [name, setName] = useState(savedName());
  const [error, setError] = useState<string | null>(notice);
  const [busy, setBusy] = useState(false);
  const [help, setHelp] = useState(false);
  const last = lastGame();
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => setError(notice), [notice]);
  useEffect(() => {
    if (pathCode && nameRef.current && !name) nameRef.current.focus();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const cleanCode = code.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  const cleanName = name.replace(/\s+/g, ' ').trim().slice(0, 16);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    unlockAudio();
    if (!cleanName) return setError('Please type your name.');
    setBusy(true);
    setError(null);
    try {
      if (mode === 'new') {
        const res = await fetch('/api/create', { method: 'POST' });
        const body = await res.json();
        if (!res.ok || !body.code) throw new Error(body.error ?? 'Could not start a game.');
        onEnter(body.code, cleanName);
      } else {
        if (cleanCode.length !== 4) {
          setBusy(false);
          return setError('The game code is 4 letters.');
        }
        const res = await fetch(`/api/game/${cleanCode}`);
        const body = await res.json();
        if (!body.exists) {
          setBusy(false);
          return setError(`There's no game with the code ${cleanCode}. Check the code with the host.`);
        }
        onEnter(cleanCode, cleanName);
      }
    } catch (err) {
      setError(err instanceof Error && err.message !== 'Failed to fetch' ? err.message : "Couldn't reach the server. Check your internet and try again.");
      setBusy(false);
    }
  }

  return (
    <main className="home">
      <div className="home-card">
        <div className="logo" aria-hidden>
          <span className="suit-s">♠</span>
          <span className="suit-h">♥</span>
          <span className="suit-c">♣</span>
          <span className="suit-d">♦</span>
        </div>
        <h1>Poker Night</h1>
        <p className="tagline">Texas Hold'em with friends, on any phone or computer.</p>

        {last && last.code !== pathCode && (
          <button className="btn rejoin" onClick={() => onEnter(last.code, last.name)}>
            Back to game <b>{last.code}</b> as {last.name}
          </button>
        )}

        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={mode === 'join'} className={mode === 'join' ? 'on' : ''} onClick={() => setMode('join')}>
            Join a game
          </button>
          <button role="tab" aria-selected={mode === 'new'} className={mode === 'new' ? 'on' : ''} onClick={() => setMode('new')}>
            Start a new game
          </button>
        </div>

        <form onSubmit={submit} className="home-form">
          {mode === 'join' && (
            <label>
              <span>Game code</span>
              <input
                className="code-input"
                value={cleanCode}
                onChange={(e) => setCode(e.target.value)}
                placeholder="ABCD"
                autoCapitalize="characters"
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                inputMode="text"
                maxLength={4}
                aria-label="Game code"
              />
            </label>
          )}
          <label>
            <span>Your name</span>
            <input
              ref={nameRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Name"
              maxLength={16}
              autoComplete="nickname"
              enterKeyHint="go"
              aria-label="Your name"
            />
          </label>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button className="btn primary big" disabled={busy}>
            {busy ? 'One moment…' : mode === 'join' ? 'Join game' : 'Start game'}
          </button>
          <p className="hint">
            {mode === 'join'
              ? 'Closed the page by accident? Join again with the same code and name and you get your seat and chips back.'
              : "You'll get a 4-letter code to share. You're the host: you choose the blinds and starting chips."}
          </p>
        </form>
        <button type="button" className="help-link" onClick={() => setHelp(true)}>
          Help
        </button>
      </div>
      {help && <HelpCard onClose={() => setHelp(false)} />}
    </main>
  );
}

// ---------------- Game: connection + table ----------------

export type Send = (msg: ClientMsg) => boolean;
export interface Reaction {
  id: number;
  pid: string;
  text: string;
}

function Game({
  code,
  name,
  onExit,
  keepScreenOn,
}: {
  code: string;
  name: string;
  onExit: (message?: string, forget?: boolean) => void;
  keepScreenOn: boolean;
}) {
  const [view, setView] = useState<TableView | null>(null);
  const [status, setStatus] = useState<NetStatus>('connecting');
  const [prompt, setPrompt] = useState<'takeover' | 'replaced' | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [reactions, setReactions] = useState<Reaction[]>([]);
  const [offset, setOffset] = useState(0);
  const conn = useRef<Connection | null>(null);
  const reactionId = useRef(0);

  useEffect(() => {
    const c = new Connection(
      code,
      name,
      (m: ServerMsg) => {
        switch (m.t) {
          case 'state':
            setView(m.s);
            setOffset(m.s.serverTime - Date.now());
            setPrompt((p) => (p === 'takeover' ? null : p));
            break;
          case 'takeoverPrompt':
            setPrompt('takeover');
            break;
          case 'replaced':
            setPrompt('replaced');
            break;
          case 'removed':
            onExit('The host removed you from the game.', true);
            break;
          case 'error':
            if (m.fatal === 'noGame') onExit(`The game ${code} has ended or doesn't exist.`, true);
            else if (m.fatal) onExit(m.message);
            else {
              setToast(m.message);
            }
            break;
          case 'reaction': {
            const id = ++reactionId.current;
            setReactions((r) => [...r.filter((x) => x.pid !== m.pid), { id, pid: m.pid, text: m.text }]);
            setTimeout(() => setReactions((r) => r.filter((x) => x.id !== id)), 3500);
            break;
          }
        }
      },
      setStatus,
    );
    conn.current = c;
    return () => c.destroy();
  }, [code, name]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  // Keep the screen awake while at the table (re-acquire after coming back to the page).
  useEffect(() => {
    void keepAwake(keepScreenOn);
    const again = () => void keepAwake(keepScreenOn && document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', again);
    return () => {
      document.removeEventListener('visibilitychange', again);
      void keepAwake(false);
    };
  }, [keepScreenOn]);

  const send: Send = useCallback((msg) => {
    const ok = conn.current?.send(msg) ?? false;
    if (!ok) setToast('Reconnecting… try again in a moment.');
    return ok;
  }, []);

  const leave = () => {
    send({ t: 'leave' });
    setTimeout(() => onExit(undefined, true), 150);
  };

  if (prompt === 'takeover' || prompt === 'replaced') {
    return (
      <main className="home">
        <div className="home-card">
          {prompt === 'takeover' ? (
            <>
              <h2>Is that you, {name}?</h2>
              <p>
                Someone called <b>{name}</b> is already at this table on another phone or computer.
              </p>
              <button className="btn primary big" onClick={() => conn.current?.takeOver()}>
                Yes, it's me: play on this device
              </button>
              <button className="btn big" onClick={() => onExit('Pick a different name so people can tell you apart.')}>
                No, I'll use a different name
              </button>
            </>
          ) : (
            <>
              <h2>You're playing on another device</h2>
              <p>Your seat was opened somewhere else, so this screen stopped. Your chips are safe.</p>
              <button
                className="btn primary big"
                onClick={() => {
                  setPrompt(null);
                  conn.current?.takeOver();
                }}
              >
                Play on this device instead
              </button>
              <button className="btn big" onClick={() => onExit()}>
                Back to start
              </button>
            </>
          )}
        </div>
      </main>
    );
  }

  if (!view) {
    return (
      <main className="home">
        <div className="home-card center">
          <div className="spinner" aria-hidden />
          <p>{status === 'reconnecting' ? 'Trying to reach the game…' : `Joining game ${code}…`}</p>
          <button className="btn" onClick={() => onExit()}>
            Cancel
          </button>
        </div>
      </main>
    );
  }

  return (
    <TableScreen
      view={view}
      send={send}
      status={status}
      offset={offset}
      reactions={reactions}
      toast={toast}
      onLeave={leave}
    />
  );
}
