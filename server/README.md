# KuCards online rooms

A Cloudflare Worker with one Durable Object per room. It runs on the **free plan**: the Durable Object
uses SQLite storage, WebSocket hibernation and alarms. The contract with the game client is
`../src/net/protocol.ts`. The engine and roster are imported straight from `../src`, and wrangler
bundles them.

## Endpoints

| Method | Path | Result |
| --- | --- | --- |
| `POST` | `/api/rooms[?pid=<playerId>]` | `201 { code }`. The optional `pid` becomes the host (otherwise the first player to say hello). |
| `GET` | `/api/rooms/:code` | `{ exists, phase?, freeSeats? }`. Also accepts lowercase codes and `KUCA-XXXX`. |
| `GET` | `/api/rooms/:code/ws?pid=<playerId>` | WebSocket. The first frame must be `hello`. |

CORS and WebSocket origins allowed: `https://rene-guerrero.github.io`, `https://localhost` and
`capacitor://localhost` (Capacitor), `http(s)://localhost:*` and `127.0.0.1:*`, LAN `http://192.168.*`
and `http://10.*`, and anything listed in the `KUCA_EXTRA_ORIGINS` var (comma-separated). Requests
with no `Origin` header (native apps) are allowed.

## How a room works

The room logic is `src/core.ts` (`RoomCore`), free of any platform: the Durable Object (`src/room.ts`)
wraps it with WebSockets, storage and the alarm, and the client's dev mock (`../src/net/mock/room.ts`,
`?mpmock=1`) wraps the very same code with BroadcastChannel and `setTimeout`.

- **Lobby.** Arriving players sit in the first empty seat, or take over a CPU seat if none is empty.
  `sit` moves a player or makes them stand. The host picks the mode (Clásico / Pura acción / Ciclón with
  2–4 players, Parejas with 4 and its seating), the rules and the CPU seats. `start` (host) seats anyone
  still standing, then fills empty seats with distinct roster CPUs. Online, Codo a codo pairs seats 0+1
  and 2+3.
- **Playing.** The server holds the MatchState and checks every move against `legalMoves` for the
  sender's seat. After every change each player gets a `turn` message with their own legal moves (turn
  moves on their turn, out-of-turn moves any time: jump-in, ¡Ku! call or catch, shield). Out-of-turn moves
  are first come, first served; a late one gets `too_late`. Human turns have a 30 s deadline; then a
  `normal` CPU plays that one move (`covered`, `timeout`). CPU turns wait a short think delay (the other
  CPUs may jump in or call ¡Ku! first, as offline). The first turn of a round waits for the deal animation.
- **Response windows** (`round.window`: shield / mirror against a penalty, catching a missed ¡Ku!) are a
  scheduled entry of 2.5 s: CPUs get one moment to react, humans may act any time, then the server calls
  `closeWindow` (a CPU victim of a penalty chooses shield / mirror / stack / take instead). A human
  victim decides on their own turn clock. A CPU on turn waits while a window is open.
- **Dropped players** keep their seat. After 8 s of grace a CPU covers them (`cpuCovering`), and they take
  the seat back when they reconnect with the same `playerId`: `welcome` brings the full private view.
  A newcomer during a match can only take over a CPU seat. The next round is dealt 8 s after a round ends.
- **Finished.** The room keeps its seats. The host can change settings and send `rematch` (or `start`).
  `leave` gives the seat to a CPU during a match (or empties it in the lobby), and the host passes on.
- **Clean-up.** When nobody is connected the match pauses, and the room is deleted after 2 h.

**Persistence.** The whole room is one JSON value in DO storage, written after every change and reloaded
in the constructor (also after hibernation). Socket identity is kept with `serializeAttachment`. Every
timer (turn deadline or CPU think delay, response window, next deal, disconnect grace, idle clean-up)
sits in a small schedule; the single alarm is always set to the earliest entry.

**Redaction** (`../src/net/redact.ts`, shared and unit-tested). Each player gets their own hand (plus
the partner's in Parejas with `partnerOpen`), the other players' card **counts**, never the deck. Card ids
index the deterministic deck, so hidden cards never carry an id. `draw` events carry `cards` only for a
seat the receiver may see; `deal` / `swapHands` / `rotateHands` carry the receiver's own cards. A
`SeatView` drops the deck, `rng`, the +4 challenge flag, `outPoints` and other seats' `drawnCardId`;
the response window lists only the receiver. Every `events` batch comes with a `snap` (counts, deck,
pending penalty, visible hands; every hand once the round is over).

## Local development

Do not install anything globally. Keep caches on D:

```sh
cd server
export npm_config_cache='D:\cache\npm' XDG_CONFIG_HOME='D:\Me\for-pleasure\.wrangler-home' WRANGLER_SEND_METRICS=false
npm install
npx wrangler dev --port 8787          # http://127.0.0.1:8787 (Miniflare runs the DO and alarms locally)
```

Point the client at
`http://<your-pc-ip>:8787` (add `--ip 0.0.0.0` to reach it from a phone on the LAN).

Tests:

```sh
npm test                                   # unit tests (lobby rules, schedule, CPU, whole matches through RoomCore)
npx tsc --noEmit                           # type check
# end-to-end: shorter timers, then the Node driver (Node 22+)
npx wrangler dev --port 8787 --var KUCA_TURN_TIMEOUT_MS:1500 --var KUCA_WINDOW_MS:400 --var KUCA_GRACE_MS:800 --var KUCA_NEXT_ROUND_MS:600 --var KUCA_CPU_SPEED:0.03
node test/integration.mjs
```

Test-only vars: `KUCA_TURN_TIMEOUT_MS`, `KUCA_WINDOW_MS`, `KUCA_GRACE_MS`, `KUCA_IDLE_TTL_MS`,
`KUCA_NEXT_ROUND_MS`, `KUCA_CPU_SPEED` (multiplier on CPU think delays).

## Deploy

You need a free Cloudflare account. No `account_id` is hardcoded.

```sh
cd server
npx wrangler login      # opens the browser once; credentials are stored under XDG_CONFIG_HOME
npx wrangler deploy
```

The Worker is served at `https://kucards-rooms.<your-subdomain>.workers.dev`. Put that URL in
`MP_SERVER_URL` (`../src/net/config.ts`): while it holds the `<your-subdomain>` placeholder, production
builds hide "Jugar en línea". The client uses:

- `POST https://kucards-rooms.<sub>.workers.dev/api/rooms`
- `wss://kucards-rooms.<sub>.workers.dev/api/rooms/<CODE>/ws?pid=<playerId>`

### GitHub Actions option

1. In the Cloudflare dashboard, create an API token from the **Edit Cloudflare Workers** template.
2. In GitHub, go to Settings → Secrets → Actions and add `CLOUDFLARE_API_TOKEN`. Add
   `CLOUDFLARE_ACCOUNT_ID` too if the token can reach more than one account.
3. Add a workflow such as `.github/workflows/server.yml`:

```yaml
name: Deploy room server
on:
  push:
    branches: [main]
    paths: ['server/**', 'src/engine/**', 'src/net/protocol.ts', 'src/net/redact.ts', 'src/roster.ts', 'src/contracts.ts']
  workflow_dispatch:
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci
        working-directory: server
      - run: npm test
        working-directory: server
      - uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          workingDirectory: server
```
