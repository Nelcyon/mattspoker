import { useMemo, useState } from 'react';
import qrcode from 'qrcode-generator';
import {
  BLIND_MINUTES_OPTIONS,
  type PlayerView,
  type Settings,
  type TableView,
  TURN_SECONDS_OPTIONS,
} from '../shared/protocol.ts';
import type { Send } from './App.tsx';
import { setPref, usePrefs } from './prefs.ts';

const fmt = (n: number) => n.toLocaleString('en-US');

function QR({ text }: { text: string }) {
  const svg = useMemo(() => {
    const q = qrcode(0, 'M');
    q.addData(text);
    q.make();
    return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  }, [text]);
  return <div className="qr" aria-label="QR code to join this game" role="img" dangerouslySetInnerHTML={{ __html: svg }} />;
}

export function SettingsSheet({
  view,
  send,
  onClose,
  onLeave,
}: {
  view: TableView;
  send: Send;
  onClose: () => void;
  onLeave: () => void;
}) {
  const prefs = usePrefs();
  const isHost = view.hostId === view.you;
  const me = view.players.find((p) => p.id === view.you);
  const link = `${location.origin}/${view.code}`;
  const [copied, setCopied] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [showQr, setShowQr] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked */
    }
  };
  const share = async () => {
    try {
      await navigator.share({ title: 'Poker Night', text: `Join my poker game! Code ${view.code}`, url: link });
    } catch {
      /* cancelled */
    }
  };

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet settings" role="dialog" aria-label="Settings" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h2>Settings</h2>
          <button className="btn" onClick={onClose}>
            Done
          </button>
        </div>

        <section className="code-box">
          <div className="lbl">Game code</div>
          <div className="big-code" aria-label={`Game code ${view.code.split('').join(' ')}`}>
            {view.code}
          </div>
          <div className="lbl">
            Friends go to <b>{location.host}</b> and type the code, or open the link.
          </div>
          <div className="row wrap">
            <button className="btn" onClick={copy}>
              {copied ? 'Copied!' : 'Copy link'}
            </button>
            {'share' in navigator && (
              <button className="btn" onClick={share}>
                Share…
              </button>
            )}
            <button className="btn" onClick={() => setShowQr(!showQr)}>
              {showQr ? 'Hide QR code' : 'Show QR code'}
            </button>
          </div>
          {showQr && <QR text={link} />}
        </section>

        <section>
          <h3>On this device</h3>
          <Toggle label="Sounds" on={prefs.sound} set={(v) => setPref('sound', v)} />
          {'vibrate' in navigator && <Toggle label="Vibrate on my turn" on={prefs.vibrate} set={(v) => setPref('vibrate', v)} />}
          {'wakeLock' in navigator && <Toggle label="Keep screen on" on={prefs.keepAwake} set={(v) => setPref('keepAwake', v)} />}
          <Toggle label="Four-colour suits" on={prefs.fourColor} set={(v) => setPref('fourColor', v)} />
          <Toggle label="Larger text and cards" on={prefs.bigText} set={(v) => setPref('bigText', v)} />
        </section>

        {me && me.seat !== null && (
          <section>
            <h3>Me</h3>
            {me.sittingOut ? (
              <button className="btn wide" onClick={() => send({ t: 'sitIn' })}>
                I'm back: deal me in
              </button>
            ) : (
              <button className="btn wide" onClick={() => send({ t: 'sitOut' })}>
                Sit out (keep my seat and chips)
              </button>
            )}
          </section>
        )}

        {view.canClaimHost && (
          <section>
            <h3>Host</h3>
            <p className="muted">The host has been gone for a while.</p>
            <button className="btn wide" onClick={() => send({ t: 'claimHost' })}>
              Become the host
            </button>
          </section>
        )}

        {isHost && <HostControls view={view} send={send} />}

        <section>
          {confirmLeave ? (
            <div className="confirm">
              <p>Leave the table? Your chips are kept if you come back with the same name.</p>
              <div className="row">
                <button className="btn" onClick={() => setConfirmLeave(false)}>
                  Stay
                </button>
                <button className="btn danger" onClick={onLeave}>
                  Leave game
                </button>
              </div>
            </div>
          ) : (
            <button className="btn danger-outline wide" onClick={() => setConfirmLeave(true)}>
              Leave game
            </button>
          )}
        </section>
      </div>
    </div>
  );
}

function Toggle({ label, on, set }: { label: string; on: boolean; set: (v: boolean) => void }) {
  return (
    <label className="toggle-row">
      <span>{label}</span>
      <input type="checkbox" role="switch" checked={on} onChange={(e) => set(e.target.checked)} />
      <span className="switch" aria-hidden />
    </label>
  );
}

function HostControls({ view, send }: { view: TableView; send: Send }) {
  const [s, setS] = useState<Settings>(view.settings);
  const [saved, setSaved] = useState(false);
  const dirty = JSON.stringify(s) !== JSON.stringify(view.settings);
  const num = (k: keyof Settings) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setS({ ...s, [k]: Math.max(0, Math.floor(Number(e.target.value) || 0)) });

  const save = () => {
    if (send({ t: 'host', op: 'settings', settings: s })) {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
  };

  return (
    <section className="host">
      <h3>Host controls</h3>
      <div className="row wrap">
        {!view.started ? (
          <button className="btn primary" onClick={() => send({ t: 'host', op: 'start' })}>
            Start game
          </button>
        ) : view.paused ? (
          <button className="btn primary" onClick={() => send({ t: 'host', op: 'resume' })}>
            Resume game
          </button>
        ) : (
          <button className="btn" onClick={() => send({ t: 'host', op: 'pause' })}>
            Pause game
          </button>
        )}
      </div>

      <div className="form-grid">
        <label>
          <span>Small blind</span>
          <input type="number" inputMode="numeric" min={1} value={s.smallBlind} onChange={num('smallBlind')} />
        </label>
        <label>
          <span>Big blind</span>
          <input type="number" inputMode="numeric" min={1} value={s.bigBlind} onChange={num('bigBlind')} />
        </label>
        <label>
          <span>Starting chips</span>
          <input type="number" inputMode="numeric" min={10} value={s.startingStack} onChange={num('startingStack')} />
        </label>
        <label>
          <span>Turn clock</span>
          <select value={s.turnSeconds} onChange={(e) => setS({ ...s, turnSeconds: Number(e.target.value) })}>
            {TURN_SECONDS_OPTIONS.map((t) => (
              <option key={t} value={t}>
                {t === 0 ? 'None (take your time)' : `${t} seconds`}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Blinds go up</span>
          <select value={s.blindLevelMinutes} onChange={(e) => setS({ ...s, blindLevelMinutes: Number(e.target.value) })}>
            {BLIND_MINUTES_OPTIONS.map((m) => (
              <option key={m} value={m}>
                {m === 0 ? 'Never' : `Every ${m} minutes`}
              </option>
            ))}
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={s.allowRebuys} onChange={(e) => setS({ ...s, allowRebuys: e.target.checked })} />
          <span>Players can buy back in when out of chips</span>
        </label>
      </div>
      <p className="muted small">
        Changes to blinds and chips apply from the next hand. Players who step away are checked or folded after 30 seconds, but keep their seat.
      </p>
      <button className="btn primary wide" disabled={!dirty} onClick={save}>
        {saved ? 'Saved' : 'Save changes'}
      </button>

      <h3>Players</h3>
      <ul className="player-admin">
        {view.players.map((p) => (
          <PlayerAdmin key={p.id} p={p} view={view} send={send} />
        ))}
      </ul>
    </section>
  );
}

function PlayerAdmin({ p, view, send }: { p: PlayerView; view: TableView; send: Send }) {
  const [open, setOpen] = useState(false);
  const [chips, setChips] = useState(String(p.stack));
  const [confirmRemove, setConfirmRemove] = useState(false);
  const isMe = p.id === view.you;
  const theirTurn = view.hand?.toAct === p.id;
  return (
    <li>
      <button className="player-row" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className={`dot ${p.online ? (p.away ? 'away' : 'on') : 'off'}`} aria-hidden />
        <span className="pname">
          {p.name}
          {isMe ? ' (you)' : ''}
          {p.isHost ? ' (host)' : ''}
          {!p.online ? ' · offline' : p.away ? ' · away' : ''}
        </span>
        <span className="pstack">{fmt(p.stack)}</span>
        <span className="chev" aria-hidden>
          {open ? '▴' : '▾'}
        </span>
      </button>
      {open && (
        <div className="player-tools">
          <div className="row">
            <input type="number" inputMode="numeric" value={chips} onChange={(e) => setChips(e.target.value)} aria-label={`Chips for ${p.name}`} />
            <button className="btn" onClick={() => send({ t: 'host', op: 'setStack', pid: p.id, stack: Number(chips) })}>
              Set chips
            </button>
          </div>
          <div className="row wrap">
            {theirTurn && !isMe && (
              <button className="btn" onClick={() => send({ t: 'host', op: 'clock', pid: p.id })}>
                Give 20 seconds to act
              </button>
            )}
            {!isMe && (
              <button className="btn" onClick={() => send({ t: 'host', op: 'makeHost', pid: p.id })}>
                Make host
              </button>
            )}
            {!isMe &&
              (confirmRemove ? (
                <button className="btn danger" onClick={() => send({ t: 'host', op: 'remove', pid: p.id })}>
                  Yes, remove {p.name}
                </button>
              ) : (
                <button className="btn danger-outline" onClick={() => setConfirmRemove(true)}>
                  Remove from game
                </button>
              ))}
          </div>
        </div>
      )}
    </li>
  );
}
