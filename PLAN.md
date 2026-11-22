# KuCards — plan

An original shedding card game: match the top card's colour or number, use action and power cards,
call **¡Ku!** on your last card. Same family as Crazy Eights / Mau-Mau. Everything here (name, card art,
mode names, colours and symbols) is our own; nothing is copied from any branded game.

Built on the Kudominoes stack (`../kudominoes`): Vite + TypeScript + three.js, Capacitor Android,
Cloudflare Worker + Durable Objects for online rooms, GitHub Pages + an APK built in CI.

Status: **draft for approval.** No code yet.

---

## 0. Name check (2026-11-17)

- Web search for "KuCards" card game: no game or product by that name. Near names: *KARDS* (WWII
  collectible card game), *Ku-Ka-König* (a board game). Neither clashes.
- Google Play / App Store: no "KuCards" listing. Nearest are *KobCard* and *Yucard* (developer names,
  not games) and *Kantocards* (a TCG shop app). No clash.
- GitHub: `rene-guerrero/kucards` is free. A repo search for `kucards` returns nothing.

Verdict: the name is usable. Package id would be `com.kucards.app`.

---

## 1. What we reuse from Kudominoes

| Area | Files | What happens to them |
| --- | --- | --- |
| Build | `package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`, `.gitignore`, `.gitattributes`, `.claude/launch.json` | **Copy** and rename |
| Frame loop / perf | `src/render/frameLoop.ts` (+test), `src/app/perf.ts` (+test), `src/render/perfHud.ts` | **Copy as-is** (auto quality, frame budget, pausing) |
| Animation | `src/render/tween.ts`, `src/render/particles.ts` | **Copy as-is** |
| Textures | `src/render/textures.ts` | **Adapt**: keep the canvas→texture helpers and felt/table styles, drop the tile faces, add a card-face atlas |
| Table view | `src/render/tableView.ts` (4k lines) | **Rewrite** as `cardTable.ts`. We keep the patterns (camera rig, plates projection, input picking, `handle(event)` queue) and drop the chain layout |
| Domino-only render | `chainLayout*`, `hiddenTiles*`, `idleRing`, `menuRing`, `platesHarness` | **Drop** (`menuRing` may come back as a card-fan menu backdrop) |
| Avatars | `src/ui/avatars.ts`, `src/ui/faces.ts` | **Do not copy.** They are moving into the shared library **KuAvatars** (`../kuavatars`), used by both games. KuCards depends on it (`kuavatars`, pinned to a tag in package.json) through `src/ui/avatarAdapter.ts`, which maps card events to its moods. New moods, events or sizes are requested from the KuAvatars session, never changed locally |
| Plates and bubbles | `src/ui/plates.ts` | **Copy**, swapping the bubble phrases for card ones ("¡Ku!", "¡Toma dos!") |
| Roster | `src/roster.ts` | **Adapt**: same faces and levels, new card play styles and new descriptions |
| UI kit | `src/ui/dom.ts`, `overlay.ts`, `hscroll.ts`, `crash.ts`, `about.ts`, `menu.ts`, `styles.css` | **Copy**, then retheme. `styles.css` (5k lines) is pruned of tile-specific rules |
| Settings | `src/ui/settings.ts` + `src/app/settings.ts` | **Copy**. The settings tabs and the rule list driven by `RULE_SETTINGS` carry over unchanged. Only the descriptors change |
| i18n | `src/ui/i18n.ts` | **Copy the mechanism**, replace the strings (neutral Spanish by default, English second) |
| Screens | `newgame.ts`, `summary.ts`, `hud.ts`, `howto.ts`, `online.ts` | **Adapt** (seat picker, round summary, HUD) |
| Audio | `src/audio/sfx.ts`, `music.ts` | **Copy**; add synth sounds: card flick, shuffle riffle, draw, ¡Ku! sting, shield clang, mirror whoosh |
| App shell | `src/app/app.ts`, `controller.ts`, `save.ts`, `errorLog.ts`, `modules.ts`, `mocks/*`, `main.ts` | **Adapt**: the controller loop (engine → events → view → human move) is the same shape |
| Engine | `src/engine/*` | **Rewrite** for cards; keep `rng.ts` and `testutil.ts` patterns |
| Contract | `src/contracts.ts` | **Rewrite** for cards. Keep its structure and rules (pure engine, events, data-driven settings) |
| Online client | `src/net/*` (client, identity, mirror, perspective, redact, protocol, mock) | **Copy and adapt**: protocol types change (cards, response windows), transport and identity are unchanged |
| Online server | `server/*` (Worker, Room DO, lobby, schedule, redact) | **Copy and adapt**: room code prefix `KUCA-XXXX`, redaction hides hands + deck, new response-window timers |
| Android | `capacitor.config.ts`, `android/`, `scripts/android-apk.mjs`, `scripts/android-icons.mjs` | **Copy**. Run `npx cap add android` fresh with id `com.kucards.app` rather than copying `android/`. The toolchain at `D:\Me\for-pleasure\android-toolchain` is shared, so nothing new is installed |
| CI | `.github/workflows/deploy.yml` | **Copy**, rename APK to `kucards.apk`, keystore secret names kept |
| PWA | `public/sw.js`, manifest, icons | **Copy**, new icon |

---

## 2. Cards and deck

**Colours** (each has its own symbol, so colour-blind players can read every card):

| id | ES / EN | Symbol |
| --- | --- | --- |
| `sol` | Sol / Sun | sun |
| `mar` | Mar / Sea | wave |
| `palma` | Palma / Palm | palm leaf |
| `coral` | Coral / Coral | shell |

Palette: amber, teal, leaf green, coral pink, deliberately off the classic primary set. Card style: a
rounded card with a big corner numeral, a centre medallion holding the colour symbol, and a woven
"Ku" pattern on the back. No tilted oval.

**Classic deck (108):** per colour, one 0 plus two each of 1–9, **Salto** (skip), **Vuelta** (reverse)
and **+2**. Plus 4 **Comodín** (wild) and 4 **Comodín +4**.

**Power cards** (each switchable in settings, off in Classic by default, on in the action mode):

| Card | ES / EN | Effect | Count |
| --- | --- | --- | --- |
| swap | Cambio / Swap | wild: choose a player and swap hands, then pick a colour | 2 |
| shield | Escudo / Shield | played **in response** to a draw penalty: you draw nothing and the stack is cleared | 1 per colour |
| sweep | Barrida / Sweep | coloured: discard every other card of that colour from your hand | 1 per colour |
| mirror | Espejo / Mirror | played **in response** to a draw penalty: the whole stack goes back to whoever played the last card and the play direction reverses | 1 per colour |

Shield and mirror can be played on top of a matching colour like normal cards (no effect then), or out of
turn during a **response window** (see §3). A shield played in response becomes the new top card and sets
the colour in play; a mirror stays tucked under the top card. The bounced player then gets the same answer
options (shield, another mirror, or, when stacking is enabled, a playable +N card).

---

## 3. Engine contract (`src/contracts.ts`)

The engine is pure (no DOM, no three.js), deterministic from a seed, and returns events. Shapes:

```ts
export type Color = 'sol' | 'mar' | 'palma' | 'coral';
export type CardKind =
  | 'number' | 'skip' | 'reverse' | 'draw2' | 'wild' | 'wild4'
  | 'swap' | 'shield' | 'sweep' | 'mirror'
  | 'flip';                               // double-sided mode only
export interface CardFace { kind: CardKind; color: Color | null; value?: number /* 0–9 */; draw?: number }
export interface Card { id: number; face: CardFace; dark?: CardFace /* double-sided mode */ }

export type Seat = 0 | 1 | 2 | 3 | 4 | 5;    // 0 = human (bottom); v1 ships 2–4, 5–6 later
export type Direction = 1 | -1;

export type Move =
  | { kind: 'play'; seat: Seat; cardId: number; color?: Color; target?: Seat; ku?: boolean }
  | { kind: 'draw'; seat: Seat }              // draw one (or "draw until playable", by rule)
  | { kind: 'pass'; seat: Seat }              // after drawing, keep the card
  | { kind: 'acceptPenalty'; seat: Seat }     // take the pending stack
  | { kind: 'callKu'; seat: Seat }            // say ¡Ku! (any time you hold 2 cards before/while playing, or 1 card)
  | { kind: 'catchKu'; seat: Seat; target: Seat } // catch someone who forgot
  | { kind: 'jumpIn'; seat: Seat; cardId: number } // identical card out of turn
  | { kind: 'swap70'; seat: Seat; target: Seat };  // 7-0 rule: choose who to swap with on a 7

export interface RoundState {
  roundNo: number;
  hands: Card[][];             // by seat (hidden info: engine + own seat only)
  deck: Card[];                // hidden
  discard: Card[];             // top = last
  activeColor: Color;          // after a wild
  turn: Seat; direction: Direction;
  pendingDraw: number;         // stacked penalty, 0 = none
  window: ResponseWindow | null; // open out-of-turn actions (shield, mirror, jump-in, catch-Ku)
  kuCalled: boolean[]; side: 'light' | 'dark';
  eliminated: boolean[]; over: boolean;
}
export interface MatchState { rules: RuleSettings; mode: GameMode; seats: Seat[]; scores: number[];
  round: RoundState | null; over: boolean; winner: Seat | null; teams?: [Seat[], Seat[]]; rng: number }

export type GameEvent =
  | { type: 'deal'; hands: number[] /* counts */; starter: Seat; firstCard: Card }
  | { type: 'play'; seat: Seat; card: Card; color?: Color }
  | { type: 'draw'; seat: Seat; count: number; cards?: Card[] /* only for the viewer */ ; reason: 'turn' | 'penalty' | 'ku' }
  | { type: 'skip'; seat: Seat } | { type: 'reverse'; direction: Direction }
  | { type: 'stack'; total: number } | { type: 'shield'; seat: Seat } | { type: 'mirror'; from: Seat; to: Seat; total: number }
  | { type: 'swapHands'; a: Seat; b: Seat } | { type: 'rotateHands'; direction: Direction }
  | { type: 'sweep'; seat: Seat; cardIds: number[] }
  | { type: 'ku'; seat: Seat } | { type: 'kuCaught'; by: Seat; target: Seat }
  | { type: 'flip'; side: 'light' | 'dark' }
  | { type: 'eliminated'; seat: Seat } | { type: 'reshuffle' }
  | { type: 'turn'; seat: Seat } | { type: 'roundEnd'; winner: Seat; points: number[] }
  | { type: 'matchEnd'; winner: Seat | number };

export interface EngineApi {
  RULE_SETTINGS: SettingDescriptor[]; DEFAULT_RULES: RuleSettings; RULE_PRESETS: RulePreset[];
  createMatch(rules, seed?, setup?): MatchState;
  startRound(m): { match; events };
  legalMoves(m, seat?): Move[];          // seat param: out-of-turn moves during a window
  applyMove(m, move): { match; events };
  closeWindow(m): { match; events };     // called by controller/server when the response timer ends
  chooseMove(m, seat, level, style?): Move | null;   // null = no reaction in a window
}
```

`SettingDescriptor`, `RulePreset`, `AppSettings`, `Quality`, `TableViewOptions` and the plate types
carry over from Kudominoes almost unchanged (tile theme → card back).

**Response windows** are how shield, mirror, jump-in and catching a missed ¡Ku! fit a turn-based
engine. After certain moves the engine opens a window and lists who may act. Offline the controller
gives CPUs a short reaction delay and the human a button. Online the server timestamps the actions,
takes the first valid one, then closes the window (≈2.5 s, configurable). The engine stays pure and
synchronous.

**Scoring:** round winner scores the cards left in the others' hands (numbers face value, actions 20,
wilds and power cards 50). Match target 500 (select: single round / 200 / 500). In Harsh mode the
last player standing also wins.

---

## 4. Modes and rule toggles

Presets (the `RulePreset` mechanism), each fully data-driven:

| Mode | ES / EN | Rules |
| --- | --- | --- |
| Classic | **Clásico** / Classic | 108-card deck, no power cards, no stacking |
| All-action | **Pura acción** / All Action | numbers thinned (only 0, 5–9), more actions, all power cards on |
| Harsh | **Ciclón** / Cyclone | stacking on (+2 on +2, +4 on +2/+4), extra penalty cards (+6, +10, skip-all, "discard all of a colour"), eliminated at 25+ cards, last one standing wins |
| Partners | **Parejas** / Partners | 2v2, 4 players. The team wins when either partner empties their hand, and scores the cards left in the opponents' hands. Seating is a setting (below) |
| Double-sided *(later, optional)* | **Día y Noche** / Day & Night | every card has a light and a dark face. The **Eclipse** card flips the whole game (deck, pile, hands) to the dark side: +5, skip everyone, wild "draw until you get the colour". Played again, it flips back |

**Partner seating** (`seating` rule in Parejas):

- **Enfrente** / Across (default): seats `A B A B`. Partners sit opposite each other, as in Kudominoes.
- **Codo a codo** / Side by Side: seats `A A B B`. Partners sit next to each other, so turn order runs
  A1 → A2 → B1 → B2. A +2 or a skip aimed at the next player can land on your own partner, and a Vuelta
  decides which team gets hit. The CPU has to account for this: it holds penalties until the next seat is
  an opponent, and uses Vuelta to turn a penalty away from its partner.

The neighbour after seat 0 (right) is always the partner. "Cambiar de lado" / "Switch sides" is a
display-only swap: my avatar/name appears at the partner's seat and my partner's avatar/name appears at
the bottom seat; the rivals keep their seats and the teams stay `A A B B`. The new-game preview, the
offline table, the online lobby and the online table apply the same swap, and the flag is kept in the
match setup so a rematch repeats the same mode, seating, seat swap and deck instead of falling back to
across seating.

"Side 2 Side" is the name of a mode in the official mobile app of a branded card game. **We do not use
that name**, only the generic mechanic (partners seated side by side), under our own name *Codo a codo*.
The search found no public rulebook for it, so our rules above are our own.

Partner extras (toggles, off by default): `partnerPass` (on a 7 you may give one card to your partner),
`partnerShield` (you may play Escudo / Espejo to protect your partner).

**Rule toggles** (Rules tab, each with a one-line help text, valid in any mode):

- `stacking`: Acumular castigos (off / same card only / +2 and +4 freely)
- `jumpIn`: Entrar sin turno (play an identical card out of turn)
- `sevenZero`: 7 cambia, 0 rota (7 = swap hands with someone, 0 = everyone passes their hand along)
- `drawMode`: Robar una / Robar hasta poder jugar
- `forcePlay`: after drawing a playable card you must / may play it
- `kuCall`: ¡Ku! obligatorio (off / on: catch penalty 2 cards)
- `wild4Challenge`: you may challenge a +4 (it was only legal with no matching colour)
- `power.swap`, `power.shield`, `power.sweep`, `power.mirror`: individual power cards
- `eliminateAt`: 25 / 30 / off (default on in Cyclone)
- `target`: 1 round / 200 / 500
- `handSize`: 7 (5–10)

Settings stay versioned (`rulesVersion`) with migration, as in Kudominoes.

---

## 5. CPU levels

Same four levels and the roster/style system (`roster.ts`, styles are light biases):

- **Fácil (easy):** a random legal card, wilds pick a random colour, forgets ¡Ku! 30 % of the time.
- **Normal:** heuristics. Dump high numbers first, keep wilds, pick the colour it holds most of, and use
  penalties on the next player when they are short of cards. It is the casual default, so it slips now and
  then (`NORMAL_W` in `aiPolicy.ts`): a rough card or wild-colour pick, a forgotten ¡Ku! (40 %), a missed catch.
- **Difícil (hard):** card counting: tracks colours each player drew on or passed on, saves +4 / shields
  for defence, keeps penalties, skips and wilds until an opponent gets short, targets the leader with swap
  and penalties, and always catches a missed ¡Ku!. Small slips (`HARD_W.slip*`, forgets ¡Ku! 15 %).
- **Maestro:** hard without the slips, plus a short determinized Monte Carlo (160 playouts of 4 turns with
  the hard policy, `MASTER_MS` = 60 ms cap; ≈ 20 ms per searched move on a desktop).

Balance (phase 9, `src/engine/ai.bench.test.ts`, 4 players, Clásico, one round, A and B at two seats and
normal in the other two, every deal played four times with the seats swapped; share of the rounds A or B won):

| A vs B | before | after |
| --- | --- | --- |
| normal vs easy | 79 % | 70 % |
| hard vs normal | 52 % | 60 % |
| master vs hard | 53 % | 54 % |
| master vs normal | 54 % | 62 % |

Master's edge over hard stays small: in this game the hidden hands and the draws decide most rounds,
and deeper search did not help (a cheating master that sees every hand and the deck wins 77 % against
normal, an honest one with 2.5× the budget the same as now). Run it with
`KUCA_BENCH=hard:normal KUCA_DEALS=500 npx vitest run src/engine/ai.bench.test.ts`.

Characters keep their faces and names from Kudominoes, with new card styles (for example
*aggressive* = penalties first, *hoarder* = keeps wilds forever, *chatty* = shouts ¡Ku! early).

---

## 6. 3D table and cards (weak-phone first)

- **One draw-call-friendly card mesh:** a rounded-rect plane with slight bevel shading in the shader.
  All faces come from **one canvas-drawn texture atlas** (≈ 60 unique faces → a 2048² atlas, 1024² on
  low quality), with UVs per card. Backs share one texture. No per-card textures and no shadows on low.
- **Your hand:** a fanned arc at the bottom, in camera space. It compresses and overlaps past ~12 cards
  and scrolls horizontally past ~20. Playable cards lift and glow. Tap to play, or drag up to throw.
- **Opponents:** small fans of backs next to their avatar plates, with a count badge (from `plates.ts`).
- **Centre:** the deck (stack with a shuffled edge, height ∝ count) and the discard pile (only the top ~8
  meshes are kept; older ones are merged into a static "pile" mesh). The active colour shows as a glowing
  ring around the pile, and a direction ring around the table rotates on Vuelta.
- **Animations (tween + particles reuse):** play = arc toss with spin, landing squash and a dust puff.
  Draw = slide off the deck, flip on the way to your hand. Penalties = cards stream one by one with a
  counter "+4". Skip = a ⛔ stamp on the plate. Swap hands = the two fans cross over. Eclipse = the
  table light turns from day to night and every card flips in a wave. Shield = a bubble shield on the
  plate. Mirror = the penalty stack bounces back.
- **The ¡Ku! moment:** when someone gets to one card, the camera does a small push-in, their plate
  pulses, a big "¡KU!" lettering pops with confetti and the sting plays. You get a big ¡Ku! button when
  you are about to play your second-to-last card; a missed call opens a catch window for the others.
  The win is a card fountain plus the round summary.
- Auto quality, frame-rate pausing on hidden tab and reduced motion all come from `perf.ts` / `frameLoop.ts`.

Renderer contract: `TableView.handle(event)`, `requestHumanMove(legal)`, `openWindow(actions)`, plates
callback. It's the same shape as Kudominoes, so the controller and the mocks port directly.

---

## 7. UI screens

All copy in neutral Spanish (default) with English in settings.

1. **Menú**: Jugar, En línea, Ajustes, Cómo se juega, Acerca de. The backdrop is a slow card fan.
2. **Nueva partida**: mode cards (Clásico, Pura acción, Ciclón, the chosen 4th mode), player count 2–4,
   pick CPU characters (roster grid reused), quick rule summary with "Cambiar reglas".
3. **Mesa (HUD)**: plates with avatars and bubbles, scores, pause button, ¡Ku! button, colour picker
   (4 big symbol buttons) after a wild, target picker for swap and 7.
4. **Respuesta**: shows Escudo / Espejo / Aceptar while a penalty is aimed at you, with a timer ring.
5. **Fin de ronda / partida**: cards left per player, points, running totals, "Otra ronda".
6. **Ajustes** (tabs reused): Juego (name, avatar, language, speed), Reglas (data-driven toggles per mode),
   Imagen y sonido (quality, card back, table felt, sound, music, vibration).
7. **Cómo se juega**: short illustrated pages per card and mode.
8. **En línea**: create or join a room, lobby, seat swap, rules (host only).

---

## 8. Online play

Reuse the Kudominoes design as is: private rooms by code or link, no accounts (device id + name),
no spectators, 30 s turn timer then a CPU plays that seat, CPUs fill empty seats and cover dropped
players, free Cloudflare plan (SQLite-backed DO, one alarm per room).

Changes for cards:

- The server runs the same pure engine. Redaction sends each player their own hand, the other players'
  card **counts**, and never the deck. Draw events carry card faces only to the drawer.
- **Response windows** become a server-scheduled entry (like the turn deadline) of about 2.5 s. Out-of-turn
  moves (shield, mirror, jump-in, catch ¡Ku!) are resolved first-come by server arrival order.
- A protocol version bump, and room codes shown as `KUCA-XXXX`.
- New Worker name `kucards-rooms`, a separate deploy from Kudominoes.

---

## 9. Phases

Effort: S ≈ one short session, M ≈ one session, L ≈ two or more sessions. "∥" marks phases that can run
in parallel with up to 3 Opus subagents.

| # | Phase | Effort | Notes |
| --- | --- | --- | --- |
| 1 | **Scaffold**: git init, copy infrastructure, strip dominoes code, new `contracts.ts`, stub engine/view, dev server + tests green | M | done by me, sequentially |
| 2 | ∥ **Engine**: deck, Classic rules, toggles, scoring, response windows, tests | L | agent A |
| 2 | ∥ **Renderer**: card atlas, hand fan, deck/pile, play/draw tweens, plates | L | agent B, against mocks |
| 2 | ∥ **UI**: i18n strings, menu, new game, HUD, colour picker, settings descriptors, summary | M | agent C |
| 3 | Integration: controller loop, save/resume, sfx; playable Classic vs CPU easy/normal | M | me |
| 4 | ∥ Power cards + All Action + Cyclone (engine) · ∥ effects for them (render) · ∥ hard + master CPU | L | 3 agents |
| 5 | Parejas (Enfrente + Codo a codo, partner-aware CPU) + ¡Ku! moment polish | M | |
| 6 | Android: Capacitor, icons, APK script, perf pass on a weak phone | S–M | |
| 7 | CI: deploy.yml (tests, web build, signed APK to Pages) | S | needs keystore secret, commit/push on your OK |
| 8 | Online: protocol, server copy and adapt, response windows, online UI | L | |
| 9 | Polish: how-to pages, balance, 5–6 players (optional) | M | |
| 10 | *Optional:* Día y Noche double-sided deck | L | only if wanted |

The playable offline Classic arrives at the end of phase 3; the full offline game at the end of phase 5.

---

## 10. Open questions

1. ~~"Side 2 Side"~~ **Resolved:** it is 2v2 with partners side by side (`A A B B`). It ships as the
   *Codo a codo* seating in Parejas, next to the classic *Enfrente* (`A B A B`). Día y Noche moves to an
   optional last phase. Keep it or drop it?
2. Player count: v1 with 2–4 players (reuses the 4-seat table), and 5–6 later. OK?
3. Names: Sol/Mar/Palma/Coral for colours, **¡Ku!** as the last-card call, Clásico / Pura acción /
   Ciclón for modes. Keep or change?
