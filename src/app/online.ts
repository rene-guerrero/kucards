/**
 * Online play controller (lazy-loaded from main.ts), ported from Kudominoes. It plays the role of the
 * local GameSession + GameController, driven by the room server: 'events' are animated in order through
 * one queue (never overlapping); 'turn' (sent after every change) lights the seat to move with a quiet
 * timer ring and offers this player what they may do right now: on their turn the same flow as offline
 * (response bar, card pick, target / colour / gift pickers), out of turn a jump-in pick or a partner
 * shield; the ¡Ku! button is armed whenever a call or a catch is legal. A welcome/sync puts the table
 * back instantly through the view's restore path (no replay).
 *
 * The table is the offline one (TableView, HUD, plates, avatars). Seats are rotated into the local
 * perspective (src/net/perspective.ts), so everything works as in a local match ("seat 0 = me").
 */
import type { AppSettings, Card, GameEvent, GameMode, MatchState, Move, RuleSettings, Seat, SeatPlate } from '../contracts';
import { COLORS, NIGHT_COLORS, isNightColor } from '../contracts';
import type { FaceSpec } from '../roster';
import { character, ROSTER } from '../roster';
import { sanitizeFace } from 'kuavatars/faces';
import { createTableView, type TableViewExt } from '../render';
import { buildDeck } from '../engine/cards';
import { giveOptions } from '../engine/game';
import { AUTO_COLOR } from '../engine/ai';
import { AUTO_DRAW_MS } from './controller';
import { RULE_PRESETS, RULE_SETTINGS } from '../engine/rules';
import { voiceForEvent, VOICE_DELAY_MS } from '../audio/voice';
import { playSfx, powerSfxForEvent, setAudioPrefs, hapticTick, setMusicMode, setMusicScene } from '../audio/sfx';
import { inFinalMinute, sanitizeClock } from '../engine/clock';
import { RoomClient, httpBackend, NetError, type Backend, type ConnState } from '../net/client';
import { useMockServer, shareLink } from '../net/config';
import { displayCode, normalizeCode, playerId, rememberRoom, cleanName } from '../net/identity';
import { Perspective } from '../net/perspective';
import { applyEvent, applySnapshot, emptyMatch } from '../net/mirror';
import { isHidden, withPlaceholders } from '../net/redact';
import { CHAT_GESTURES, sanitizeGestures, TURN_TIMEOUT_MS, NEXT_ROUND_MS, type ChatGesture, type ErrorCode, type PublicRoom, type QuickPhraseId, type SeatView, type ServerMsg, type Snapshot } from '../net/protocol';
import { activeSeatsOf, buildLobby, buildOnlineHome, buildOnlinePause, buildRulesSheet, buildSeatSheet, occupantName, ONLINE_ICONS, phraseText, type Lobby, type OnlineHome } from '../ui/online';
import { AvatarController, humanFace, type AvatarExpr } from '../ui/avatarAdapter';
import { Hud, type HudPlayer, type ScoreRow } from '../ui/hud';
import { bubbleFor, SeatPlates } from '../ui/plates';
import { buildMatchEnd, buildRoundSummary, type RoundSummaryCtx } from '../ui/summary';
import { confirmDialog, type Overlay } from '../ui/overlay';
import { presetName } from '../ui/settings';
import { ChatButton } from '../ui/chat';
import { allPresets, loadProfiles } from './ruleProfiles';
import { h } from '../ui/dom';
import { t } from '../ui/i18n';
import { cardPoints } from '../engine/cards';
import { requireLandscape } from './orientation';
import { rulesFor, sanitizeRules } from './settings';

type HandleKey = keyof AppSettings;
type TurnMsg = Extract<ServerMsg, { t: 'turn' }>;
type RoundEnd = Extract<GameEvent, { type: 'roundEnd' }>;
type MatchEnd = Extract<GameEvent, { type: 'matchEnd' }>;

export interface OnlineDeps {
  overlay: Overlay;
  /** where the 3D table goes */
  container: HTMLElement;
  settings(): AppSettings;
  setSetting<K extends HandleKey>(key: K, v: AppSettings[K]): void;
  /** the table is about to be built (stop the menu backdrop) */
  onTableStart(): void;
  /** back to the main menu */
  onExit(): void;
}

interface Table {
  view: TableViewExt;
  hud: Hud;
  plates: SeatPlates;
  avatars: AvatarController;
  stopLandscape: () => void;
}

class Stale extends Error {}

const TURN_KINDS = new Set(['play', 'draw', 'pass', 'acceptPenalty', 'respond', 'challenge']);
const isTurnMove = (m: Move) => TURN_KINDS.has(m.kind);
/** events that never change what this player may do: a pending pick survives them */
const BENIGN = new Set(['ku', 'window', 'stack']);

const errorText = (code: ErrorCode | NetError['code'] | 'lost'): string =>
  code === 'room_not_found'
    ? t('online.err.notFound')
    : code === 'room_full'
      ? t('online.err.full')
      : code === 'version_mismatch'
        ? t('online.err.version')
        : code === 'offline'
          ? t('online.err.offline')
          : code === 'lost'
            ? t('online.err.lost')
            : t('online.err.server');

const PHRASE_FACE: Partial<Record<QuickPhraseId, AvatarExpr>> = { hello: 'happy', nice: 'amazed', oops: 'meh', thinking: 'thinking', gg: 'happy', thanks: 'happy', wow: 'amazed', hurry: 'smug' };

function sameMove(a: Move, b: Move | null | undefined): boolean {
  if (!b || a.kind !== b.kind || a.seat !== b.seat) return false;
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  return x.cardId === y.cardId && x.color === y.color && x.target === y.target;
}

export class OnlineController {
  private backend: Backend | null = null;
  private client: RoomClient | null = null;
  private pid = playerId();
  private mode: 'home' | 'lobby' | 'game' | 'off' = 'off';
  private home: OnlineHome | null = null;
  private lobby: Lobby | null = null;
  private room: PublicRoom | null = null;
  private mySeat: Seat | null = null;
  private isHost = false;
  private joinWait: { resolve: () => void; reject: (e: string) => void } | null = null;
  // ── game ──
  private table: Table | null = null;
  private persp: Perspective | null = null;
  private mirror: MatchState | null = null;
  private deckFaces = new Map<number, Card>();
  private prevScores: number[] = [];
  private queue: (() => Promise<void>)[] = [];
  private pumping = false;
  private gen = 0;
  private staleRej: (e: Error) => void = () => {};
  private stale: Promise<never> = this.newStale();
  /** the latest state from the server (local perspective) */
  private turn: TurnMsg | null = null;
  /** the interaction offered to the player right now (pick / pickers / response bar) */
  private prompt: { id: number; key: string } | null = null;
  private promptSeq = 0;
  private closeSummary: (() => void) | null = null;
  private closeMatchEnd: (() => void) | null = null;
  private closeMenu: (() => void) | null = null;
  private closeSheet: (() => void) | null = null;
  private chat: ChatButton | null = null;
  private netChip: HTMLElement | null = null;
  private hiddenAt = 0;
  private lastNotice = '';
  private jumpHinted = false;

  constructor(private deps: OnlineDeps) {
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('online', this.onOnline);
    if (import.meta.env.DEV) (window as unknown as { __kucaNet: unknown }).__kucaNet = { ctl: this, drop: () => this.client?.resync() };
  }

  /** the mock backend is loaded lazily (dev only) */
  private async ensureBackend(): Promise<Backend> {
    // (dev only: the branch is dead code in production builds, so the mock never ships)
    if (import.meta.env.DEV && !this.backend && useMockServer()) this.backend = (await import('../net/mock/backend')).mockBackend();
    this.backend ??= httpBackend();
    return this.backend;
  }

  get active(): boolean {
    return this.mode !== 'off';
  }

  private get settings(): AppSettings {
    return this.deps.settings();
  }

  // ───────────────────────── screens ─────────────────────────

  /** open the "Jugar en línea" screen; with a code (share link / reload) join it right away */
  open(code?: string, quiet = false): void {
    this.mode = 'home';
    const s = this.settings;
    const home = buildOnlineHome({
      name: s.playerName,
      face: s.avatarFace ?? 0,
      avatars: s.avatars !== false,
      code,
      onName: (n) => this.deps.setSetting('playerName', cleanName(n)),
      onCreate: () => void this.create(),
      onJoin: (c) => void this.join(c),
      onBack: () => this.exit(),
    });
    this.home = home;
    this.deps.overlay.showScreen(home.el);
    if (!s.playerName) home.askName();
    if (code && s.playerName) void this.join(code, quiet);
    else if (code) home.setError(t('online.nameNeeded'));
  }

  private async create(): Promise<void> {
    const home = this.home;
    home?.setBusy('create');
    home?.setError(null);
    try {
      const be = await this.ensureBackend();
      const code = await be.createRoom(this.pid);
      await this.connect(code);
    } catch (e) {
      if (this.home !== home) return;
      home?.setBusy(null);
      home?.setError(errorText(e instanceof NetError ? e.code : typeof e === 'string' ? (e as ErrorCode) : 'server'));
    }
  }

  /** quiet: a rejoin after a reload — a room that is gone just goes back to the menu */
  private async join(raw: string, quiet = false): Promise<void> {
    const code = normalizeCode(raw);
    const home = this.home;
    if (!code) return home?.setError(t('online.err.notFound'));
    home?.setBusy('join');
    home?.setError(null);
    try {
      const be = await this.ensureBackend();
      const info = await be.roomInfo(code);
      if (!info.exists) throw new NetError('room_not_found');
      await this.connect(code);
    } catch (e) {
      if (this.home !== home) return;
      rememberRoom(null);
      if (quiet) return this.exit();
      home?.setBusy(null);
      home?.setError(errorText(e instanceof NetError ? e.code : typeof e === 'string' ? (e as ErrorCode) : 'server'));
    }
  }

  /** open the socket and wait for the welcome (or a fatal error) */
  private connect(code: string): Promise<void> {
    this.client?.stop();
    const client: RoomClient = new RoomClient({
      backend: this.backend!,
      code,
      identity: () => {
        const s = this.settings;
        return { playerId: this.pid, name: s.playerName || t('seat.player'), face: s.avatarFace ?? 0 };
      },
      onMessage: (m) => this.client === client && this.onMessage(m),
      onState: (st) => this.client === client && this.onConnState(st),
      onFatal: (c) => this.client === client && this.onFatal(c),
    });
    this.client = client;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.joinWait) {
          this.joinWait = null;
          client.stop();
          reject('offline');
        }
      }, 12_000);
      this.joinWait = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      client.start();
    });
  }

  private onFatal(code: ErrorCode): void {
    if (this.joinWait) {
      const w = this.joinWait;
      this.joinWait = null;
      return w.reject(code);
    }
    // thrown out of a room we were in: back to the online screen with the reason
    this.teardownRoom();
    rememberRoom(null);
    this.open();
    this.home?.setError(errorText(code));
  }

  private onConnState(st: ConnState): void {
    const text = st === 'reconnecting' ? t('online.reconnecting') : '';
    this.lobby?.setConn(text);
    if (this.netChip) {
      this.netChip.textContent = text;
      this.netChip.classList.toggle('on', st === 'reconnecting');
    }
  }

  private showLobby(): void {
    if (!this.room) return;
    if (this.mode === 'game') this.leaveGameUi();
    this.mode = 'lobby';
    this.home = null;
    if (!this.lobby || !this.lobby.el.isConnected) {
      const s = this.settings;
      this.lobby = buildLobby({
        code: this.room.code,
        avatars: s.avatars !== false,
        myId: this.pid,
        presetName: (mode, rules) => presetName(allPresets(), RULE_SETTINGS, rules, mode),
        onShare: () => void this.share(),
        onSeat: (seat) => this.tapSeat(seat),
        onMode: (mode, count, teamPlay) => {
          const changed = mode !== this.room?.mode;
          this.client?.send({ t: 'setMode', mode, playerCount: count, teamPlay: !!teamPlay });
          if (changed) this.client?.send({ t: 'setRules', rules: { ...rulesFor(this.settings, mode) } });
        },
        onRules: () => this.openRules(),
        onClock: (c) => {
          this.deps.setSetting('clock', c);
          this.client?.send({ t: 'setClock', clock: c });
        },
        onStart: () => this.client?.send({ t: 'start' }),
        onLeave: () => void this.confirmLeave(),
      });
      this.deps.overlay.showScreen(this.lobby.el);
    }
    this.lobby.update(this.room, { seat: this.mySeat, isHost: this.isHost });
  }

  private tapSeat(seat: Seat): void {
    const room = this.room;
    if (!room || room.phase === 'playing') return;
    const occ = room.seats[seat];
    if (!occ || occ.kind === 'human') return;
    if (!this.isHost) {
      this.client?.send({ t: 'sit', seat });
      return;
    }
    const taken = room.seats.flatMap((o, s) => (o.kind === 'cpu' && s !== seat ? [o.characterId] : []));
    const done = () => {
      this.closeSheet?.();
      this.closeSheet = null;
    };
    const card = buildSeatSheet({
      current: occ.kind === 'cpu' ? occ.characterId : null,
      taken,
      canSit: this.mySeat !== seat,
      avatars: this.settings.avatars !== false,
      onSit: () => {
        this.client?.send({ t: 'sit', seat });
        done();
      },
      onPick: (id) => {
        this.client?.send({ t: 'setCpu', seat, characterId: id });
        done();
      },
      onClear: () => {
        this.client?.send({ t: 'setCpu', seat, characterId: null });
        done();
      },
      onClose: done,
    });
    this.closeSheet?.();
    this.closeSheet = this.deps.overlay.openModal(card);
  }

  private openRules(): void {
    const room = this.room;
    if (!room || !this.isHost) return;
    const preset = RULE_PRESETS.find((p) => p.id === room.mode);
    const mine = rulesFor(this.settings, room.mode);
    const same = (a: RuleSettings, b: RuleSettings) => JSON.stringify(sanitizeRules(a, room.mode)) === JSON.stringify(sanitizeRules(b, room.mode));
    const opts: { label: string; rules: RuleSettings }[] = [];
    if (preset) opts.push({ label: presetName(RULE_PRESETS, RULE_SETTINGS, preset.rules, room.mode), rules: { ...preset.rules } });
    // the host's saved profiles of this mode, then their current rules (when not already listed)
    for (const p of loadProfiles()) {
      if (p.mode !== room.mode || opts.some((x) => same(x.rules, p.rules))) continue;
      opts.push({ label: p.name, rules: { ...p.rules } });
    }
    if (!opts.some((x) => same(x.rules, mine))) opts.push({ label: `${t('lobby.myRules')} · ${presetName(allPresets(), RULE_SETTINGS, mine, room.mode)}`, rules: mine });
    const done = () => {
      this.closeSheet?.();
      this.closeSheet = null;
    };
    const card = buildRulesSheet({
      options: opts.map((o) => ({
        label: o.label,
        selected: same(o.rules, room.rules),
        onPick: () => {
          this.client?.send({ t: 'setRules', rules: { ...o.rules } });
          done();
        },
      })),
      onClose: done,
    });
    this.closeSheet?.();
    this.closeSheet = this.deps.overlay.openModal(card);
  }

  private async share(): Promise<void> {
    const code = this.room?.code;
    if (!code) return;
    const url = shareLink(code);
    const data = { title: t('lobby.shareTitle'), text: t('lobby.shareText', { code: displayCode(code) }), url };
    const nav = navigator as Navigator & { share?: (d: ShareData) => Promise<void>; canShare?: (d: ShareData) => boolean };
    if (nav.share && (!nav.canShare || nav.canShare(data))) {
      try {
        await nav.share(data);
        return;
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') return;
      }
    }
    try {
      await navigator.clipboard.writeText(`${data.text}\n${url}`);
    } catch {
      const ta = h('textarea', { style: 'position:fixed;opacity:0' }) as HTMLTextAreaElement;
      ta.value = url;
      document.body.append(ta);
      ta.select();
      document.execCommand?.('copy');
      ta.remove();
    }
    this.lobby?.flashCopied();
  }

  private async confirmLeave(): Promise<void> {
    const ok = await confirmDialog(this.deps.overlay, {
      title: t('lobby.leaveTitle'),
      body: this.mode === 'game' && !this.mirror?.over ? t('lobby.leaveBodyGame') : t('lobby.leaveBody'),
      ok: t('lobby.leaveOk'),
      cancel: t('common.cancel'),
      danger: true,
    });
    if (ok) this.leave();
  }

  /** leave the room for good and go back to the main menu */
  leave(): void {
    this.client?.leave();
    rememberRoom(null);
    this.exit();
  }

  private exit(): void {
    this.teardownRoom();
    this.mode = 'off';
    this.deps.onExit();
  }

  private teardownRoom(): void {
    this.client?.stop();
    this.client = null;
    if (this.mode === 'game') this.leaveGameUi();
    this.closeSheet?.();
    this.closeSheet = null;
    this.room = null;
    this.lobby = null;
    this.home = null;
    this.mySeat = null;
    this.isHost = false;
    // the share link has done its job
    if (/[?&]sala=/.test(location.search)) {
      const u = new URL(location.href);
      u.searchParams.delete('sala');
      history.replaceState(history.state, '', u.toString());
    }
  }

  /** Escape / Android back */
  back(): void {
    if (this.closeSheet) {
      this.closeSheet();
      this.closeSheet = null;
      return;
    }
    if (this.mode === 'home') return this.exit();
    if (this.mode === 'lobby') return void this.confirmLeave();
    if (this.mode === 'game') {
      if (this.chat?.isOpen) return this.chat.toggle(false);
      if (this.closeMenu) return this.resumeFromMenu();
      this.openMenu();
    }
  }

  // ───────────────────────── messages ─────────────────────────

  private applyRoom(room: PublicRoom): void {
    const prev = this.room;
    this.room = room;
    const seat = room.seats.findIndex((o) => o.kind === 'human' && o.playerId === this.pid);
    this.mySeat = seat >= 0 ? (seat as Seat) : null;
    this.isHost = room.hostId === this.pid;
    if (this.mode === 'game' && prev) this.presenceNotices(prev, room);
    // the host's own rules are the room default (once, when the room is fresh)
    if (this.isHost && room.phase === 'lobby' && !prev) {
      const mine = rulesFor(this.settings, room.mode);
      if (JSON.stringify(sanitizeRules(mine, room.mode)) !== JSON.stringify(sanitizeRules(room.rules, room.mode))) this.client?.send({ t: 'setRules', rules: { ...mine } });
      // and so are the host's last clocks
      this.client?.send({ t: 'setClock', clock: sanitizeClock(this.settings.clock) });
    }
  }

  private onMessage(msg: ServerMsg): void {
    switch (msg.t) {
      case 'welcome': {
        this.applyRoom(msg.room);
        rememberRoom(msg.room.code);
        if (this.joinWait) {
          this.joinWait.resolve();
          this.joinWait = null;
        }
        if (msg.view && msg.room.phase === 'playing') this.startRestore(msg.room, msg.view);
        else if (this.mode === 'game' && msg.room.phase === 'finished' && this.mirror?.over) this.refreshNames();
        else this.showLobby();
        break;
      }
      case 'room': {
        this.applyRoom(msg.room);
        if (msg.room.phase === 'playing') {
          if (this.mode !== 'game') {
            if (this.mySeat !== null) this.enterGame();
          } else this.refreshNames();
        } else if (this.mode === 'game') {
          // finished: the match-end card stays; anything else returns to the lobby
          if (!this.mirror?.over && msg.room.phase === 'lobby') this.showLobby();
          else this.refreshNames();
        } else this.showLobby();
        break;
      }
      case 'sync':
        this.applyRoom(msg.room);
        this.startRestore(msg.room, msg.view);
        break;
      case 'events':
        if (this.mode !== 'game') {
          if (this.mySeat === null || !this.room) return;
          this.enterGame();
        }
        // the events themselves settle a previewed card (played → coloured in place, anything else → back to the hand)
        if (msg.events.some((e) => !BENIGN.has(e.type))) this.cancelPrompt(false);
        this.enqueueEvents(msg.events, msg.snap);
        break;
      case 'turn':
        if (this.mode !== 'game') return;
        this.enqueueTurn(msg);
        break;
      case 'covered':
        if (this.mode !== 'game') return;
        this.enqueue(async () => this.onCovered(msg.seat, msg.reason));
        break;
      case 'phrase':
        if (this.mode !== 'game' || !this.persp) return;
        this.showPhrase(this.persp.seat(msg.seat), msg.id);
        break;
      case 'error':
        if (msg.code === 'bad_move') this.client?.resync();
        else if (msg.code === 'too_late' && this.turn) {
          // someone was faster: offer again whatever is still possible
          this.prompt = null;
          this.enqueue(async () => {
            if (this.turn) this.offer(this.turn);
          });
        }
        else if (import.meta.env.DEV && msg.code !== 'rate_limited' && msg.code !== 'too_late') console.warn('[online] server error', msg.code, msg.message ?? '');
        break;
      case 'pong':
        break;
    }
  }

  private presenceNotices(prev: PublicRoom, room: PublicRoom): void {
    const p = this.persp;
    const hud = this.table?.hud;
    if (!p || !hud) return;
    for (const s of [0, 1, 2, 3] as Seat[]) {
      const a = prev.seats[s];
      const b = room.seats[s];
      if (!a || !b || p.seat(s) === 0) continue;
      if (a.kind === 'human' && b.kind === 'human' && a.playerId === b.playerId) {
        if (!a.cpuCovering && b.cpuCovering) hud.notice(t('online.covered.disconnected', { name: b.name }));
        else if (!a.connected && b.connected) hud.notice(t('online.back', { name: b.name }));
      } else if (a.kind === 'human' && b.kind !== 'human') hud.notice(t('online.left', { name: a.name }));
      else if (b.kind === 'human' && (a.kind !== 'human' || a.playerId !== b.playerId)) hud.notice(t('online.joined', { name: b.name }));
    }
  }

  // ───────────────────────── table ─────────────────────────

  /** names and faces by local seat */
  private players(): { names: string[]; faces: FaceSpec[] } {
    const names: string[] = ['', '', '', '', '', ''];
    const faces: FaceSpec[] = names.map(() => ROSTER[3].face);
    const room = this.room;
    const p = this.persp;
    if (!room || !p) return { names, faces };
    for (const l of [0, 1, 2, 3] as Seat[]) {
      const o = room.seats[p.server(l)] ?? { kind: 'empty' as const };
      if (l === 0) {
        names[0] = this.settings.playerName || (o.kind === 'human' ? o.name : t('seat.you'));
        faces[0] = humanFace(this.settings.avatarFace ?? 0);
        continue;
      }
      names[l] = o.kind === 'empty' ? '' : occupantName(o);
      if (o.kind === 'human') faces[l] = sanitizeFace(o.face);
      else if (o.kind === 'cpu') faces[l] = character(o.characterId).face;
    }
    return { names, faces };
  }

  private teamOf(seat: Seat): 0 | 1 | undefined {
    const tm = this.mirror?.teams;
    return tm ? (tm[0].includes(seat) ? 0 : 1) : undefined;
  }

  private hudPlayers(counts?: number[]): HudPlayer[] {
    const { names, faces } = this.players();
    return (this.mirror?.seats ?? []).map((s) => ({ seat: s, name: names[s], face: faces[s], count: counts?.[s] ?? this.mirror?.round?.hands[s]?.length ?? 0, team: this.teamOf(s) }));
  }

  private refreshNames(): void {
    const tb = this.table;
    if (!tb || !this.persp) return;
    const { names, faces } = this.players();
    tb.plates.setNames(names);
    for (const s of this.mirror?.seats ?? []) tb.avatars.setSeatFace(s, faces[s], names[s]);
    tb.hud.setPlayers(this.hudPlayers());
    tb.hud.setScores(this.scoreRows());
  }

  /** the offline table (view, HUD, plates, avatars) for the current room */
  private buildTable(): void {
    if (this.table || !this.mirror) return;
    this.deps.onTableStart();
    const s = this.settings;
    const m = this.mirror;
    const avatars = new AvatarController();
    avatars.setSeats(m.seats);
    avatars.setQuality(s.quality);
    avatars.setReducedMotion(!!s.reducedMotion);
    const plates = new SeatPlates(avatars);
    plates.setAvatars(s.avatars !== false);
    const hud = new Hud(this.deps.overlay, () => this.openMenu());
    hud.avatars = s.avatars !== false;
    hud.onKu = () => this.onKuTap();
    const fast = s.animationSpeed === 'fast';
    const view = createTableView({
      container: this.deps.container,
      quality: s.quality,
      language: s.language,
      reducedMotion: !!s.reducedMotion,
      speed: fast ? 1.6 : 1,
      tableStyle: s.tableStyle,
      cardBack: s.cardBack,
      seats: m.seats,
      onSfx: playSfx,
      onPlates: (list: readonly SeatPlate[]) => {
        plates.update(list.map((p) => ({ ...p, team: this.teamOf(p.seat) })));
        hud.placeKu(list.find((p) => p.seat === 0), innerWidth, innerHeight);
        const counts: number[] = [];
        for (const p of list) counts[p.seat] = p.count;
        hud.setPlayers(this.hudPlayers(counts));
      },
      onError: (e) => console.error('[table]', e),
    });
    view.setTeams(m.teams ?? null);
    hud.colorAnchor = () => view.pileScreenPoint();
    this.deps.container.classList.add('kc-ready');
    this.deps.overlay.hudLayer.append(plates.el, hud.el);
    hud.show(true);
    // no mode forces landscape any more (the tuned layout fits portrait too)
    const side = false;
    const stopLandscape = side ? requireLandscape(this.deps.overlay.root, (blocked) => avatars.setPaused(blocked)) : () => {};
    this.table = { view, hud, plates, avatars, stopLandscape };
    this.refreshNames();
    this.buildGameChrome();
  }

  private disposeTable(): void {
    const tb = this.table;
    if (!tb) return;
    this.table = null;
    this.chat?.hide();
    tb.stopLandscape();
    tb.view.cancelHumanPick();
    tb.hud.closeAll();
    tb.avatars.setVisible(false);
    tb.plates.setTimer(null);
    tb.plates.el.remove();
    tb.hud.el.remove();
    tb.view.dispose();
    this.deps.container.classList.remove('kc-ready');
  }

  private newPersp(room: PublicRoom, seat: Seat): Perspective {
    return new Perspective(seat, activeSeatsOf(room));
  }

  /** from the lobby to the table (events follow) */
  private enterGame(): void {
    if (!this.room || this.mySeat === null) return;
    this.mode = 'game';
    this.closeSheet?.();
    this.closeSheet = null;
    this.lobby = null;
    this.deps.overlay.showScreen(null);
    this.beginFresh();
  }

  /** a fresh mirror (new match / rematch) on a (re)built table */
  private beginFresh(): void {
    const room = this.room;
    if (!room || this.mySeat === null) return;
    this.closeMatchEnd?.();
    this.closeMatchEnd = null;
    this.closeSummary?.();
    this.closeSummary = null;
    this.persp = this.newPersp(room, this.mySeat);
    this.mirror = emptyMatch(room.rules, room.mode, this.persp.localSeats(), this.persp.teams(room.teams));
    this.disposeTable();
    this.buildTable();
  }

  private buildGameChrome(): void {
    setMusicScene('game');
    const layer = this.deps.overlay.hudLayer;
    this.chat?.hide();
    const tb = this.table;
    if (tb) {
      this.chat = new ChatButton({
        layer,
        plates: tb.plates,
        gestures: () => sanitizeGestures(this.settings.gestures),
        face: () => humanFace(this.settings.avatarFace ?? 0),
        onGesture: (g) => this.client?.send({ t: 'phrase', id: `g:${g}` }),
        onPhrase: (id) => this.client?.send({ t: 'phrase', id }),
      });
      this.chat.show();
    }
    if (!this.netChip) this.netChip = h('div.net-chip', { role: 'status', 'aria-live': 'polite' });
    layer.append(this.netChip);
    this.onConnState(this.client?.connState ?? 'open');
  }

  private showPhrase(seat: Seat, id: string): void {
    // a gesture: the seat's avatar makes it (older clients ignore these ids)
    if (id.startsWith('g:')) {
      const g = id.slice(2);
      if ((CHAT_GESTURES as readonly string[]).includes(g)) this.table?.avatars.gesture(seat, g as ChatGesture);
      return;
    }
    const text = phraseText(id);
    if (!text || !this.table) return;
    this.table.plates.say(seat, text, false, 2400);
    const e = PHRASE_FACE[id as QuickPhraseId];
    if (e) this.table.avatars.react(seat, e, 1.6);
  }

  private leaveGameUi(): void {
    this.bumpGen();
    this.setRoundClock(null);
    setMusicScene('menu');
    this.chat?.hide();
    this.chat = null;
    this.netChip?.remove();
    for (const c of [this.closeSummary, this.closeMatchEnd, this.closeMenu]) c?.();
    this.closeSummary = this.closeMatchEnd = this.closeMenu = null;
    this.disposeTable();
    this.persp = null;
    this.mirror = null;
    this.turn = null;
    if (this.mode === 'game') this.mode = 'off';
  }

  // ───────────────────────── queue ─────────────────────────

  private newStale(): Promise<never> {
    const p = new Promise<never>((_, rej) => (this.staleRej = rej));
    p.catch(() => {});
    return p;
  }

  /** drop everything queued or running (a full snapshot replaces it) */
  private bumpGen(): void {
    this.gen++;
    this.queue = [];
    this.staleRej(new Stale());
    this.stale = this.newStale();
    this.cancelPrompt();
  }

  private enqueue(fn: () => Promise<void>): void {
    this.queue.push(fn);
    if (!this.pumping) void this.pump();
  }

  private async pump(): Promise<void> {
    this.pumping = true;
    try {
      while (this.queue.length) {
        const fn = this.queue.shift()!;
        try {
          await fn();
        } catch (e) {
          if (!(e instanceof Stale)) console.error('[online] step failed', e);
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  /** await `p` unless the queue is reset meanwhile */
  private async w<T>(p: Promise<T>): Promise<T> {
    const g = this.gen;
    const v = await Promise.race([p, this.stale]);
    if (g !== this.gen) throw new Stale();
    return v;
  }

  // ───────────────────────── events ─────────────────────────

  private localSnap(snap: Snapshot): Snapshot {
    const p = this.persp!;
    return { counts: p.perSeat(snap.counts), deck: snap.deck, pending: snap.pending, hands: snap.hands.map((x) => ({ seat: p.seat(x.seat), cards: x.cards })) };
  }

  private enqueueEvents(raw: GameEvent[], rawSnap: Snapshot): void {
    const p = this.persp;
    if (!p) return;
    // far behind (a slow phone, a busy tab): a snapshot catches up at once
    if (this.queue.length > 40) return this.client?.resync();
    const evs = raw.map((e) => p.event(e));
    const snap = this.localSnap(rawSnap);
    evs.forEach((ev, i) => {
      const at = Date.now();
      this.enqueue(async () => this.playEvent(ev, snap, i === evs.length - 1, at));
    });
  }

  private faceOf = (id: number): Card | null => this.deckFaces.get(id) ?? null;

  private async playEvent(ev: GameEvent, snap: Snapshot, last: boolean, receivedAt: number): Promise<void> {
    if (!this.mirror || !this.table) return;
    // a rematch: the first deal of a new match gets a fresh table, HUD and scores
    if (ev.type === 'deal' && this.mirror.over) this.beginFresh();
    const tb = this.table;
    const m0 = this.mirror;
    if (!tb || !m0) return;
    const { view, hud, avatars, plates } = tb;
    if (ev.type === 'deal') {
      this.closeSummary?.();
      this.closeSummary = null;
      this.closeMatchEnd?.();
      this.closeMatchEnd = null;
      const deck = buildDeck(m0.rules);
      this.deckFaces = new Map(deck.map((c) => [c.id, c]));
      view.setDeck(deck);
      const target = Number(m0.rules.target) || 0;
      hud.setTarget(target || null);
      this.prevScores = m0.scores.slice();
    }
    if (ev.type === 'play' || ev.type === 'roundEnd' || ev.type === 'deal') plates.setTimer(null);
    if (ev.type === 'roundEnd' || ev.type === 'deal') {
      this.setRoundClock(null);
      plates.clearRanks();
    }
    let m = applyEvent(m0, ev, this.faceOf);
    // the hands this player may see change wholesale: take them from the snapshot
    if ((ev.type === 'deal' || ev.type === 'swapHands' || ev.type === 'rotateHands') && m.round) {
      const hands = m.round.hands.slice();
      for (const x of snap.hands) if (x.seat !== 0) hands[x.seat] = x.cards.slice();
      m = { ...m, round: { ...m.round, hands } };
    }
    if (last || ev.type === 'roundEnd') m = applySnapshot(m, snap);
    this.mirror = m;
    avatars.onEvent(ev);
    const b = bubbleFor(ev);
    if (b) plates.say(b.seat, b.text, b.strong);
    if (ev.type === 'ku') void hud.kuPop(this.players().names[ev.seat]);
    if (ev.type === 'roundEnd' && ev.byTime && m.round) {
      // time is up: every hand face up for a beat, then the verdict
      for (const s of m.seats) if (s !== 0 && m.round.hands[s]?.length) view.setOpenHand(s, m.round.hands[s].slice());
      await this.w(new Promise<void>((res) => setTimeout(res, 1100)));
    }
    // "Draw N!" starts as the drawing starts; the others once their card has landed
    if (ev.type === 'draw') voiceForEvent(ev, 60);
    await this.w(this.watchdog(view.handle(ev), ev));
    powerSfxForEvent(ev);
    // another player's wild: their pick shows on the colour diamond before play goes on
    if (ev.type === 'play' && ev.seat !== 0 && ev.color && ev.card.face.color === null) await hud.showColorChoice(ev.color, isNightColor(ev.color) ? NIGHT_COLORS : COLORS);
    if (ev.type !== 'draw') voiceForEvent(ev, VOICE_DELAY_MS);
    this.refreshHud(ev.type === 'roundEnd');
    if (ev.type === 'roundEnd') {
      hud.setKu('hidden');
      view.setTurn(null);
      await this.w(this.roundSummary(ev, receivedAt));
    } else if (ev.type === 'matchEnd') this.showMatchEnd(ev);
  }

  /**
   * An animation that never finishes would freeze the table while the match goes on without us: after
   * a generous limit, stop waiting and take a fresh snapshot instead (instant restore).
   */
  private watchdog(p: Promise<void>, ev: GameEvent): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (document.hidden) return;
        console.warn('[online] animation stuck, resyncing', ev.type);
        reject(new Stale());
        this.client?.resync();
      }, 15_000);
      p.then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        (e) => {
          clearTimeout(timer);
          reject(e);
        },
      );
    });
  }

  private refreshHud(bump = false): void {
    const tb = this.table;
    const m = this.mirror;
    if (!tb || !m) return;
    const r = m.round;
    if (r) {
      tb.hud.setPending(r.pendingDraw);
      tb.hud.setRound(r.roundNo);
    }
    tb.hud.setScores(this.scoreRows(), bump);
    this.revealPartner();
  }

  private partnerSeat(): Seat | null {
    const team = this.mirror?.teams?.find((x) => x.includes(0));
    return (team?.find((s) => s !== 0) as Seat | undefined) ?? null;
  }

  /** Parejas with partnerOpen: the partner's hand face up (as offline) */
  private revealPartner(): void {
    const p = this.partnerSeat();
    const m = this.mirror;
    const r = m?.round;
    if (p === null || !m || !this.table) return;
    const cards = r?.hands[p] ?? [];
    const open = m.rules.partnerOpen !== false && !!r && !r.over && cards.every((c) => !isHidden(c));
    this.table.view.setOpenHand(p, open ? cards.slice() : null);
  }

  private scoreRows(): ScoreRow[] {
    const m = this.mirror;
    if (!m) return [];
    const { names } = this.players();
    if (m.teams) {
      const mine = m.teams[0].includes(0) ? 0 : 1;
      return m.teams.map((team, i) => ({ label: t(team.includes(0) ? 'team.a' : 'team.b'), value: m.scores[team[0]] ?? 0, me: i === mine, team: i as 0 | 1 }));
    }
    return m.seats.map((s) => ({ label: names[s], value: m.scores[s] ?? 0, me: s === 0 }));
  }

  /** the round summary: closes by itself just before the next deal */
  private roundSummary(ev: RoundEnd, receivedAt: number): Promise<void> {
    const tb = this.table!;
    const m = this.mirror!;
    const r = m.round!;
    const s = this.settings;
    const { names, faces } = this.players();
    const target = Number(m.rules.target) || 0;
    const players = m.seats.map((seat) => {
      const hand = r.hands[seat] ?? [];
      return {
        seat,
        name: names[seat],
        face: faces[seat],
        cardsLeft: hand.length,
        handPoints: hand.reduce((sum, c) => sum + (isHidden(c) ? 0 : cardPoints(c.face)), 0),
        prev: this.prevScores[seat] ?? 0,
        total: m.scores[seat] ?? 0,
        team: this.teamOf(seat),
        eliminated: r.eliminated[seat],
      };
    });
    const teams: RoundSummaryCtx['teams'] = m.teams
      ? ([0, 1].map((i) => {
          const p = players.find((x) => x.seat === m.teams![i][0])!;
          return { name: t(m.teams![i].includes(0) ? 'team.a' : 'team.b'), prev: p.prev, total: p.total };
        }) as RoundSummaryCtx['teams'])
      : undefined;
    const matchOver = m.over;
    return new Promise<void>((resolve) => {
      let closed = false;
      let close = () => {};
      const done = () => {
        if (closed) return;
        closed = true;
        close();
        tb.avatars.setPaused(false);
        if (this.closeSummary === done) this.closeSummary = null;
        resolve();
      };
      const card = buildRoundSummary(
        { roundNo: r.roundNo, winner: ev.winner, points: ev.points[ev.winner] ?? 0, players, teams, target: target || null, matchOver, byTime: !!ev.byTime, avatars: s.avatars !== false, speed: s.animationSpeed === 'fast' ? 0.6 : 1 },
        done,
        () => void this.confirmLeave(),
      );
      card.classList.add('online-summary');
      // no blocking "Otra ronda": a quiet countdown bar until the next deal
      if (!matchOver) {
        const left = Math.max(1500, NEXT_ROUND_MS - 700 - (Date.now() - receivedAt));
        card.append(h('div.summary-countdown', h('span', { style: `animation-duration:${left}ms` })));
        setTimeout(done, left);
      } else setTimeout(done, 3500);
      close = this.deps.overlay.openModal(card);
      this.closeSummary = done;
    });
  }

  private showMatchEnd(ev: MatchEnd): void {
    const m = this.mirror!;
    const s = this.settings;
    const { names, faces } = this.players();
    const teams = m.teams
      ? (m.teams.map((team, i) => ({ name: t(team.includes(0) ? 'team.a' : 'team.b'), prev: m.scores[team[0]] ?? 0, total: m.scores[team[0]] ?? 0 })) as [{ name: string; prev: number; total: number }, { name: string; prev: number; total: number }])
      : undefined;
    const card = buildMatchEnd(
      {
        winner: ev.winner,
        winnerTeam: ev.winnerTeam ?? undefined,
        teams,
        players: m.seats.map((seat) => ({ seat, name: names[seat], face: faces[seat], total: m.scores[seat] ?? 0, team: this.teamOf(seat) })),
        avatars: s.avatars !== false,
      },
      () => this.client?.send({ t: 'rematch' }),
      () => this.leave(),
    );
    card.classList.add('online-match-end');
    // online: Revancha (host) / Salir; the others wait for the host
    const btns = card.querySelectorAll<HTMLButtonElement>('.sheet-actions .btn');
    const [menuBtn, rematchBtn] = [btns[0], btns[1]];
    const label = (b: HTMLElement | undefined, text: string) => {
      const l = b?.querySelector('.btn-label');
      if (l) l.textContent = text;
    };
    label(menuBtn, t('online.exit'));
    if (rematchBtn) {
      label(rematchBtn, t('online.rematch'));
      if (!this.isHost) rematchBtn.replaceWith(h('p.match-wait', h('span.lobby-wait-dot'), t('online.waitRematch')));
      else rematchBtn.addEventListener('click', () => rematchBtn.classList.add('is-loading'));
    }
    this.closeMatchEnd = this.deps.overlay.openModal(card);
  }

  // ───────────────────────── turns ─────────────────────────

  // ── the round clock (server-owned: roundEnds in 'turn'; the countdown runs here) ──
  private roundEnds: number | null = null;
  private clockTimer: ReturnType<typeof setInterval> | null = null;
  private frenzy = false;

  /** show the countdown to `ends` (server ms; null hides it and calms the music) */
  private setRoundClock(ends: number | null): void {
    if (ends === this.roundEnds && (ends === null || this.clockTimer)) return;
    this.roundEnds = ends;
    if (this.clockTimer) clearInterval(this.clockTimer);
    this.clockTimer = null;
    if (ends === null) {
      this.table?.hud.setClock(null, false);
      if (this.frenzy) setMusicMode('normal');
      this.frenzy = false;
      return;
    }
    const tick = () => {
      const tb = this.table;
      if (!tb || !this.client || this.roundEnds === null) return this.setRoundClock(null);
      const left = Math.max(0, this.client.toLocal(this.roundEnds) - Date.now());
      const final = inFinalMinute({ roundMin: 1, moveSec: 0, finalSec: 0 }, left);
      if (final !== this.frenzy) setMusicMode(final ? 'frenzy' : 'normal');
      this.frenzy = final;
      tb.hud.setClock(left, final);
    };
    this.clockTimer = setInterval(tick, 250);
    tick();
  }

  private setRing(seat: Seat | null, deadline: number | null): void {
    const tb = this.table;
    if (!tb) return;
    if (seat === null || deadline === null || !this.client) return tb.plates.setTimer(null);
    tb.plates.setTimer(seat, this.client.toLocal(deadline), this.turn?.moveMs ?? TURN_TIMEOUT_MS, seat === 0 ? 5000 : 0, () => {
      // a gentle nudge on my own turn: warm ring, one soft pulse, a light tick
      tb.plates.pulse(0);
      hapticTick();
    });
  }

  private enqueueTurn(raw: TurnMsg): void {
    this.enqueue(async () => {
      const p = this.persp;
      if (!p || !this.mirror?.round || this.mirror.round.over) return;
      const msg: TurnMsg = { ...raw, seat: p.seat(raw.seat), legal: raw.legal.map((x) => p.move(x)), ranks: raw.ranks?.map(([s, n]) => [p.seat(s), n]) };
      this.applyTurn(msg);
    });
  }

  /** the state from the server: highlight, ring, ¡Ku! button, and what I may do now */
  private applyTurn(msg: TurnMsg): void {
    const tb = this.table;
    const m = this.mirror;
    if (!tb || !m?.round) return;
    const prevSeat = this.turn?.seat;
    this.turn = msg;
    tb.view.setTurn(msg.seat);
    this.setRoundClock(msg.roundEnds ?? null);
    // final-minute position badges (server-ranked; absent = none)
    const ranks = new Map(msg.ranks ?? []);
    for (const s of m.seats) tb.plates.setRank(s, ranks.get(s) ?? null);
    if (prevSeat !== msg.seat || msg.deadline === null) this.setRing(msg.seat, msg.deadline);
    else if (msg.deadline) this.setRing(msg.seat, msg.deadline);
    this.refreshKu();
    this.offer(msg);
  }

  private refreshKu(): void {
    const tb = this.table;
    const m = this.mirror;
    const r = m?.round;
    if (!tb || !m || !r || r.over || !m.rules.kuCall) {
      tb?.plates.setCatchable(null);
      return tb?.hud.setKu('hidden');
    }
    const legal = this.turn?.legal ?? [];
    const catchMv = legal.find((x) => x.kind === 'catchKu');
    const callMv = legal.find((x) => x.kind === 'callKu');
    tb.plates.setCatchable(catchMv && catchMv.kind === 'catchKu' ? catchMv.target : null, () => this.onKuTap());
    if (catchMv && catchMv.kind === 'catchKu') {
      const note = t('game.catchHint', { name: this.players().names[catchMv.target] });
      if (note !== this.lastNotice) tb.hud.notice((this.lastNotice = note));
    } else this.lastNotice = '';
    tb.hud.setKu(catchMv || callMv ? 'armed' : r.hands[0].length <= 2 ? 'shown' : 'hidden');
  }

  private onKuTap(): void {
    const legal = this.turn?.legal ?? [];
    const mv = legal.find((x) => x.kind === 'catchKu') ?? legal.find((x) => x.kind === 'callKu');
    if (mv) this.send(mv);
  }

  private send(mv: Move): void {
    const p = this.persp;
    if (!p) return;
    if (!this.client?.send({ t: 'move', move: p.moveToServer(mv) })) this.client?.nudge();
  }

  private cancelPrompt(undoPreview = true): void {
    if (!this.prompt) return;
    this.prompt = null;
    this.table?.view.cancelHumanPick();
    if (undoPreview) this.table?.view.cancelPreview();
    this.table?.hud.closeAll();
  }

  private live(id: number): boolean {
    return this.prompt?.id === id;
  }

  /** offer what I may do right now (keeps a running offer when nothing changed) */
  private offer(msg: TurnMsg): void {
    const legal = msg.legal.filter((x) => x.kind !== 'callKu' && x.kind !== 'catchKu');
    const mine = msg.seat === 0 && legal.some(isTurnMove);
    const key = `${mine}|${JSON.stringify(legal)}`;
    if (this.prompt?.key === key) return;
    this.cancelPrompt();
    if (!legal.length) return;
    const id = ++this.promptSeq;
    this.prompt = { id, key };
    const ends = msg.windowEnds !== null && this.client ? this.client.toLocal(msg.windowEnds) : 0;
    const run = mine ? this.myTurn(id, legal.filter(isTurnMove), ends) : this.outOfTurn(id, legal, ends);
    void run.catch((e) => console.error('[online] prompt', e)).finally(() => {
      if (this.live(id)) this.prompt = null;
    });
  }

  /** my turn: the same flow as the offline humanTurn */
  private async myTurn(id: number, legal: Move[], windowEnds: number): Promise<void> {
    const tb = this.table!;
    const { view, hud } = tb;
    const m = this.mirror!;
    const r = m.round!;
    const plays = legal.filter((x): x is Extract<Move, { kind: 'play' }> => x.kind === 'play');
    const responds = legal.filter((x): x is Extract<Move, { kind: 'respond' }> => x.kind === 'respond');
    const challenge = legal.find((x) => x.kind === 'challenge');
    if (responds.length || challenge) {
      const kindOf = (cid: number) => r.hands[0].find((c) => c.id === cid)?.face.kind;
      const shield = responds.find((x) => kindOf(x.cardId) === 'shield');
      const mirror = responds.find((x) => kindOf(x.cardId) === 'mirror');
      const ms = windowEnds ? Math.max(1500, windowEnds - Date.now() - 300) : 8000;
      // stacking is mandatory: when a stack is possible there is no accept, the hand is the answer
      const acc = legal.find((x) => x.kind === 'acceptPenalty');
      const choice = await hud.showResponse({ total: r.pendingDraw, canShield: !!shield, canMirror: !!mirror, canChallenge: !!challenge, canStack: !acc, canAccept: !!acc, ms: Math.min(ms, 8000) });
      if (!this.live(id)) return;
      const mv = choice === 'shield' ? shield : choice === 'mirror' ? mirror : choice === 'challenge' ? challenge : undefined;
      if (mv) return this.send(mv);
      if (acc) return this.send(acc);
    }
    // a penalty I cannot stack, challenge or answer: drawn for me after a short beat
    if (legal.length === 1 && legal[0].kind === 'acceptPenalty') {
      await new Promise((res) => setTimeout(res, AUTO_DRAW_MS));
      if (!this.live(id)) return;
      return this.send(legal[0]);
    }
    const playable = [...new Set(plays.map((p) => p.cardId))];
    const drawLike = legal.find((x) => x.kind === 'draw' || x.kind === 'pass' || x.kind === 'acceptPenalty');
    // nothing playable: the pyramid over the deck is the only hint
    if (r.pendingDraw > 0 && playable.length) hud.notice(t('game.acceptHint', { n: r.pendingDraw }));
    const pick = await view.requestHumanPick(playable, !!drawLike);
    if (!this.live(id)) return;
    if (pick === 'draw') {
      if (drawLike) this.send(drawLike);
      return;
    }
    let variants = plays.filter((p) => p.cardId === pick);
    if (!variants.length) return;
    if (variants.some((v) => v.target !== undefined)) {
      const targets = [...new Set(variants.map((v) => v.target!))] as Seat[];
      const target = await hud.pickTarget(targets, t('hud.pickSwap'));
      if (!this.live(id)) return;
      variants = variants.filter((v) => v.target === target);
    }
    if (variants.some((v) => v.color) && r.hands[0].length === 1) {
      // the winning last card: red, no colour pane
      variants = variants.filter((v) => v.color === AUTO_COLOR);
    } else if (variants.some((v) => v.color)) {
      // the card lands on the pile first, then the colour is asked
      await view.previewPlay(pick);
      if (!this.live(id)) return;
      const color = await hud.pickColor();
      if (!this.live(id)) return;
      variants = variants.filter((v) => v.color === color);
    }
    let mv: Move | undefined = variants[0];
    const giveIds = mv ? giveOptions(this.mirror!, mv) : [];
    if (mv && giveIds.length) {
      hud.notice(t('game.giveHint'));
      const g = await view.requestHumanPick(giveIds, true);
      if (!this.live(id)) return;
      if (typeof g === 'number') mv = { ...(mv as Extract<Move, { kind: 'play' }>), give: g };
    }
    if (mv) this.send(mv);
  }

  /** out of my turn: shield my partner, or jump in with an identical card */
  private async outOfTurn(id: number, legal: Move[], windowEnds: number): Promise<void> {
    const tb = this.table!;
    const { view, hud } = tb;
    const r = this.mirror!.round!;
    const responds = legal.filter((x): x is Extract<Move, { kind: 'respond' }> => x.kind === 'respond');
    if (responds.length) {
      const kindOf = (cid: number) => r.hands[0].find((c) => c.id === cid)?.face.kind;
      const shield = responds.find((x) => kindOf(x.cardId) === 'shield');
      const mirror = responds.find((x) => kindOf(x.cardId) === 'mirror');
      const ms = windowEnds ? Math.max(800, windowEnds - Date.now() - 200) : 2500;
      const choice = await hud.showResponse({ total: r.pendingDraw, canShield: !!shield, canMirror: !!mirror, ms });
      if (!this.live(id)) return;
      const mv = choice === 'shield' ? shield : choice === 'mirror' ? mirror : undefined;
      if (mv) this.send(mv);
      return;
    }
    const jumps = legal.filter((x): x is Extract<Move, { kind: 'jumpIn' }> => x.kind === 'jumpIn');
    if (!jumps.length) return;
    if (!this.jumpHinted) {
      this.jumpHinted = true;
      hud.notice(t('online.jumpHint'));
    }
    const picked = await view.requestHumanPick([...new Set(jumps.map((j) => j.cardId))], false);
    if (!this.live(id) || typeof picked !== 'number') return;
    const options = jumps.filter((j) => j.cardId === picked);
    let mv = options[0];
    if (options.length > 1 && options.some((o) => o.target !== undefined)) {
      const target = await hud.pickTarget(options.map((o) => o.target!) as Seat[], t('hud.pickSwap'));
      if (!this.live(id)) return;
      mv = options.find((o) => o.target === target) ?? mv;
    }
    if (mv) this.send(mv);
  }

  private onCovered(serverSeat: Seat, reason: 'timeout' | 'disconnected'): void {
    const p = this.persp;
    const tb = this.table;
    if (!p || !tb) return;
    const seat = p.seat(serverSeat);
    this.setRing(null, null);
    if (seat === 0) this.cancelPrompt();
    const name = this.players().names[seat];
    if (reason === 'timeout') tb.hud.notice(seat === 0 ? t('online.covered.timeoutYou') : t('online.covered.timeout', { name }));
    tb.avatars.react(seat, 'meh', 2.4);
  }

  // ───────────────────────── restore ─────────────────────────

  /** a snapshot replaces whatever is queued; it runs in the queue so later events apply on top of it */
  private startRestore(room: PublicRoom, view: SeatView): void {
    this.bumpGen();
    const keep = this.mode === 'game' && !!this.table && this.persp?.me === view.seat;
    this.mode = 'game';
    // events right behind the snapshot are mapped with its perspective
    this.persp = this.newPersp(room, view.seat);
    this.enqueue(() => this.restore(room, view, keep));
  }

  /** put the table back from a snapshot in one frame (reconnect / resync) */
  private async restore(room: PublicRoom, view: SeatView, samePersp: boolean): Promise<void> {
    const g = this.gen;
    this.home = null;
    this.lobby = null;
    this.closeSheet?.();
    this.closeSheet = null;
    this.closeSummary?.();
    this.closeSummary = null;
    this.closeMatchEnd?.();
    this.closeMatchEnd = null;
    this.deps.overlay.showScreen(null);
    const p = this.persp ?? this.newPersp(room, view.seat);
    this.mode = 'game';
    this.persp = p;
    const m = p.match(withPlaceholders(view));
    this.mirror = { ...m, mode: room.mode as GameMode, teams: m.teams ?? p.teams(room.teams) };
    if (!samePersp) {
      this.disposeTable();
      this.buildTable();
    } else this.refreshNames();
    const tb = this.table!;
    const deck = buildDeck(this.mirror.rules);
    this.deckFaces = new Map(deck.map((c) => [c.id, c]));
    tb.view.setDeck(deck);
    this.prevScores = this.mirror.scores.slice();
    const r = this.mirror.round;
    tb.hud.setTarget(Number(this.mirror.rules.target) || null);
    if (r) {
      setAudioPrefs({ sound: false });
      try {
        await tb.view.restore({ round: r, seats: this.mirror.seats });
      } finally {
        setAudioPrefs({ sound: this.settings.sound });
      }
      if (g !== this.gen) return;
    }
    this.refreshHud();
    if (this.mirror.over) {
      const mm = this.mirror;
      this.showMatchEnd({ type: 'matchEnd', winner: mm.winner, winnerTeam: mm.winnerTeam ?? undefined });
      return;
    }
    if (r && !r.over) this.applyTurn({ t: 'turn', seat: r.turn, deadline: view.turnDeadline, legal: view.legal.map((x) => p.move(x)), windowEnds: view.windowEnds, roundEnds: view.roundEnds ?? null, moveMs: view.moveMs });
  }

  // ───────────────────────── menu ─────────────────────────

  /** the in-game menu: the online match does not pause */
  openMenu(): void {
    if (this.mode !== 'game' || this.closeMenu) return;
    this.chat?.toggle(false);
    const s = this.settings;
    this.closeMenu = this.deps.overlay.openModal(
      buildOnlinePause({
        audio: { sound: s.sound, voice: s.voice, music: s.music, vibration: s.vibration },
        onAudio: (key, on) => {
          this.deps.setSetting(key, on);
          setAudioPrefs({ [key]: on });
        },
        onResume: () => this.resumeFromMenu(),
        onLeave: () => {
          this.resumeFromMenu();
          if (this.mirror?.over) this.leave();
          else void this.confirmLeave();
        },
      }),
    );
  }

  private resumeFromMenu(): void {
    this.closeMenu?.();
    this.closeMenu = null;
  }

  // ───────────────────────── app lifecycle ─────────────────────────

  private onVisibility = (): void => {
    if (!this.client) return;
    if (document.hidden) {
      this.hiddenAt = Date.now();
      return;
    }
    // back from the background: animations froze meanwhile; a fresh snapshot catches up instantly
    const away = this.hiddenAt ? Date.now() - this.hiddenAt : 0;
    this.hiddenAt = 0;
    if (this.mode === 'game' && (away > 4000 || this.queue.length > 3)) this.client.resync();
    else this.client.nudge();
  };

  private onOnline = (): void => this.client?.nudge();

  dispose(): void {
    this.setRoundClock(null);
    this.teardownRoom();
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('online', this.onOnline);
  }
}
