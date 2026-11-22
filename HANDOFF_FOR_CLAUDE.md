# Handoff note for Claude — KuCards

## Context

The seating/UI/voice work was committed locally as `1fd2a3c`; the final code-review fixes below are uncommitted on top. Nothing was pushed. Unrelated icon/PNG changes in the working tree were left untouched.

## Goal

Finish the side-by-side seating swap so the offline preview, match start, online lobby, online game and rematch all agree. “Cambiar de lado” must swap the human with their partner only — rivals keep their seats. Keep the earlier UI/style/voice and penalty/mirror fixes intact.

---

## 1. Side seating swap (“Cambiar de lado”)

- Replaced `partnerSide: 'after' | 'before'` with `swappedSeats?: boolean` in `MatchSetup`, `NewGameStart`, `NewGameOpts`, `PublicRoom` and `RoomData`.
- Side-seating teams are now fixed at `[[0, 1], [2, 3]]`. The human stays engine seat 0; only the displayed avatar/name identities swap between local seat 0 and the partner seat.
- Added one shared predicate so every layer agrees:
  - `sideSeating()` in `src/modes/core.ts` (engine + offline preview)
  - `sideSeatingRoom()` in `src/net/protocol.ts` (online lobby/protocol)
  - Test: 4 players + 2v2 + side seating, including custom modes with `teams: 'optional'`.
- Offline new-game screen (`src/ui/newgame.ts`):
  - Swap button only appears when side seating is really active.
  - After swapping, the partner’s avatar/name is shown at the bottom seat and the human avatar/name appears at the partner seat.
  - The partner slot showing “me” is disabled, and the roster picker is moved off it.
  - The lineup data itself stays by real seat; no rivals are moved.
- Offline game (`src/app/session.ts`): when `match.setup.swappedSeats` is set, displayed name/face/level/style are exchanged between seat 0 and the partner seat.
- Online protocol/lobby:
  - New host-only message `{ t: 'setSwappedSeats'; swapped: boolean }`.
  - `RoomData.swappedSeats` and `PublicRoom.swappedSeats`; room start passes the flag into the match setup.
  - Lobby display swap is per viewer’s perspective (`shownServer()`): each player sees their own avatar at the partner’s seat and the partner at the bottom, while real seats, teams and click targets stay unchanged.
- Online game (`src/app/online.ts`): `players()` swaps displayed names/faces between local seat 0 and the perspective-local partner seat when the room flag is set.
- Rematch (`src/app/controller.ts`):
  - `createMatch()` stores the original setup on `MatchState.setup`.
  - Rematch reuses that setup and restores `m.clock`, preserving mode, custom mode, seating, swap flag, deck and clock instead of rebuilding from the custom mode’s base mode.

---

## 2. Penalty / shield / mirror behavior (kept and completed)

- `partnerShield` remains shield-only.
- Shield now lands **on top** of the pile and sets the active colour in the engine, renderer and network mirror.
- Mirror bounces the whole stack, reverses play direction, emits a `reverse` event, and gives the new victim the full response set: shield, another mirror, challenge where legal, and playable +N stacking.
- Mandatory stacking: if a playable +N exists, a penalty response window opens, the Draw/Accept button is hidden, and the timer auto-stacks the first card.
- HUD (`src/ui/hud.ts`) response bar now offers one “Stack +N <colour>” button per playable card and returns `{ stack: cardId }`.
- Added `hud.stack` in ES/EN and updated the how-to text for mirror/stack behaviour.

---

## 3. Voice callouts

- Multi-play events (`play` with `more: true`) no longer speak; only the final card calls out. Several skips/reverses/+2s played in one move now produce one voice line.
- Regression test added in `src/audio/voice.test.ts`.

---

## 4. Settings / menu / small UI polish

- Settings tab order is now **Game → Image and Sound → Rules**; English label changed to “Image and Sound”.
- Main-menu Pause styling applies only to the last row (settings, how to play, about, fullscreen), not to Jugar en línea / Jugar con amigos.
- Response buttons wrap on narrow screens.

---

## 5. Tests and docs

- Updated all old `partnerSide` tests to `swappedSeats` semantics across:
  - `src/engine/testutil.ts`
  - `src/engine/cards.test.ts`
  - `src/app/controller.test.ts`
  - `src/net/net.test.ts`
  - `src/render/layout.test.ts`
  - `server/test/lobby.test.ts`
  - `server/test/core.test.ts`
- Added assertions for fixed side teams, setup persistence, host-only swap broadcast, rematch preservation, shield top-card behavior, mirror reverse/bounce/stack, and voice dedupe.
- `PLAN.md` now describes a true identity swap, not the old neighbour change.

---

## Files changed in the seating work (31)

- Docs: `PLAN.md`
- Contracts/engine/modes: `src/contracts.ts`, `src/engine/game.ts`, `src/engine/testutil.ts`, `src/engine/cards.test.ts`, `src/engine/power.test.ts`, `src/modes/core.ts`
- Offline app/render/UI: `src/main.ts`, `src/app/controller.ts`, `src/app/session.ts`, `src/ui/newgame.ts`, `src/ui/hud.ts`, `src/ui/hudPreview.ts`, `src/ui/i18n.ts`, `src/ui/settings.ts`, `src/ui/styles.css`, `src/render/cardTable.ts`, `src/render/harness.ts`, `src/render/layout.test.ts`
- Online/protocol/server: `src/net/protocol.ts`, `src/net/mirror.ts`, `src/net/room/lobby.ts`, `src/net/room/core.ts`, `src/ui/online.ts`, `src/app/online.ts`, `src/net/net.test.ts`, `server/test/lobby.test.ts`, `server/test/core.test.ts`
- Voice: `src/audio/voice.ts`, `src/audio/voice.test.ts`
- Handoff: `HANDOFF_FOR_CLAUDE.md`

---

## 6. Code-review fixes (final pass)

All confirmed findings from the full review are fixed:

- **Hidden information:** `seatView()` now deletes `round.seed` as well as `rng`; the server core leak test
  asserts it (`src/net/redact.ts`, `server/test/core.test.ts`).
- **Old offline saves:** `save.VERSION` is 2, so pre-swap side saves cannot load with obsolete teams
  (`src/app/save.ts`, `src/app/settings.test.ts`).
- **Unseated online members:** `fillSeats()` now prioritizes the host and can replace CPUs; the room removes
  any still-seatless connected members at start, closes their sockets with `room_full`, and a seatless
  reconnect either takes a CPU seat or is rejected (`src/net/room/lobby.ts`, `src/net/room/core.ts`,
  `server/test/lobby.test.ts`, `server/test/core.test.ts`).
- **Settings persistence:** catalog save and mode-editor back now go through `update()`, so localStorage and
  reapply stay in sync, including Android/Escape back (`src/main.ts`).
- **Escape bubbling:** the global back handler ignores handled Escape, and the rule dropdown / info tooltip
  stop propagation (`src/main.ts`, `src/ui/settings.ts`).
- **Protocol compatibility:** `PROTOCOL_VERSION` is 3 for `setSwappedSeats`; old clients now fail fast with
  `version_mismatch` instead of silently missing the message (`src/net/protocol.ts`).
- **Docs:** root README now describes the shipped app, own icons and `kuavatars#v0.3.1`; server README uses
  the real Worker URL, v3 and the no-spectator / seed-redaction rules (`README.md`, `server/README.md`).
- **Stale finished-match teams:** mode/custom changes clear `r.match` (`src/net/room/lobby.ts`).
- **Voice timers:** delayed callouts are tracked and cleared by `cancelVoice()`; added a regression test
  (`src/audio/voice.ts`, `src/audio/voice.test.ts`).
- **Dead imports:** removed unused specifiers from main, online, settings, chat and the two test files.
- **Atlas tests:** removed the silent `try/catch` and dynamic-import guard; they now assert real deck faces
  (`src/render/cardAtlas.test.ts`).
- **Unused i18n keys:** removed obsolete ES/EN pairs (`menu.soon*`, `howto.rule.partnerShield`,
  `summary.byTime*`, `newgame.seating`, `lobby.players*`) from `src/ui/i18n.ts`.
- **Rules comment:** the shield/mirror/partnerShield note now says custom-mode decks can still include them
  (`src/engine/rules.ts`).

Additional files in the final pass: `README.md`, `server/README.md`, `src/app/save.ts`,
`src/app/settings.test.ts`, `src/audio/voice.ts`, `src/audio/voice.test.ts`, `src/engine/rules.ts`,
`src/net/protocol.ts`, `src/net/redact.ts`, `src/net/room/core.ts`, `src/net/room/lobby.ts`,
`src/render/cardAtlas.test.ts`, `src/render/layout.test.ts`, `src/ui/chat.ts`, `src/ui/i18n.ts`,
`src/ui/settings.ts`, `server/test/core.test.ts`, `server/test/lobby.test.ts`.

---

## Verification

- Root `npm test` → **373 passed**
- Root `npm run typecheck` → passed
- Root `npm run build` → passed
- Server `npm test` → **37 passed**
- Server `npm run typecheck` → passed

## Note

`PROTOCOL_VERSION` is now 3. Client and Worker must still be deployed together; a mismatch fails on `hello`
with `version_mismatch`. Offline saves from v1 are intentionally invalidated by the v2 save format.
