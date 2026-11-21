import type { FaceSpec } from 'kuavatars/faces';
/**
 * Online play screens and cards (ported from Kudominoes): the "Jugar en línea" screen (create / join),
 * the room lobby (the same table-with-seats look as the new-game screen), the seat sheet (sit here or
 * pick a CPU character), the room rules sheet, the in-game menu (the match keeps going) and the
 * quick-phrase grid. Pure builders: the online controller (src/app/online.ts) owns state and connection.
 */
import type { GameMode, RuleSettings, Seat } from '../contracts';
import type { PublicRoom, QuickPhraseId, SeatOccupant } from '../net/protocol';
import { activeSeatsOf, teamsFor, MAX_NAME_LENGTH, QUICK_PHRASES, ROOM_CODE_LENGTH, ROOM_CODE_PREFIX } from '../net/protocol';
import { Perspective } from '../net/perspective';
import { displayCode, filterCodeChars } from '../net/identity';
import { character, ROSTER } from '../roster';
import { h } from './dom';
import { loc, t, type Key } from './i18n';
import { btn, ICONS, segmented } from './overlay';
import { screenHeader } from './howto';
import { staticFace } from './avatarAdapter';
import { clockPicker, levelBadge, seatMeta } from './newgame';
import { ruleSelect } from './settings';
import { modeChoices, modeSelect } from './modeSelect';
import { customMode } from '../app/customModes';
import type { ModeDef } from '../engine/modes';
import { sanitizeClock, type ClockSettings } from '../engine/clock';
import { audioToggle, type AudioKey } from './summary';

export { activeSeatsOf };

export const ONLINE_ICONS = {
  globe:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.6" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M3.6 12h16.8M12 3.4c2.4 2.4 3.6 5.3 3.6 8.6s-1.2 6.2-3.6 8.6c-2.4-2.4-3.6-5.3-3.6-8.6s1.2-6.2 3.6-8.6z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
  plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round"/></svg>',
  share:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="18" cy="5.5" r="2.6"/><circle cx="6" cy="12" r="2.6"/><circle cx="18" cy="18.5" r="2.6"/><path d="M8.3 10.8l7.4-4M8.3 13.2l7.4 4" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
  chat: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5.5h14a2 2 0 0 1 2 2v7.2a2 2 0 0 1-2 2h-7.4L7 20v-3.3H5a2 2 0 0 1-2-2V7.5a2 2 0 0 1 2-2z"/><circle cx="8.4" cy="11.1" r="1.25" fill="#13232e"/><circle cx="12" cy="11.1" r="1.25" fill="#13232e"/><circle cx="15.6" cy="11.1" r="1.25" fill="#13232e"/></svg>',
  qr: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M6.5 6.5h1v1h-1zM16.5 6.5h1v1h-1zM6.5 16.5h1v1h-1z" fill="currentColor" stroke="currentColor" stroke-width="1"/><path d="M14 14h2.5v2.5H14zM17.5 17.5H20V20h-2.5zM14 19h2M19 14v2" fill="currentColor" stroke="currentColor" stroke-width="1.2"/></svg>',
  exit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4.5H6.5A1.5 1.5 0 0 0 5 6v12a1.5 1.5 0 0 0 1.5 1.5H14" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round"/><path d="M11 12h9M16.5 8l3.8 4-3.8 4" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

const icon = (svg: string) => h('span.btn-icon', { html: svg });

// ───────────────────────── "Jugar en línea" ─────────────────────────

export interface OnlineHomeOpts {
  name: string;
  face: number | FaceSpec;
  avatars: boolean;
  /** prefilled code (from a link that failed, or the last one typed) */
  code?: string;
  /** Jugar con amigos (a host nearby) instead of online */
  local?: boolean;
  /** the app can host on this phone and find games nearby (Android): the screen shows those options */
  native?: {
    /** a saved room of this phone can be resumed */
    onResume: (() => void) | null;
    onJoinHost(host: NearbyGame): void;
    /** "Buscar también por Bluetooth" (shown until the permission is granted) */
    onBluetooth(): void;
    /** "Activar ubicación" (Bluetooth search needs Location on) */
    onLocation(): void;
  };
  onName(name: string): void;
  onCreate(): void;
  /** `origin` (http://192.168.1.37:8787) when joining another phone by its address */
  onJoin(code: string, origin?: string): void;
  onBack(): void;
}

/** a game another phone hosts nearby: on this Wi-Fi (origin) or over Bluetooth (endpoint) */
export interface NearbyGame {
  key: string;
  name: string;
  code: string;
  origin: string;
  via?: 'wifi' | 'bluetooth';
  /** Bluetooth: the host's Nearby endpoint */
  endpoint?: string;
}

/** "192.168.1.37:8787", "http://192.168.1.37:8787/?sala=7KQM" → origin (+ code when the link has one) */
export function parseAddress(raw: string): { origin: string; code: string } | null {
  let s = raw.trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (!u.hostname || !/^[\w.-]+$|^\[[0-9a-f:]+\]$/i.test(u.hostname)) return null;
  const port = u.port || '8787';
  const code = filterCodeChars(u.searchParams.get('sala') ?? '');
  return { origin: `http://${u.hostname}:${port}`, code: code.length === ROOM_CODE_LENGTH ? code : '' };
}

/**
 * The address to type when a device cannot scan ("192.168.1.37:8787"): host and port only, the room code
 * is on the card above. null when it would only work on this machine (localhost).
 */
export function typedAddress(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (/^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/.test(u.hostname)) return null;
  return u.host;
}

export interface OnlineHome {
  el: HTMLElement;
  setError(msg: string | null): void;
  setBusy(which: 'create' | 'join' | null): void;
  /** focus the name field (the first time, when there is no name yet) */
  askName(): void;
  /** native: the games found nearby (null = still looking) */
  setNearby(games: NearbyGame[] | null): void;
  /** native: show / hide "Buscar también por Bluetooth" */
  offerBluetooth(show: boolean): void;
  /** native: the search also runs over Bluetooth (the empty list says so) */
  setSearchingBluetooth(on: boolean): void;
  /** native: Location is off, Bluetooth cannot find phones (show the note and its button) */
  needLocation(show: boolean): void;
}

export function buildOnlineHome(o: OnlineHomeOpts): OnlineHome {
  let name = o.name;
  const faceEl = h('span.oh-face', o.avatars ? staticFace(o.face, 'happy') : h('span.ng-letter', (name || '?').slice(0, 1).toUpperCase()));
  const nameInput = h('input.oh-name-input', {
    type: 'text',
    maxlength: MAX_NAME_LENGTH,
    autocomplete: 'nickname',
    enterkeyhint: 'done',
    spellcheck: 'false',
    placeholder: t('online.namePlaceholder'),
    'aria-label': t('online.nameLabel'),
  }) as HTMLInputElement;
  nameInput.value = name;
  const commitName = () => {
    const v = nameInput.value.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
    nameInput.value = v;
    if (v !== name) {
      name = v;
      o.onName(v);
    }
    if (!o.avatars) faceEl.replaceChildren(h('span.ng-letter', (name || '?').slice(0, 1).toUpperCase()));
    who.classList.toggle('need', !name);
  };
  nameInput.addEventListener('change', commitName);
  nameInput.addEventListener('blur', commitName);
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') nameInput.blur();
  });
  const who = h('label.oh-who', faceEl, h('span.oh-who-text', h('span.oh-who-k', t('online.playingAs')), nameInput));
  who.classList.toggle('need', !name);

  const create = btn(t(o.native ? 'local.host' : 'online.create'), () => guard(() => o.onCreate()), 'primary lg oh-create', icon(ONLINE_ICONS.plus));
  const resume = o.native?.onResume ? btn(t('local.resume'), () => guard(() => o.native!.onResume!()), 'secondary oh-resume') : null;
  create.dataset.autofocus = '';

  const codeInput = h('input.oh-code-input', {
    type: 'text',
    inputmode: 'text',
    autocapitalize: 'characters',
    autocomplete: 'off',
    autocorrect: 'off',
    spellcheck: 'false',
    enterkeyhint: 'go',
    maxlength: ROOM_CODE_LENGTH + 5,
    placeholder: '••••',
    'aria-label': t('online.codeLabel'),
  }) as HTMLInputElement;
  codeInput.value = filterCodeChars(o.code ?? '');
  // native: the other phone's address ("192.168.1.37:8787", or its whole link)
  const addrInput = o.native
    ? (h('input.oh-addr-input', {
        type: 'text',
        inputmode: 'url',
        autocapitalize: 'off',
        autocomplete: 'off',
        autocorrect: 'off',
        spellcheck: 'false',
        enterkeyhint: 'next',
        placeholder: '192.168.1.37:8787',
        'aria-label': t('local.addressLabel'),
      }) as HTMLInputElement)
    : null;
  const join = btn(
    t('online.join'),
    () =>
      guard(() => {
        const a = addrInput ? parseAddress(addrInput.value) : null;
        if (addrInput && !a) return setError(t('local.err.address'));
        o.onJoin(codeInput.value, a?.origin);
      }),
    'secondary oh-join',
  );
  const syncJoin = () => (join.disabled = codeInput.value.length !== ROOM_CODE_LENGTH || busy !== null || (!!addrInput && !addrInput.value.trim()));
  addrInput?.addEventListener('input', () => {
    // a pasted link carries the code too
    const a = parseAddress(addrInput.value);
    if (a?.code) codeInput.value = a.code;
    setError(null);
    syncJoin();
  });
  codeInput.addEventListener('input', () => {
    // auto upper-case, alphabet only; a pasted "KUCA-7KQM" or link keeps just the code
    let v = codeInput.value.toUpperCase();
    const m = /KUCA-?([A-Z0-9]{4})/.exec(v) ?? /SALA=([A-Z0-9]{4})/.exec(v);
    if (m) v = m[1];
    const f = filterCodeChars(v);
    if (f !== codeInput.value) codeInput.value = f;
    setError(null);
    syncJoin();
  });
  codeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !join.disabled) join.click();
  });
  const codeBox = h('label.oh-code', h('span.oh-code-prefix', ROOM_CODE_PREFIX), codeInput);

  const err = h('p.oh-error', { role: 'alert', 'aria-live': 'assertive' });
  err.hidden = true;
  let busy: 'create' | 'join' | null = null;

  const guard = (fn: () => void) => {
    commitName();
    if (!name) {
      setError(t('online.nameNeeded'));
      nameInput.focus();
      return;
    }
    if (busy) return;
    fn();
  };
  const setError = (msg: string | null) => {
    err.hidden = !msg;
    err.textContent = msg ?? '';
  };
  const setBusy = (which: 'create' | 'join' | null) => {
    busy = which;
    create.classList.toggle('is-loading', which === 'create');
    join.classList.toggle('is-loading', which === 'join');
    create.disabled = which !== null;
    if (resume) resume.disabled = which !== null;
    nearbyList.querySelectorAll('button').forEach((b) => ((b as HTMLButtonElement).disabled = which !== null));
    syncJoin();
  };

  // ── native: games nearby (Wi-Fi and Bluetooth) ──
  const nearbyList = h('div.oh-nearby-list', { role: 'list' });
  let searchingBt = false;
  let lastGames: NearbyGame[] | null = null;
  const setNearby = (games: NearbyGame[] | null) => {
    lastGames = games;
    if (!games) return nearbyList.replaceChildren(h('p.oh-nearby-empty', t(searchingBt ? 'local.searchingBt' : 'local.searching')));
    if (!games.length) return nearbyList.replaceChildren(h('p.oh-nearby-empty', t(searchingBt ? 'local.noneNearbyBt' : 'local.noneNearby')));
    nearbyList.replaceChildren(
      ...games.map((g) => {
        const b = btn(
          g.name || displayCode(g.code),
          () => guard(() => o.native!.onJoinHost(g)),
          'secondary oh-nearby-game',
          h('span.oh-nearby-code', g.via === 'bluetooth' ? h('span.oh-nearby-via', t('local.viaBluetooth')) : null, displayCode(g.code)),
        );
        b.setAttribute('role', 'listitem');
        b.disabled = busy !== null;
        return b;
      }),
    );
  };
  setNearby(null);
  syncJoin();
  // Location off: Bluetooth search cannot find phones; a short note and a button to the settings
  const locBtn = o.native ? btn(t('local.locationOn'), () => o.native!.onLocation(), 'secondary oh-loc-btn') : null;
  const locNote = o.native ? h('div.oh-loc', h('p.oh-loc-text', t('local.locationNeeded')), locBtn) : null;
  if (locNote) locNote.hidden = true;
  const btOffer = o.native ? h('button.link-btn.oh-bt-offer', { type: 'button' }, t('local.searchBluetooth')) : null;
  btOffer?.addEventListener('click', () => o.native!.onBluetooth());
  if (btOffer) btOffer.hidden = true;

  const el = h(
    'section.screen.panel-screen.online-home',
    screenHeader(t(o.local ? 'friends.title' : 'online.title'), o.onBack),
    h(
      'div.scroll.oh-scroll',
      h(
        'div.oh-body',
        o.local ? h('p.oh-intro', t('local.intro')) : null,
        // (the intro says it all: no extra Wi-Fi note)
        who,
        create,
        resume,
        o.native ? h('div.oh-or', h('span', t('local.nearby'))) : null,
        o.native ? nearbyList : null,
        locNote,
        btOffer,
        h('div.oh-or', h('span', t(o.native ? 'local.joinAddress' : 'online.or'))),
        addrInput ? h('label.oh-code.oh-addr', addrInput) : null,
        h('div.oh-join-row', codeBox, join),
        err,
      ),
    ),
  );
  return {
    el,
    setError,
    setBusy,
    askName: () => requestAnimationFrame(() => nameInput.focus({ preventScroll: true })),
    setNearby,
    offerBluetooth: (show) => {
      if (btOffer) btOffer.hidden = !show;
    },
    needLocation: (show) => {
      if (locNote) locNote.hidden = !show;
    },
    setSearchingBluetooth: (on) => {
      searchingBt = on;
      if (!lastGames?.length) setNearby(lastGames);
    },
  };
}

// ───────────────────────── lobby ─────────────────────────

export interface LobbyOpts {
  code: string;
  /** host: play one of their player-made modes */
  onCustom?(def: ModeDef): void;
  /** guest: save the room's player-made mode to their own modes */
  onCopyMode?(def: ModeDef): void;
  /** anyone: the room mode's rules, read-only */
  onShowRules?(): void;
  /** local play: the link other devices open (as a QR, an SVG string) */
  join?: { url: string; qr: string } | null;
  /** show the QR big (a sheet: a tap, Esc or Android back closes it) */
  onQr?(): void;
  avatars: boolean;
  myId: string;
  presetName(mode: GameMode, rules: RuleSettings): string;
  onShare(): void;
  onSeat(seat: Seat): void;
  onMode(mode: GameMode, count: number, teamPlay?: boolean): void;
  onRules(): void;
  /** host: round limit / move times for the room */
  onClock(c: ClockSettings): void;
  onStart(): void;
  onLeave(): void;
}

export interface Lobby {
  el: HTMLElement;
  update(room: PublicRoom, me: { seat: Seat | null; isHost: boolean }): void;
  /** connection line under the code ('' = connected) */
  setConn(text: string): void;
  flashCopied(): void;
}

const POS = ['bottom', 'right', 'top', 'left'] as const;
const MODES: GameMode[] = ['classic', 'action', 'cyclone', 'sideBySide'];

export function occupantName(o: SeatOccupant): string {
  if (o.kind === 'human') return o.name || t('seat.player');
  if (o.kind === 'cpu') return character(o.characterId).name;
  return t('lobby.free');
}

const teamOfSeat = (room: PublicRoom, s: Seat): 0 | 1 | null => (room.teams ? (room.teams[0].includes(s) ? 0 : 1) : null);

export function buildLobby(o: LobbyOpts): Lobby {
  const felt = h('div.ng-table.lobby-table', { role: 'group', 'aria-label': t('newgame.seats') });
  const seatEls = POS.map((pos) => {
    const face = h('span.ng-seat-face');
    const name = h('span.ng-seat-name');
    const meta = h('span.ng-seat-meta');
    const b = h('button.ng-seat', { type: 'button', class: `pos-${pos}` }, face, name, meta);
    felt.append(b);
    return { b, face, name, meta, serverSeat: 0 as Seat };
  });
  seatEls.forEach((s) => s.b.addEventListener('click', () => o.onSeat(s.serverSeat)));
  // the seats are a lineup sized by CSS (the same as the offline new-game screen)
  const feltBox = h('div.ng-felt-box.lobby-felt-box', felt);

  const share = btn(t('lobby.share'), o.onShare, 'secondary lobby-share', icon(ONLINE_ICONS.share));
  share.setAttribute('aria-label', t('lobby.share'));
  // phones: the join card folds into this icon (the big QR has the address under it)
  const qrBtn = o.join ? btn(t('local.showQr'), () => o.onQr?.(), 'secondary lobby-qr-btn', icon(ONLINE_ICONS.qr)) : null;
  qrBtn?.setAttribute('aria-label', t('local.showQr'));
  // wider screens: the QR and the address in their own card; its QR opens big too
  const qr = o.join ? (h('button.lobby-join-qr', { type: 'button', 'aria-label': t('local.showQr'), html: o.join.qr }) as HTMLButtonElement) : null;
  qr?.addEventListener('click', () => o.onQr?.());
  const joinCard = o.join
    ? h(
        'div.lobby-join',
        qr,
        h(
          'div.lobby-join-text',
          h('span.lobby-code-k', t('local.join')),
          h('span.lobby-join-main', t('local.scanQr')),
          typedAddress(o.join.url) ? h('span.lobby-join-hint', t('local.orType'), ' ', h('b.lobby-join-addr', typedAddress(o.join.url)!)) : null,
        ),
      )
    : null;
  const copied = h('span.lobby-copied', { role: 'status', 'aria-live': 'polite' });
  const conn = h('span.lobby-conn', { role: 'status', 'aria-live': 'polite' });
  const codeCard = h(
    'div.lobby-code',
    h('div.lobby-code-text', h('span.lobby-code-k', t('lobby.code')), h('span.lobby-code-v', displayCode(o.code)), h('span.lobby-sub', copied, conn)),
    qrBtn,
    share,
  );

  const modeRow = h('div.ng-mode.lobby-mode');
  const status = h('p.lobby-status');
  const start = btn(t('lobby.start'), o.onStart, 'primary lobby-start', icon(ICONS.play));
  const wait = h('p.lobby-wait', h('span.lobby-wait-dot'), t('lobby.waitHost'));
  const clockHost = clockPicker(o.onClock);
  const clockGuest = clockPicker(null);
  // the footer sits outside the scroll area: always at the bottom of the screen
  const foot = h('div.lb-foot', h('div.lb-foot-inner', clockHost.el, clockGuest.el, status, start, wait));

  let lastModeKey = '';
  let lastClockKey = '';
  // one column on phones (code, controls, seats); two on wide screens (controls + seats | code + QR)
  const el = h(
    'section.screen.panel-screen.newgame.lobby.lb',
    screenHeader(t('lobby.title'), o.onLeave),
    h('div.lb-scroll', h('div.lb-grid', h('div.lb-top', codeCard, joinCard), h('div.lb-main', modeRow, feltBox))),
    foot,
  );

  const update = (room: PublicRoom, me: { seat: Seat | null; isHost: boolean }) => {
    const act = activeSeatsOf(room);
    // a fixed map of the table (first seat at the bottom): changing seats moves you, not the table
    const p = new Perspective(act[0], act);
    const myTeam = me.seat === null ? null : teamOfSeat(room, me.seat);
    for (const pos of [0, 1, 2, 3] as Seat[]) {
      const s = p.server(pos);
      const el = seatEls[pos];
      el.serverSeat = s;
      const used = act.includes(s);
      el.b.hidden = !used;
      if (!used) continue;
      const occ = room.seats[s] ?? { kind: 'empty' };
      const mine = occ.kind === 'human' && occ.playerId === o.myId;
      const team = teamOfSeat(room, s);
      const side = team === null ? (mine ? 'us' : 'them') : team === (myTeam ?? 0) ? 'us' : 'them';
      // team-0 is always MY team (as on the offline screen), team-1 the rivals
      const rel = team === null ? null : team === (myTeam ?? 0) ? 0 : 1;
      el.b.className = `ng-seat pos-${POS[pos as 0 | 1 | 2 | 3]} ${side} occ-${occ.kind}${mine ? ' me' : ''}${rel !== null ? ` team-${rel}` : ''}`;
      if (occ.kind === 'human') {
        el.face.replaceChildren(o.avatars ? staticFace(occ.face, 'idle') : h('span.ng-letter', occupantName(occ).slice(0, 1).toUpperCase()));
        el.name.textContent = occupantName(occ);
        const host = occ.playerId === room.hostId;
        el.meta.replaceChildren(
          h('span.conn-dot', { class: occ.connected ? 'on' : 'off', title: occ.connected ? '' : t('lobby.offline') }),
          h('span', mine ? t('lobby.you') : host ? t('lobby.host') : occ.connected ? '' : t('lobby.offline')),
          ...(mine && host ? [h('span.lobby-host-tag', `· ${t('lobby.host')}`)] : []),
        );
        el.b.setAttribute('aria-label', `${occupantName(occ)}${host ? `, ${t('lobby.host')}` : ''}`);
        el.b.disabled = true;
      } else if (occ.kind === 'cpu') {
        const c = character(occ.characterId);
        el.face.replaceChildren(o.avatars ? staticFace(c.face, 'idle') : h('span.ng-letter', c.name.slice(0, 1)));
        el.name.textContent = c.name;
        const role = team === null ? null : team === (myTeam ?? 0) ? t(c.fem ? 'role.partnerF' : 'role.partner') : t('role.rival');
        el.meta.replaceChildren(seatMeta(c, role));
        el.b.setAttribute('aria-label', `${c.name}, ${t(`level.${c.level}` as Key)}`);
        el.b.disabled = false;
      } else {
        el.face.replaceChildren(h('span.lobby-empty', { html: ONLINE_ICONS.plus }));
        el.name.textContent = t('lobby.free');
        el.meta.replaceChildren(h('span', me.isHost ? t('lobby.randomCpu') : t('lobby.tapToSit')));
        el.b.setAttribute('aria-label', `${t('lobby.free')}: ${t('lobby.tapToSit')}`);
        el.b.disabled = false;
      }
    }
    const tp = !!room.teamPlay && room.playerCount === 4 && (room.custom ? room.custom.teams === 'optional' : room.mode !== 'sideBySide');
    const modeKey = `${me.isHost}|${room.mode}|${room.playerCount}|${tp}|${o.presetName(room.mode, room.rules)}|${room.custom?.id ?? ''}|${room.custom && customMode(room.custom.id) ? 1 : 0}`;
    if (modeKey !== lastModeKey) {
      lastModeKey = modeKey;
      // the same controls as the offline new-game screen (guests see them disabled)
      const host = me.isHost;
      const side = room.custom ? room.custom.teams === 'always' : room.mode === 'sideBySide';
      // the shared game-mode dropdown; a room's player-made mode is listed even if this player lacks it
      const choices = modeChoices();
      if (room.custom && !choices.some((c) => c.id === room.custom!.id)) choices.push({ id: room.custom.id, label: room.custom.name, icon: room.custom.icon, custom: true });
      const rules = modeSelect({
        current: room.custom?.id ?? room.mode,
        currentLabel: room.custom ? room.custom.name : o.presetName(room.mode, room.rules),
        choices,
        onPick: (id) => {
          const own = customMode(id);
          if (own) o.onCustom?.(own);
          else if (id === room.custom?.id) return;
          else o.onMode(id as GameMode, id === 'sideBySide' || side ? 4 : room.playerCount, tp);
        },
      });
      const gear = h('button.icon-btn.rsel-act', { type: 'button', 'aria-label': t('newgame.changeRules'), title: t('newgame.changeRules'), html: ICONS.gear });
      gear.addEventListener('click', o.onRules);
      const word = t('newgame.players').toLocaleLowerCase();
      const players = h(
        'div.ng-players',
        ruleSelect([2, 3, 4].map((n) => ({ label: `${n} ${word}`, on: n === (side ? 4 : room.playerCount), pick: () => o.onMode(room.mode, n, tp) })), t('newgame.players'), 'soft'),
      );
      const teamsSeg = segmented<string>(
        [
          { value: 'ffa', label: t('newgame.ffa') },
          { value: 'teams', label: t('newgame.teams2v2') },
        ],
        side || tp ? 'teams' : 'ffa',
        (v) => o.onMode(room.mode, 4, v === 'teams'),
        t('newgame.teams'),
      );
      const teamsLocked = !host || side || room.playerCount !== 4;
      teamsSeg.classList.toggle('is-disabled', teamsLocked);
      teamsSeg.querySelectorAll<HTMLButtonElement>('.seg-opt').forEach((b) => (b.disabled = teamsLocked));
      players.classList.toggle('is-disabled', !host || side);
      players.querySelector<HTMLButtonElement>('.rsel-btn')?.toggleAttribute('disabled', !host || side);
      // everyone can read the mode's rules (read-only sheet)
      const view = h('button.icon-btn.rsel-act', { type: 'button', 'aria-label': t('modes.rules'), title: t('modes.rules'), html: ICONS.book });
      view.addEventListener('click', () => o.onShowRules?.());
      const rulesLine = h('div.rsel-line.ng-rsel', h('div.rsel-slot', rules), view, host ? gear : null);
      rulesLine.classList.toggle('is-disabled', !host);
      rules.querySelector<HTMLButtonElement>('.rsel-btn')?.toggleAttribute('disabled', !host);
      // a player-made mode this player doesn't have: save a copy
      const copyBtn = room.custom && !customMode(room.custom.id) ? btn(t('modes.copy'), () => o.onCopyMode?.(room.custom!), 'secondary lb-copy', icon(ONLINE_ICONS.plus)) : null;
      modeRow.replaceChildren(rulesLine, ...(copyBtn ? [copyBtn] : []), h('div.ng-lines', h('div.ng-line', players), h('div.ng-line.ng-seating', teamsSeg)));
    }
    felt.classList.toggle('partners', !!teamsFor(room));
    const clock = sanitizeClock(room.clock);
    clockHost.el.hidden = !me.isHost;
    clockGuest.el.hidden = me.isHost;
    const clockKey = `${me.isHost}|${JSON.stringify(clock)}`;
    if (clockKey !== lastClockKey) (me.isHost ? clockHost : clockGuest).render(clock);
    lastClockKey = clockKey;
    const humans = act.filter((s) => room.seats[s]?.kind === 'human').length;
    status.hidden = true; // no explanation line (the seats show who's there)
    start.hidden = !me.isHost;
    start.disabled = humans === 0;
    wait.hidden = me.isHost;
  };

  let copiedTimer = 0;
  return {
    el,
    update,
    setConn: (text) => {
      conn.textContent = text;
      el.classList.toggle('net-down', !!text);
    },
    flashCopied: () => {
      copied.textContent = t('lobby.copied');
      clearTimeout(copiedTimer);
      copiedTimer = window.setTimeout(() => (copied.textContent = ''), 2200);
    },
  };
}

// ───────────────────────── seat sheet (host) ─────────────────────────

export function buildSeatSheet(o: {
  current: string | null;
  /** characters already seated elsewhere */
  taken: readonly string[];
  canSit: boolean;
  avatars: boolean;
  onSit(): void;
  onPick(id: string): void;
  onClear(): void;
  onClose(): void;
}): HTMLElement {
  const grid = h('div.ng-grid', { role: 'listbox', 'aria-label': t('lobby.pickCpu') });
  for (const c of ROSTER) {
    const here = c.id === o.current;
    const b = h(
      'button.ng-cell',
      { type: 'button', role: 'option', 'aria-selected': String(here), 'aria-label': `${c.name} · ${loc(c.tag)}`, class: `${c.level === 'master' ? 'is-master' : ''}${o.taken.includes(c.id) ? ' elsewhere' : ''}` },
      h('span.ng-cell-face', o.avatars ? staticFace(c.face, 'idle', c.name) : h('span.ng-letter', c.name.slice(0, 1))),
      h('span.ng-cell-name', h('span.nm-full', c.name), h('span.nm-short', c.short ?? c.name)),
      levelBadge(c),
    );
    b.disabled = o.taken.includes(c.id);
    b.addEventListener('click', () => o.onPick(c.id));
    grid.append(b);
  }
  const sit = o.canSit ? btn(t('lobby.sitHere'), o.onSit, 'primary') : null;
  if (sit) sit.dataset.autofocus = '';
  const clear = btn(t('lobby.leaveFree'), o.onClear, 'ghost');
  return h(
    'div.card.seat-sheet',
    h(
      'div.seat-sheet-head',
      h('h2.card-title', t('lobby.seatTitle')),
      h('button.icon-btn.seat-sheet-x', {
        type: 'button',
        'aria-label': t('common.close'),
        html: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>',
        onclick: () => o.onClose(),
      }),
    ),
    sit,
    h('h3.ng-pick-title', t('lobby.pickCpu')),
    grid,
    h('div.row.seat-sheet-foot', clear),
  );
}

// ───────────────────────── rules sheet (host) ─────────────────────────

export function buildRulesSheet(o: { options: { label: string; selected: boolean; onPick(): void }[]; onClose(): void }): HTMLElement {
  return h(
    'div.card.dialog.rules-sheet',
    h('h2.card-title', t('lobby.rulesTitle')),
    h(
      'div.stack.rules-opts',
      ...o.options.map((op) => {
        const b = h('button.btn.rules-opt', { type: 'button', class: op.selected ? 'primary' : 'secondary', 'aria-pressed': String(op.selected) }, h('span.btn-label', op.label));
        b.addEventListener('click', op.onPick);
        return b;
      }),
    ),
    h('div.row', btn(t('common.close'), o.onClose, 'ghost')),
  );
}

// ───────────────────────── in-game menu ─────────────────────────

export function buildOnlinePause(o: { audio: Record<AudioKey, boolean>; onAudio(key: AudioKey, on: boolean): void; onResume(): void; onLeave(): void; onRules?(): void }): HTMLElement {
  const resume = btn(t('online.backToGame'), o.onResume, 'primary lg', icon(ICONS.play));
  resume.dataset.autofocus = '';
  const canVibrate = typeof navigator.vibrate === 'function';
  return h(
    'div.card.pause.online-pause',
    h('h2.card-title', t('online.menuTitle')),
    h('p.online-pause-note', h('span.live-dot'), t('online.menuNote')),
    h(
      'div.stack',
      resume,
      h('div.pause-row', audioToggle('sound', o.audio.sound, o.onAudio), audioToggle('voice', o.audio.voice, o.onAudio), audioToggle('music', o.audio.music, o.onAudio), canVibrate ? audioToggle('vibration', o.audio.vibration, o.onAudio) : null),
      o.onRules ? btn(t('modes.rules'), o.onRules, 'secondary', icon(ICONS.book)) : null,
      btn(t('online.leave'), o.onLeave, 'ghost', icon(ONLINE_ICONS.exit)),
    ),
  );
}

// ───────────────────────── quick phrases ─────────────────────────

export const phraseText = (id: string): string => ((QUICK_PHRASES as readonly string[]).includes(id) ? t(`phrase.${id as QuickPhraseId}` as Key) : '');

export function buildPhraseGrid(onPick: (id: QuickPhraseId) => void): HTMLElement {
  return h(
    'div.qp-grid',
    { role: 'menu', 'aria-label': t('online.phrases') },
    ...QUICK_PHRASES.map((id) => {
      const b = h('button.qp-opt', { type: 'button', role: 'menuitem' }, phraseText(id));
      b.addEventListener('click', () => onPick(id));
      return b;
    }),
  );
}

/** the join QR, big: scan it, or type the address under it; a tap anywhere closes it */
export function buildQrCard(o: { qr: string; url: string; onClose(): void }): HTMLElement {
  // the big view always names the address (even localhost while developing)
  let addr = typedAddress(o.url);
  try {
    addr ??= new URL(o.url).host;
  } catch {
    /* keep null */
  }
  const card = h(
    'button.qr-card',
    { type: 'button', 'aria-label': t('common.close') },
    h('span.qr-card-code', { html: o.qr }),
    h('span.qr-card-title', t('local.scanQr')),
    addr ? h('span.qr-card-addr', t('local.orType'), ' ', h('b', addr)) : null,
  );
  card.addEventListener('click', o.onClose);
  return card;
}
