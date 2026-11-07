// Keeps one connection to the game alive through phones sleeping, switching apps, flaky Wi-Fi and server restarts.
import type { ClientMsg, ServerMsg } from '../shared/protocol.ts';

export type NetStatus = 'connecting' | 'open' | 'reconnecting' | 'stopped';

export interface Saved {
  token?: string;
  name: string;
}

const KEY = (code: string) => `pn:game:${code}`;

export function loadSaved(code: string): Saved | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY(code)) ?? 'null');
    return v && typeof v.name === 'string' ? v : null;
  } catch {
    return null;
  }
}

export function storeSaved(code: string, s: Saved | null) {
  try {
    if (s) localStorage.setItem(KEY(code), JSON.stringify(s));
    else localStorage.removeItem(KEY(code));
    if (s) localStorage.setItem('pn:last', JSON.stringify({ code, at: Date.now() }));
    else localStorage.removeItem('pn:last');
  } catch {
    /* private mode */
  }
}

export function lastGame(): { code: string; name: string } | null {
  try {
    const v = JSON.parse(localStorage.getItem('pn:last') ?? 'null');
    if (!v || Date.now() - v.at > 24 * 3600_000) return null;
    const s = loadSaved(v.code);
    return s ? { code: v.code, name: s.name } : null;
  } catch {
    return null;
  }
}

const PING_EVERY = 6_000;
const DEAD_AFTER = 15_000;

export class Connection {
  status: NetStatus = 'connecting';
  private ws: WebSocket | null = null;
  private stopped = false;
  private attempt = 0;
  private lastHeard = 0;
  private pingTimer: number | undefined;
  private retryTimer: number | undefined;
  private takeover = false;
  private code: string;
  private name: string;
  private onMessage: (m: ServerMsg) => void;
  private onStatus: (s: NetStatus) => void;

  constructor(code: string, name: string, onMessage: (m: ServerMsg) => void, onStatus: (s: NetStatus) => void) {
    this.code = code;
    this.name = name;
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('online', this.reconnectNow);
    window.addEventListener('pageshow', this.onPageShow);
    window.addEventListener('focus', this.checkAlive);
    this.open();
  }

  private setStatus(s: NetStatus) {
    if (this.status === s) return;
    this.status = s;
    this.onStatus(s);
  }

  private open() {
    if (this.stopped) return;
    clearTimeout(this.retryTimer);
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws/${this.code}`);
    this.ws = ws;
    this.lastHeard = Date.now();
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.attempt = 0;
      this.lastHeard = Date.now();
      const saved = loadSaved(this.code);
      const msg: ClientMsg = { t: 'join', name: this.name, token: saved?.token, takeover: this.takeover || undefined };
      ws.send(JSON.stringify(msg));
      if (document.visibilityState === 'hidden') ws.send(JSON.stringify({ t: 'visibility', hidden: true }));
      clearInterval(this.pingTimer);
      this.pingTimer = window.setInterval(() => this.ping(), PING_EVERY);
    };
    ws.onmessage = (e) => {
      if (this.ws !== ws) return;
      this.lastHeard = Date.now();
      if (e.data === 'pong') return;
      let msg: ServerMsg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.t === 'welcome') {
        this.takeover = false;
        storeSaved(this.code, { token: msg.token, name: this.name });
        this.setStatus('open');
      }
      if (msg.t === 'state' && this.status !== 'open') this.setStatus('open');
      if (msg.t === 'replaced' || msg.t === 'removed' || (msg.t === 'error' && msg.fatal)) this.stop();
      this.onMessage(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      clearInterval(this.pingTimer);
      if (this.stopped) return;
      this.setStatus('reconnecting');
      const delay = Math.min(5000, 400 * 2 ** this.attempt++) + Math.random() * 300;
      this.retryTimer = window.setTimeout(() => this.open(), delay);
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  private ping() {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (Date.now() - this.lastHeard > DEAD_AFTER) {
      // The connection died quietly (common after a phone sleeps). Start over.
      this.drop();
      return;
    }
    try {
      ws.send('ping');
    } catch {
      this.drop();
    }
  }

  /** Throws away the current socket and connects again straight away. */
  private drop() {
    const ws = this.ws;
    this.ws = null;
    clearInterval(this.pingTimer);
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
    if (this.stopped) return;
    this.setStatus('reconnecting');
    this.attempt = 0;
    this.open();
  }

  reconnectNow = () => {
    if (this.stopped) return;
    if (!this.ws || this.ws.readyState === WebSocket.CLOSED || this.ws.readyState === WebSocket.CLOSING) this.drop();
    else this.checkAlive();
  };

  private checkAlive = () => {
    const ws = this.ws;
    if (this.stopped) return;
    if (!ws) return this.drop();
    if (ws.readyState === WebSocket.OPEN) {
      // Prove the connection still works; if nothing comes back soon, reconnect.
      const before = this.lastHeard;
      try {
        ws.send('ping');
      } catch {
        return this.drop();
      }
      window.setTimeout(() => {
        if (this.ws === ws && this.lastHeard === before) this.drop();
      }, 3000);
    }
  };

  private onVisibility = () => {
    const hidden = document.visibilityState === 'hidden';
    this.send({ t: 'visibility', hidden });
    if (!hidden) this.reconnectNow();
  };

  private onPageShow = (e: PageTransitionEvent) => {
    if (e.persisted) this.drop();
  };

  send(msg: ClientMsg): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(msg));
    return true;
  }

  /** Join again, taking the seat from another device that has it. */
  takeOver() {
    this.takeover = true;
    this.stopped = false;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ t: 'join', name: this.name, takeover: true } satisfies ClientMsg));
    } else this.drop();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.pingTimer);
    clearTimeout(this.retryTimer);
    this.setStatus('stopped');
  }

  destroy() {
    this.stop();
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('online', this.reconnectNow);
    window.removeEventListener('pageshow', this.onPageShow);
    window.removeEventListener('focus', this.checkAlive);
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }
}
