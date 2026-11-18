# KuCards

An original shedding card game (match colour or number, call **¡Ku!** on your last card). Vite + TypeScript +
three.js, packaged for Android with Capacitor. Neutral Spanish by default, English second. See `PLAN.md`.

Infrastructure comes from the sibling project `../kudominoes`.

## Status: phase 2 done (engine, 3D table and UI built; wired together in phase 3)

- `src/contracts.ts`: the shared contract (cards, moves, response windows, events, settings, `EngineApi`, `TableView`).
- `src/engine`: Classic rules and every rule toggle, Parejas (Enfrente / Codo a codo), scoring, easy and
  normal CPU, fuzz tests. Power-card effects, +4 challenge and hard/master CPU come in phase 4.
- `src/render`: the three.js card table (one atlas, one instanced mesh) and every event animation.
  Test bench: `/harness.html`. `demoTable.ts` is the menu backdrop until phase 3.
- `src/ui`: menu, new game, settings, HUD, summary, how-to, about. Dev preview: `?hud=1` (add `&partners`).
- Copied unchanged from Kudominoes: `frameLoop`, `tween`, `particles`, `perfHud`, `perf`, `errorLog`, `dom`,
  `overlay`, `hscroll`, `crash`, `sfx`, `music`, `rng`, Android project, CI.
- Avatars: the shared `kuavatars` library (`github:rene-guerrero/kuavatars#v0.1.0`), wrapped by
  `src/ui/avatarAdapter.ts`. To try unreleased avatar changes: `npm link ../kuavatars` (undo with `npm install`).
- Still in `../kudominoes`, ported in their phases: controller/save (phase 3), `src/net/**` and `server/` (phase 8).

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
The launcher icons are still the domino ones until phase 6.
