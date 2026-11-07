// Runs Poker Night as a plain Node.js program (for trying it out, tests, or hosting on your own machine).
// Games are kept in memory and saved to ./data so they survive a restart.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { type Conn, isValidCode, newRoomState, normalizeCode, randomCode, Room, type RoomState } from './room.ts';
import type { ServerMsg } from '../shared/protocol.ts';

const PORT = Number(process.env.PORT ?? 8080);
const DIST = resolve(process.env.DIST_DIR ?? 'dist');
const DATA = resolve(process.env.DATA_DIR ?? 'data');
const PERSIST = process.env.PERSIST !== '0';

interface Game {
  room: Room;
  sockets: Map<WebSocket, Conn & { seen: number }>;
  timer: NodeJS.Timeout | null;
  saveTimer: NodeJS.Timeout | null;
}

const games = new Map<string, Game>();

function saveNow(code: string, state: RoomState) {
  if (!PERSIST) return;
  mkdirSync(DATA, { recursive: true });
  const file = join(DATA, `${code}.json`);
  writeFileSync(file + '.tmp', JSON.stringify(state));
  renameSync(file + '.tmp', file);
}

function makeGame(state: RoomState): Game {
  const game: Game = { room: null as unknown as Room, sockets: new Map(), timer: null, saveTimer: null };
  game.room = new Room(state, {
    conns: () => [...game.sockets.entries()].filter(([ws]) => ws.readyState === ws.OPEN).map(([, c]) => c),
    now: () => Date.now(),
    persist: (s) => {
      if (game.saveTimer) return;
      game.saveTimer = setTimeout(() => {
        game.saveTimer = null;
        saveNow(s.code, s);
      }, 200);
    },
    wakeAt: (at) => {
      if (game.timer) clearTimeout(game.timer);
      game.timer = null;
      if (at === null) return;
      game.timer = setTimeout(() => {
        game.timer = null;
        if (game.room.expired()) {
          games.delete(state.code);
          try {
            unlinkSync(join(DATA, `${state.code}.json`));
          } catch {
            /* not saved */
          }
          return;
        }
        game.room.tick();
      }, Math.max(20, Math.min(at - Date.now(), 2 ** 31 - 1)));
    },
  });
  games.set(state.code, game);
  return game;
}

// Load saved games.
if (PERSIST && existsSync(DATA)) {
  for (const f of readdirSync(DATA)) {
    if (!f.endsWith('.json')) continue;
    try {
      const state = JSON.parse(readFileSync(join(DATA, f), 'utf8')) as RoomState;
      makeGame(state).room.tick();
    } catch (e) {
      console.error('Could not load', f, e);
    }
  }
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function sendJson(res: ServerResponse, body: unknown, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function serveStatic(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://x');
  let file = normalize(join(DIST, decodeURIComponent(url.pathname)));
  if (!file.startsWith(DIST)) file = join(DIST, 'index.html');
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(DIST, 'index.html');
  if (!existsSync(file)) {
    res.writeHead(404);
    res.end('Build the app first: npm run build');
    return;
  }
  const type = TYPES[extname(file)] ?? 'application/octet-stream';
  const immutable = file.includes(`${join(DIST, 'assets')}`);
  res.writeHead(200, { 'content-type': type, 'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' });
  res.end(readFileSync(file));
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname === '/api/create' && req.method === 'POST') {
    let code = randomCode();
    for (let i = 0; games.has(code) && i < 50; i++) code = randomCode();
    const g = makeGame(newRoomState(code, Date.now()));
    g.room.commit();
    return sendJson(res, { code });
  }
  const m = url.pathname.match(/^\/api\/game\/([A-Za-z]{4})$/);
  if (m) return sendJson(res, { exists: games.has(normalizeCode(m[1])) });
  if (url.pathname === '/health') {
    res.end('ok');
    return;
  }
  serveStatic(req, res);
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const m = url.pathname.match(/^\/ws\/([A-Za-z]{4})$/);
  if (!m) return socket.destroy();
  const code = normalizeCode(m[1]);
  wss.handleUpgrade(req, socket, head, (ws) => {
    const game = isValidCode(code) ? games.get(code) : undefined;
    if (!game) {
      ws.send(JSON.stringify({ t: 'error', message: 'There is no game with that code.', fatal: 'noGame' } satisfies ServerMsg));
      ws.close(4004, 'no game');
      return;
    }
    const conn: Conn & { seen: number } = {
      pid: null,
      hidden: false,
      seen: Date.now(),
      lastSeen() {
        return this.seen;
      },
      send(msg) {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
      },
      close(c, reason) {
        ws.close(c, reason);
      },
      save() {},
    };
    game.sockets.set(ws, conn);
    ws.on('message', (data) => {
      conn.seen = Date.now();
      const text = data.toString();
      if (text === 'ping') {
        ws.send('pong');
        return;
      }
      game.room.message(conn, text);
    });
    ws.on('close', () => {
      game.sockets.delete(ws);
      game.room.disconnect(conn);
    });
    ws.on('error', () => ws.terminate());
  });
});

server.listen(PORT, () => console.log(`Poker Night is running at http://localhost:${PORT}`));

function shutdown() {
  for (const [code, g] of games) saveNow(code, g.room.state);
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
