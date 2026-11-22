# Handoff note for Claude — KuCards

## Context

These changes were uncommitted at the start of this handoff. They are now committed locally in one commit; nothing was pushed.

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

## Files changed (31)

- Docs: `PLAN.md`
- Contracts/engine/modes: `src/contracts.ts`, `src/engine/game.ts`, `src/engine/testutil.ts`, `src/engine/cards.test.ts`, `src/engine/power.test.ts`, `src/modes/core.ts`
- Offline app/render/UI: `src/main.ts`, `src/app/controller.ts`, `src/app/session.ts`, `src/ui/newgame.ts`, `src/ui/hud.ts`, `src/ui/hudPreview.ts`, `src/ui/i18n.ts`, `src/ui/settings.ts`, `src/ui/styles.css`, `src/render/cardTable.ts`, `src/render/harness.ts`, `src/render/layout.test.ts`
- Online/protocol/server: `src/net/protocol.ts`, `src/net/mirror.ts`, `src/net/room/lobby.ts`, `src/net/room/core.ts`, `src/ui/online.ts`, `src/app/online.ts`, `src/net/net.test.ts`, `server/test/lobby.test.ts`, `server/test/core.test.ts`
- Voice: `src/audio/voice.ts`, `src/audio/voice.test.ts`
- Handoff: `HANDOFF_FOR_CLAUDE.md`

---

## Verification

- Root `npm test` → **371 passed**
- Root `npm run typecheck` → passed
- Root `npm run build` → passed
- Server `npm test` → **32 passed**
- Server `npm run typecheck` → passed

## Note

`PROTOCOL_VERSION` was not bumped. Older clients will ignore the new `setSwappedSeats` message; both client and server in this repo are updated together.
