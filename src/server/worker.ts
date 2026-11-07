// Runs Poker Night on Cloudflare's free plan.
// The app is served as static files. Each game (game code) is one Durable Object that holds the table and
// everyone's connections. Connections use the WebSocket Hibernation API, so a game that is waiting costs nothing
// and keeps every connection open; the table is saved after every change and survives restarts and deploys.
import { DurableObject } from 'cloudflare:workers';
import {
  type Conn,
  isValidCode,
  newRoomState,
  normalizeCode,
  randomCode,
  Room,
  type RoomHost,
  type RoomState,
} from './room.ts';
import type { ServerMsg } from '../shared/protocol.ts';

interface Env {
  GAME: DurableObjectNamespace<PokerGame>;
  ASSETS: Fetcher;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const stubFor = (code: string) => env.GAME.get(env.GAME.idFromName(code));

    if (path === '/api/create' && request.method === 'POST') {
      for (let i = 0; i < 12; i++) {
        const code = randomCode();
        const res = await stubFor(code).fetch(`https://game/init?code=${code}`, { method: 'POST' });
        if (res.status === 200) return json({ code });
      }
      return json({ error: 'Could not make a game code. Please try again.' }, 503);
    }
    const game = path.match(/^\/api\/game\/([A-Za-z]{4})$/);
    if (game) {
      const code = normalizeCode(game[1]);
      if (!isValidCode(code)) return json({ exists: false });
      return stubFor(code).fetch('https://game/exists');
    }
    const ws = path.match(/^\/ws\/([A-Za-z]{4})$/);
    if (ws) {
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
      const code = normalizeCode(ws[1]);
      if (!isValidCode(code)) return new Response('Bad game code', { status: 400 });
      return stubFor(code).fetch(request);
    }
    if (path === '/health') return new Response('ok');
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

interface Attachment {
  pid: string | null;
  hidden: boolean;
  at: number;
}

export class PokerGame extends DurableObject<Env> {
  private state: RoomState | null = null;
  private room: Room | null = null;
  private conns = new Map<WebSocket, Conn>();
  private lastMsg = new WeakMap<WebSocket, number>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Heartbeats are answered without waking the game up.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    ctx.blockConcurrencyWhile(async () => {
      this.state = (await ctx.storage.get<RoomState>('room')) ?? null;
      if (this.state) this.room = new Room(this.state, this.host());
    });
  }

  private host(): RoomHost {
    return {
      conns: () => this.ctx.getWebSockets().filter((ws) => ws.readyState === WebSocket.OPEN).map((ws) => this.conn(ws)),
      now: () => Date.now(),
      persist: (s) => void this.ctx.storage.put('room', s),
      wakeAt: (at) => {
        if (at === null) void this.ctx.storage.deleteAlarm();
        else void this.ctx.storage.setAlarm(Math.max(at, Date.now() + 50));
      },
    };
  }

  private conn(ws: WebSocket): Conn {
    let c = this.conns.get(ws);
    if (c) return c;
    const a = (ws.deserializeAttachment() as Attachment | null) ?? { pid: null, hidden: false, at: Date.now() };
    const ctx = this.ctx;
    const lastMsg = this.lastMsg;
    c = {
      pid: a.pid,
      hidden: a.hidden,
      lastSeen() {
        const auto = ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0;
        return Math.max(a.at, auto, lastMsg.get(ws) ?? 0);
      },
      send(msg: ServerMsg) {
        try {
          ws.send(JSON.stringify(msg));
        } catch {
          /* already closed */
        }
      },
      close(code: number, reason: string) {
        try {
          ws.close(code, reason);
        } catch {
          /* already closed */
        }
      },
      save() {
        ws.serializeAttachment({ pid: this.pid, hidden: this.hidden, at: a.at } satisfies Attachment);
      },
    };
    this.conns.set(ws, c);
    return c;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/init') {
      if (this.state) return new Response('taken', { status: 409 });
      const code = normalizeCode(url.searchParams.get('code') ?? '');
      this.state = newRoomState(code, Date.now());
      this.room = new Room(this.state, this.host());
      await this.ctx.storage.put('room', this.state);
      this.room.commit();
      return new Response('ok');
    }
    if (url.pathname === '/exists') return json({ exists: !!this.state });

    const { 0: client, 1: server } = new WebSocketPair();
    if (!this.room) {
      server.accept();
      server.send(JSON.stringify({ t: 'error', message: 'There is no game with that code.', fatal: 'noGame' } satisfies ServerMsg));
      server.close(4004, 'no game');
      return new Response(null, { status: 101, webSocket: client });
    }
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ pid: null, hidden: false, at: Date.now() } satisfies Attachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    this.lastMsg.set(ws, Date.now());
    if (typeof message !== 'string' || message.length > 4096) return;
    if (message === 'ping') {
      ws.send('pong');
      return;
    }
    if (!this.room) {
      ws.close(4004, 'no game');
      return;
    }
    this.room.message(this.conn(ws), message);
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    this.gone(ws);
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, 'bye');
    } catch {
      /* already closed */
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.gone(ws);
  }

  private gone(ws: WebSocket) {
    const c = this.conns.get(ws);
    this.conns.delete(ws);
    if (this.room && c) this.room.disconnect(c);
    else this.room?.tick();
  }

  async alarm(): Promise<void> {
    if (!this.room) return;
    if (this.room.expired()) {
      await this.ctx.storage.deleteAll();
      this.state = null;
      this.room = null;
      return;
    }
    this.room.tick();
  }
}
