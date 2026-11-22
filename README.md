# KuCards

An original shedding card game (match colour or number, call **¡Ku!** on your last card). Vite + TypeScript +
three.js, packaged for Android with Capacitor. Neutral Spanish by default, English second. See `PLAN.md`.

The stack and some UI/animation helpers came from the sibling project `../kudominoes`, but this repo is
self-contained: the offline game, 3D table, online client and room server all live here.

## Status: shipped (offline and online play)

- `src/contracts.ts`: the shared contract (cards, moves, response windows, events, settings, `EngineApi`, `TableView`).
- `src/engine`: all built-in modes (Clásico, Pura acción, Ciclón, Codo a codo, Día y Noche), player-made
  modes/decks, rule toggles, power cards, +4 challenge, shield/mirror responses, scoring, CPU levels and fuzz tests.
- `src/render`: the three.js card table (one atlas, one instanced mesh) and every event animation.
  Test bench: `/harness.html`. `demoTable.ts` is the menu backdrop.
- `src/ui`: menu, new game, settings (including the mode catalog/editor), HUD, summary, how-to, about and
  online lobby. Dev preview: `?hud=1`; in-browser mock room server: `?mpmock=1`.
- `src/app`: the offline controller/session, save, custom modes, rule profiles and online controller.
- `src/net` and `server`: the WebSocket client and Cloudflare Worker/Durable Object room server. Online play
  uses the deployed Worker in `src/net/config.ts`; Jugar con amigos can also host on the same network/Bluetooth.
- Avatars: the shared `kuavatars` library (`github:rene-guerrero/kuavatars#v0.3.1`), wrapped by
  `src/ui/avatarAdapter.ts`. To try unreleased avatar changes: `npm link ../kuavatars` (undo with `npm install`).

## Web

```sh
npm install
npm run dev          # http://localhost:5174
npm test
npm run build
```

## Android

Same as Kudominoes: `npm run android:apk` uses the toolchain in `../android-toolchain`
(override with `KUCA_ANDROID_TOOLCHAIN`). App id `com.kucards.app`. CI signing reads
`KUCA_KEYSTORE_FILE` / `KUCA_KEYSTORE_PASSWORD` (from the `KEYSTORE_BASE64` / `KEYSTORE_PASSWORD` secrets).
The launcher icons are KuCards' own card/Ku artwork.
