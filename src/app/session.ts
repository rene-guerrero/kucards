/**
 * One offline game on screen: builds the 3D table, HUD, plates and avatars around a GameController,
 * and tears them down again. main.ts owns the screens; this owns everything in-game.
 */
import type { AppSettings, Lineup, MatchState, Seat, SeatPlate } from '../contracts';
import { playSfx, setAudioPrefs } from '../audio/sfx';
import { engine, giveOptions } from '../engine';
import { character, DEFAULT_LINEUP } from '../roster';
import { AvatarController, humanFace } from '../ui/avatarAdapter';
import { Hud, type HudPlayer } from '../ui/hud';
import { t } from '../ui/i18n';
import type { Overlay } from '../ui/overlay';
import { bubbleFor, SeatPlates } from '../ui/plates';
import { buildMatchEnd, buildPause, buildRoundSummary } from '../ui/summary';
import { GameController, type SeatInfo } from './controller';
import { requireLandscape } from './orientation';
import { clearSave, saveGame } from './save';

export interface SessionDeps {
  overlay: Overlay;
  container: HTMLElement;
  settings(): AppSettings;
  updateSettings(next: AppSettings): void;
  /** the game ended or was quit: back to the menu */
  onExit(): void;
  /** open Ajustes / Cómo jugar over the paused game; the screen calls session.resume() when closed */
  openScreen(id: 'settings' | 'howto'): void;
}

export interface GameSession {
  pause(): void;
  resume(): void;
  /** Android back / Escape while playing */
  back(): void;
  dispose(): void;
}

export async function startSession(deps: SessionDeps, match: MatchState, lineup: Lineup, restored: boolean): Promise<GameSession> {
  const { overlay } = deps;
  const s = deps.settings();
  const { createTableView } = await import('../render');

  const players: SeatInfo[] = match.seats.map((seat) => {
    if (seat === 0) return { seat, name: s.playerName || t('seat.you'), face: humanFace(s.avatarFace ?? 0) };
    const c = character(lineup[seat as 1 | 2 | 3] ?? DEFAULT_LINEUP[seat as 1 | 2 | 3] ?? DEFAULT_LINEUP[1]);
    return { seat, name: c.name, face: c.face, level: c.level, style: c.style };
  });
  const teamOf = (seat: Seat): 0 | 1 | undefined => (match.teams ? (match.teams[0].includes(seat) ? 0 : 1) : undefined);

  const avatars = new AvatarController();
  avatars.setSeats(match.seats);
  for (const p of players) avatars.setSeatFace(p.seat, p.face, p.name);
  avatars.setQuality(s.quality);
  avatars.setReducedMotion(!!s.reducedMotion);
  const plates = new SeatPlates(avatars);
  const names: string[] = [];
  for (const p of players) names[p.seat] = p.name;
  plates.setNames(names);
  plates.setAvatars(s.avatars !== false);

  let pauseClose: (() => void) | null = null;
  let controller: GameController | null = null;
  const pause = () => {
    if (pauseClose || !controller) return;
    controller.setPaused(true);
    avatars.setPaused(true);
    const cur = deps.settings();
    pauseClose = overlay.openModal(
      buildPause({
        audio: { sound: cur.sound, music: cur.music, vibration: cur.vibration },
        onAudio: (key, on) => {
          deps.updateSettings({ ...deps.settings(), [key]: on });
          setAudioPrefs({ [key]: on });
        },
        onResume: () => session.resume(),
        onSettings: () => {
          closePause();
          deps.openScreen('settings');
        },
        onHowto: () => {
          closePause();
          deps.openScreen('howto');
        },
        onQuit: () => {
          closePause();
          controller?.stop();
          session.dispose();
          deps.onExit();
        },
      }),
    );
  };
  const closePause = () => {
    pauseClose?.();
    pauseClose = null;
  };

  const hud = new Hud(overlay, pause);
  hud.avatars = s.avatars !== false;
  const hudPlayers = (counts?: number[]): HudPlayer[] =>
    players.map((p) => ({ seat: p.seat, name: p.name, face: p.face, count: counts?.[p.seat] ?? 0, team: teamOf(p.seat) }));
  hud.setPlayers(hudPlayers());

  const fast = s.animationSpeed === 'fast';
  const view = createTableView({
    container: deps.container,
    quality: s.quality,
    language: s.language,
    reducedMotion: !!s.reducedMotion,
    speed: fast ? 1.6 : 1,
    tableStyle: s.tableStyle,
    cardBack: s.cardBack,
    seats: match.seats,
    onSfx: playSfx,
    onPlates: (list: readonly SeatPlate[]) => {
      plates.update(list.map((p) => ({ ...p, team: teamOf(p.seat) })));
      hud.placeKu(list.find((p) => p.seat === 0), innerWidth, innerHeight);
      const counts: number[] = [];
      for (const p of list) counts[p.seat] = p.count;
      hud.setPlayers(hudPlayers(counts));
    },
    onError: (e) => console.error('[table]', e),
  });
  hud.colorAnchor = () => view.pileScreenPoint();
  if (match.teams) view.setTeams(match.teams);
  deps.container.classList.add('kc-ready');
  overlay.hudLayer.append(plates.el, hud.el);
  hud.show(true);

  const modal = <T>(build: (done: (v: T) => void) => HTMLElement): Promise<T> =>
    new Promise((resolve) => {
      let close = () => {};
      close = overlay.openModal(build((v) => {
        close();
        resolve(v);
      }));
    });

  controller = new GameController(match, {
    engine,
    view,
    players,
    lineup,
    pace: fast ? 0.6 : 1,
    save: saveGame,
    giveOptions,
    clearSave,
    onExit: () => {
      session.dispose();
      deps.onExit();
    },
    ui: {
      hud,
      say: (seat, text, strong) => plates.say(seat, text, strong),
      catchable: (seat, onCatch) => plates.setCatchable(seat, onCatch),
      bubbleFor,
      avatarEvent: (ev) => avatars.onEvent(ev),
      t: (k, p) => t(k, p),
      roundSummary: (ctx) =>
        modal<'next' | 'menu'>((done) => buildRoundSummary({ ...ctx, avatars: hud.avatars, speed: fast ? 0.6 : 1 }, () => done('next'), () => done('menu'))),
      matchEnd: (ctx) => modal<'rematch' | 'menu'>((done) => buildMatchEnd({ ...ctx, avatars: hud.avatars }, () => done('rematch'), () => done('menu'))),
    },
  });

  let disposed = false;
  let rotateBlocked = false;
  const sideSeating = !!match.teams && (match.teams[0].includes(1) || match.teams[0].includes(3));
  const stopLandscape = sideSeating
    ? requireLandscape(overlay.root, (blocked) => {
        rotateBlocked = blocked;
        if (blocked) {
          controller?.setPaused(true);
          avatars.setPaused(true);
        } else if (!pauseClose) {
          avatars.setPaused(false);
          controller?.setPaused(false);
        }
      })
    : () => {};
  const session: GameSession = {
    pause,
    resume: () => {
      closePause();
      if (rotateBlocked) return;
      avatars.setPaused(false);
      controller?.setPaused(false);
    },
    back: () => {
      if (pauseClose) session.resume();
      else pause();
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      stopLandscape();
      controller?.stop();
      hud.closeAll();
      avatars.setVisible(false);
      plates.el.remove();
      hud.el.remove();
      view.dispose();
      deps.container.classList.remove('kc-ready');
    },
  };

  if (restored && match.round && !match.round.over) {
    const r = match.round;
    view.setDeck([...r.deck, ...r.discard, ...r.hands.flat()]);
    await view.restore({ round: r, seats: match.seats });
  }
  void controller.run(restored).catch((e) => {
    console.error('[game]', e);
    session.dispose();
    deps.onExit();
  });
  return session;
}
