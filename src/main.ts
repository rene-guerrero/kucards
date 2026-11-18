/**
 * Boot: menu over the demo table, the screens (new game, settings, how-to, about), settings persistence,
 * and the offline game (src/app/session.ts) started from "Empezar" or "Continuar".
 * Dev only: `?hud=1` previews the in-game HUD, plates, pickers and summaries with fake data.
 */
import 'kuavatars/avatars.css';
import 'kuavatars/editor.css';
import './ui/styles.css';
import type { AppSettings, GameMode, Lineup, MatchState } from './contracts';
import { installErrorLog } from './app/errorLog';
import { resolveQuality } from './app/perf';
import { loadSettings, rulesFor, saveSettings, withMode } from './app/settings';
import { clearSave, loadSave, saveSummary } from './app/save';
import { startSession, type GameSession } from './app/session';
import { createMatch, startRound } from './engine';
import { initAudio, setAudioPrefs } from './audio/sfx';
import { RULE_PRESETS, RULE_SETTINGS } from './engine/rules';
import { buildAbout } from './ui/about';
import { h, setReducedMotionPref, setUiQuality } from './ui/dom';
import { buildHowto } from './ui/howto';
import { setLang, t } from './ui/i18n';
import { buildMenu } from './ui/menu';
import { onlineAvailable } from './net/config';
import { rememberedRoom } from './net/identity';
import type { OnlineController } from './app/online';
import { buildNewGame, type NewGameStart } from './ui/newgame';
import { btn, confirmDialog, Overlay } from './ui/overlay';
import { buildSettings, descriptorsForMode, presetName, rulesSummary } from './ui/settings';

installErrorLog();

let settings: AppSettings = loadSettings();
saveSettings(settings);

function applySettings(prev: AppSettings | null): void {
  setLang(settings.language);
  setReducedMotionPref(!!settings.reducedMotion);
  setUiQuality(settings.quality);
  if (prev) setAudioPrefs({ sound: settings.sound, music: settings.music, vibration: settings.vibration });
}
applySettings(null);
initAudio(settings);

const overlay = new Overlay(document.getElementById('ui')!);

type ScreenId = 'menu' | 'newgame' | 'settings' | 'howto' | 'game';
let current: ScreenId = 'menu';
/** where Ajustes / Cómo jugar go back to */
let backTo: ScreenId = 'menu';
let rulesModeOnOpen: GameMode | undefined;

const humanName = () => settings.playerName || t('seat.you');

let session: GameSession | null = null;
const tableEl = document.getElementById('table')!;

/** leave a screen opened from the pause menu: back to the paused game */
function backToGame(): void {
  current = 'game';
  overlay.showScreen(null);
  session?.resume();
}

async function play(match: MatchState, lineup: Lineup, restored: boolean): Promise<void> {
  stopBackdrop();
  current = 'game';
  backTo = 'game';
  overlay.showScreen(null);
  session = await startSession(
    {
      overlay,
      container: tableEl,
      settings: () => settings,
      updateSettings: (next) => update(next, 'sound'),
      onExit: () => {
        session = null;
        backTo = 'menu';
        startBackdrop();
        show('menu');
      },
      openScreen: (id) => show(id),
    },
    match,
    lineup,
    restored,
  );
}

function newGame(o: NewGameStart): void {
  clearSave();
  const rules = { ...rulesFor(settings, o.mode), ...(o.seating ? { seating: o.seating } : {}) };
  // Codo a codo: the partner is the left or the right neighbour, at random each match
  const partnerSide = o.seating === 'side' ? (Math.random() < 0.5 ? 'after' : 'before') : undefined;
  const match = createMatch(rules, { mode: o.mode, players: o.players, seating: o.seating, partnerSide });
  // the character picked as partner (seat 1 on the new-game screen) moves to seat 3 when the partner plays before you
  const lineup = partnerSide === 'before' ? { ...o.lineup, 1: o.lineup[3], 3: o.lineup[1] } : o.lineup;
  void play(match, lineup, false);
}

function continueGame(): void {
  const saved = loadSave();
  if (saved) void play(saved.match, saved.lineup, true);
  else show('newgame');
}

function about(): void {
  let close = () => {};
  close = overlay.openModal(buildAbout(() => close()));
}

function update(next: AppSettings, key: keyof AppSettings): void {
  const prev = settings;
  settings = key === 'qualityMode' || key === 'quality' ? resolveQuality(next) : next;
  saveSettings(settings);
  applySettings(prev);
  // the language changes every label: rebuild the open screen in place
  if (key === 'language') show(current, false);
}

function screen(id: ScreenId): HTMLElement {
  switch (id) {
    case 'menu':
      return buildMenu({
        save: saveSummary(loadSave()),
        onPlay: () => show('newgame'),
        onContinue: continueGame,
        onSettings: () => {
          backTo = 'menu';
          show('settings');
        },
        onHowto: () => {
          backTo = 'menu';
          show('howto');
        },
        onAbout: about,
        onOnline: onlineAvailable() ? () => void openOnline() : undefined,
      });
    case 'newgame':
      return buildNewGame({
        presets: RULE_PRESETS,
        mode: settings.mode ?? 'classic',
        players: settings.players ?? 4,
        lineup: settings.lineup ?? {},
        avatars: settings.avatars !== false,
        humanFace: settings.avatarFace ?? 0,
        humanName: humanName(),
        rulesFor: (m) => rulesFor(settings, m),
        presetName: (m) => presetName(RULE_PRESETS, RULE_SETTINGS, rulesFor(settings, m), m),
        rulesSummary: (m) => rulesSummary(descriptorsForMode(RULE_SETTINGS, m), rulesFor(settings, m)),
        onMode: (m) => update(withMode(settings, m), 'mode'),
        onPlayers: (n) => update({ ...settings, players: n }, 'players'),
        onLineup: (l) => update({ ...settings, lineup: l }, 'lineup'),
        onSeating: (seat) => {
          const r = { ...rulesFor(settings, 'partners'), seating: seat };
          const byMode = { ...settings.rulesByMode, partners: r };
          update({ ...settings, rulesByMode: byMode, rules: settings.mode === 'partners' ? r : settings.rules }, 'rulesByMode');
        },
        onRules: (m) => {
          backTo = 'newgame';
          rulesModeOnOpen = m;
          show('settings');
        },
        onStart: newGame,
        onBack: () => show('menu'),
      });
    case 'settings': {
      // only the first build opens on Reglas (a rebuild after a language change keeps the tab)
      const rulesMode = rulesModeOnOpen;
      rulesModeOnOpen = undefined;
      return buildSettings({
        settings,
        ruleDescriptors: RULE_SETTINGS,
        presets: RULE_PRESETS,
        rulesMode,
        matchInProgress: !!session,
        confirm: (o) => confirmDialog(overlay, o),
        onChange: update,
        onBack: () => (backTo === 'game' ? backToGame() : show(backTo)),
        resolvedQuality: () => settings.quality,
        onAbout: about,
      });
    }
    case 'howto':
      return buildHowto(() => (backTo === 'game' ? backToGame() : show(backTo)));
    case 'game':
      return h('div');
  }
}

function show(id: ScreenId, animate = true): void {
  current = id;
  const el = screen(id);
  if (!animate) el.classList.add('no-enter');
  overlay.showScreen(el);
}

// Android back button (MainActivity calls window.__kucaBack); false = let the system handle it
(window as { __kucaBack?: () => boolean }).__kucaBack = () => {
  if (online?.active) {
    online.back();
    return true;
  }
  if (overlay.modalOpen) {
    overlay.closeAllModals();
    return true;
  }
  if (current === 'menu') return false;
  if (current === 'game') {
    session?.back();
    return true;
  }
  if ((current === 'settings' || current === 'howto') && backTo === 'game') backToGame();
  else show(current === 'settings' || current === 'howto' ? backTo : 'menu');
  return true;
};
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') (window as { __kucaBack?: () => boolean }).__kucaBack?.();
});

const preview = import.meta.env.DEV && new URLSearchParams(location.search).has('hud');
if (preview) void import('./ui/hudPreview').then((m) => m.startHudPreview(overlay, settings));
else show('menu');
document.getElementById('boot')?.remove();

// the demo table is the menu backdrop (three.js is its own chunk); the game replaces it
let backdrop: { dispose(): void } | null = null;
let backdropToken = 0;
function startBackdrop(): void {
  const token = ++backdropToken;
  void import('./render/demoTable').then(async ({ createDemoTable }) => {
    if (token !== backdropToken || backdrop) return;
    const view = createDemoTable(tableEl, settings.quality);
    backdrop = view;
    tableEl.classList.add('kc-ready');
    const { match } = startRound(createMatch(RULE_PRESETS[0].rules, { mode: 'classic', players: 4 }));
    const r = match.round!;
    await view.deal(r.hands[0], r.discard[r.discard.length - 1]);
  });
}
function stopBackdrop(): void {
  backdropToken++;
  backdrop?.dispose();
  backdrop = null;
}
if (!preview) startBackdrop();

// ───────── online play (the controller and its screens load lazily) ─────────
let online: OnlineController | null = null;
async function openOnline(code?: string, quiet = false): Promise<void> {
  if (!online) {
    const { OnlineController } = await import('./app/online');
    online = new OnlineController({
      overlay,
      container: tableEl,
      settings: () => settings,
      setSetting: (key, v) => update({ ...settings, [key]: v }, key),
      onTableStart: () => {
        stopBackdrop();
        current = 'game';
      },
      onExit: () => {
        if (current === 'game' || !backdrop) startBackdrop();
        show('menu');
      },
    });
  }
  current = 'menu';
  online.open(code, quiet);
}
// a share link (?sala=XXXX) or a reload inside a room joins it
if (!preview && onlineAvailable()) {
  const link = new URLSearchParams(location.search).get('sala');
  const sala = link ?? rememberedRoom();
  if (sala) void openOnline(sala, !link).catch((e) => console.error('[online] join failed', e));
}
