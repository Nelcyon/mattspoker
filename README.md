# Poker Night

Texas Hold'em (no limit) for a group of friends. Phones (iPhone and Android) and computers play at the same table in
the browser: no app to install, no accounts.

- **Join in seconds:** the host taps *Start a new game* and gets a 4-letter code. Everyone else opens the site and types
  the code and their name (or scans the QR code / opens the link from the host's Settings).
- **Hard to drop out of:** switching apps, locking the phone, losing signal or the server restarting never removes anyone.
  The app reconnects by itself and the seat, cards and chips are waiting. Closed the browser? Open the site again, type
  the same code and name, and you're back in your seat with your chips.
- **No rush:** by default there is no turn clock. Only someone who is actually away (app in the background or
  disconnected) is checked or folded automatically after 30 seconds, and after two of those they sit out (no blinds
  taken) until they tap *I'm back*. The host can turn on a turn clock, or give one slow player 20 seconds.
- **Settings button** (top right, shows the game code): code, link, QR code, sounds, vibration, keep screen on,
  four-colour suits, larger text, sit out, leave. The host also gets blinds, starting chips, turn clock, blinds that go up
  over time, rebuys, pause, set anyone's chips, make someone else host, and remove a player.
- **Proper rules:** blinds and button (including heads-up), minimum raises, all-ins that don't reopen betting, side pots,
  split pots with odd chips, uncalled bets returned, and plain-English hand names ("Full house, kings full of threes").
- **Computer friendly:** keyboard shortcuts F (fold), C (check/call), R (bet/raise), arrows, Enter and Esc. Big buttons,
  nothing needs a drag or a double-tap, and folding when you could check asks first.

## Run it on your computer

Needs Node.js 22.18 or newer.

```sh
npm install
npm run build
npm start          # open http://localhost:8080
```

`npm test` runs the rules and table tests (including 3,000 random hands checking that no chip is ever lost).
`npm run typecheck` checks the types. `npm run dev:cloudflare` runs the real Cloudflare version locally.

## How it fits together

| Part | What it is |
| --- | --- |
| `src/shared/cards.ts` | Deck, shuffling (crypto random) and hand evaluation |
| `src/shared/holdem.ts` | The rules of one hand of no-limit Hold'em, as pure functions on a saveable object |
| `src/shared/protocol.ts` | Messages between app and server, and what each player is allowed to see |
| `src/server/room.ts` | One game: joining, seats, reconnecting, timers, host controls |
| `src/server/worker.ts` | Cloudflare host: one Durable Object per game code, saved after every action |
| `src/server/node.ts` | Plain Node.js host (local play, tests, self-hosting) |
| `src/client/` | The app (React): home screen, table, settings |

Putting it online: see [docs/HOSTING.md](docs/HOSTING.md).
