/**
 * Nueva partida: mode cards (the four presets with their blurbs), player count (2–4; with 4, free-for-all
 * or 2 vs 2 Enfrente; Codo a codo is always 2 vs 2 side by side), a small table with the seats in play (tap a seat, then
 * a character from the roster grid) and a quick rules summary with "Cambiar reglas".
 * Character picking is ported from Kudominoes (seat ↔ grid, a character seated elsewhere swaps seats).
 */
import { FINAL_SEC, MOVE_SEC, ROUND_MIN_OPTIONS, sanitizeClock, type ClockSettings } from '../engine/clock';
import type { GameMode, Lineup, RulePreset, RuleSettings, Seat } from '../contracts';
import { character, LEVEL_STARS, ROSTER, type Character } from '../roster';
import { liveFace, staticFace } from './avatarAdapter';
import { cardSvg } from './cardArt';
import { h, prefersReducedMotion } from './dom';
import { screenHeader } from './howto';
import { loc, t, type Key } from './i18n';
import { btn, ICONS, segmented } from './overlay';
import { ruleSelect, type RuleSelectItem } from './settings';
import { modeSelect } from './modeSelect';
import { customMode } from '../app/customModes';
import { sideSeating } from '../modes/core';
import { isBuiltInMode, modeDef, type ModeDef } from '../engine/modes';

type Slot = 1 | 2 | 3;
/** CPU seats in play by player count (same seats as the engine: 2 → across, 3 → the sides) */
export const CPU_SEATS: Record<2 | 3 | 4, Slot[]> = { 2: [2], 3: [1, 3], 4: [1, 2, 3] };

const SPARK = '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M8 1.5 9.6 6.4 14.5 8 9.6 9.6 8 14.5 6.4 9.6 1.5 8 6.4 6.4Z" fill="currentColor"/></svg>';
const DICE =
  '<svg viewBox="0 0 48 48" aria-hidden="true" focusable="false"><rect x="7" y="7" width="34" height="34" rx="9" fill="#FFF6E6" stroke="#13232e" stroke-width="2.5"/><circle cx="16.5" cy="16.5" r="3.4" fill="#13232e"/><circle cx="24" cy="24" r="3.4" fill="#13232e"/><circle cx="31.5" cy="31.5" r="3.4" fill="#13232e"/><circle cx="31.5" cy="16.5" r="3.4" fill="#13232e"/><circle cx="16.5" cy="31.5" r="3.4" fill="#13232e"/></svg>';

const levelLabel = (c: Character) => t(`level.${c.level}` as Key);

/** stars for easy/normal/hard (1–3 of 3); the master level gets its own badge */
export function levelBadge(c: Character): HTMLElement {
  const aria = t('newgame.level', { level: levelLabel(c) });
  if (c.level === 'master') return h('span.lvl.master', { 'aria-label': aria, title: aria }, h('span.lvl-spark', { html: SPARK }), levelLabel(c));
  const n = LEVEL_STARS[c.level];
  return h('span.lvl', { 'aria-label': aria, title: aria }, ...[1, 2, 3].map((i) => h('span.star', { class: i <= n ? 'on' : '', 'aria-hidden': 'true' }, '★')));
}

/** a CPU seat's second line, the same on every screen: "Rival · Normal" (the master gets its badge) */
export function seatMeta(c: Character, role: string | null): HTMLElement {
  return c.level === 'master' ? levelBadge(c) : h('span', role ? `${role} · ${levelLabel(c)}` : levelLabel(c));
}

/** a mini card fan per mode on its card */
const MODE_ART: Record<GameMode, string> = {
  classic: cardSvg({ kind: 'number', color: 'mar', value: 7 }, { width: 26 }) + cardSvg({ kind: 'number', color: 'sol', value: 4 }, { width: 26 }),
  action: cardSvg({ kind: 'swap', color: null }, { width: 26 }) + cardSvg({ kind: 'sweep', color: 'palma' }, { width: 26 }),
  cyclone: cardSvg({ kind: 'draw2', color: 'coral', draw: 2 }, { width: 26 }) + cardSvg({ kind: 'wild4', color: null, draw: 4 }, { width: 26 }),
  sideBySide: cardSvg({ kind: 'number', color: 'coral', value: 2 }, { width: 26 }) + cardSvg({ kind: 'number', color: 'coral', value: 2 }, { width: 26 }),
  dayNight: cardSvg({ kind: 'flip', color: 'sol' }, { width: 26 }) + cardSvg({ kind: 'flip', color: 'morado' }, { width: 26 }),
};

export interface NewGameStart {
  mode: GameMode;
  /** a player-made mode's id (then `mode` is its base) */
  custom?: string;
  players: 2 | 3 | 4;
  /** 2 vs 2 partners across (4 players, not Codo a codo) */
  teams?: boolean;
  /** the characters in seats 1..3 (seats not in play hold unused characters) */
  lineup: Required<Lineup>;
  clock: ClockSettings;
  /** Codo a codo: "Cambiar de lado" swapped the human and their partner's seats */
  swappedSeats?: boolean;
}

export interface NewGameOpts {
  presets: RulePreset[];
  mode: GameMode;
  players: 2 | 3 | 4;
  /** 2 vs 2 Enfrente picked (used with 4 players outside Codo a codo) */
  teams?: boolean;
  lineup: Lineup;
  /** Codo a codo: whether the human and their partner swapped seats (default false) */
  swappedSeats?: boolean;
  onSwappedSeats?(swapped: boolean): void;
  avatars: boolean;
  humanFace: number | import('kuavatars').FaceSpec;
  humanName: string;
  rulesFor(mode: GameMode): RuleSettings;
  /** preset name or "Personalizado" */
  presetName(mode: GameMode): string;
  /** one-line summary of a mode's rules */
  rulesSummary(mode: GameMode): string;
  onMode(mode: GameMode): void;
  onPlayers(n: 2 | 3 | 4): void;
  onLineup(l: Required<Lineup>): void;
  onTeams(on: boolean): void;
  onRules(mode: GameMode): void;
  /** round limit / move times (not rules), remembered in the app settings */
  clock: ClockSettings;
  onClock(c: ClockSettings): void;
  /** rule sets to pick from (built-in preset + saved profiles of the mode); picking one applies it */
  ruleChoices?(mode: GameMode): RuleSelectItem[];
  onStart(o: NewGameStart): void;
  /** the player-made mode picked (null = a built-in) */
  customMode?: string;
  onCustom?(id: string | null): void;
  onBack(): void;
}

/**
 * The "Tiempo" row: round limit · per move · final minute as soft dropdowns (the last only with a round
 * limit). onChange null = read only (online, not the host): the values as text.
 */
const CLOCK_SVG = '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><circle cx="12" cy="13" r="8"/><path d="M12 9v4.2l2.6 1.6M9.5 2.5h5"/></svg>';

export function clockPicker(onChange: ((c: ClockSettings) => void) | null): { el: HTMLElement; render(c: ClockSettings): void } {
  const el = h('div.ng-clock');
  const sec = (n: number) => t('clock.sec', { n });
  const min = (n: number) => (n ? t('clock.min', { n }) : t('clock.off'));
  const render = (raw: ClockSettings): void => {
    const clock = sanitizeClock(raw);
    const set = (k: keyof ClockSettings, v: number) => {
      const next = sanitizeClock({ ...clock, [k]: v });
      onChange?.(next);
      render(next);
    };
    const sel = (k: keyof ClockSettings, opts: readonly number[], label: string, fmt: (n: number) => string) =>
      h('div.field', h('span.field-label', { title: label }, label), onChange ? ruleSelect(opts.map((n) => ({ label: fmt(n), on: clock[k] === n, pick: () => set(k, n) })), label, 'soft') : h('b', fmt(clock[k])));
    el.replaceChildren(
      h('div.ng-clock-head', h('span.ng-clock-icon', { 'aria-hidden': 'true', html: CLOCK_SVG }), h('span.rsel-label', t('clock.label'))),
      h(
        'div.field-row',
        sel('roundMin', ROUND_MIN_OPTIONS, t('clock.round'), min),
        sel('moveSec', MOVE_SEC.options, t('clock.move'), sec),
        // no round limit: the final-minute slot stays, empty, so the other two keep their width
        clock.roundMin ? sel('finalSec', FINAL_SEC.options, t('clock.final'), sec) : h('span.field'),
      ),
    );
  };
  return { el, render };
}

export function buildNewGame(o: NewGameOpts): HTMLElement {
  // a stored 'random' or a duplicate is resolved now: the seats always show real characters
  const pool = ROSTER.map((c) => c.id);
  const seen = new Set<string>();
  const fix = (id: string | undefined) => {
    const v = id && pool.includes(id) && !seen.has(id) ? id : pool.find((x) => !seen.has(x) && !Object.values(o.lineup).includes(x)) ?? pool.find((x) => !seen.has(x))!;
    seen.add(v);
    return v;
  };
  const l2 = fix(o.lineup[2]);
  const l1 = fix(o.lineup[1]);
  const l3 = fix(o.lineup[3]);
  let lu: Required<Lineup> = { 1: l1, 2: l2, 3: l3 };
  let mode: GameMode = o.mode;
  let customId: string | null = o.customMode && customMode(o.customMode) ? o.customMode : null;
  let players: 2 | 3 | 4 = o.players;
  let teams2v2 = !!o.teams;
  let swappedSeats = !!o.swappedSeats;
  /** the mode being set up (a player-made one, or the built-in) */
  const def = (): ModeDef => (customId ? (customMode(customId) ?? modeDef(mode)) : modeDef(mode));
  /** 2 vs 2 forced (any seating) */
  const forcedTeams = () => def().teams === 'always';
  const count = () => (forcedTeams() ? 4 : players);
  /** team play: forced by the mode, or chosen (4 players) when the mode allows it */
  const isTeams = () => forcedTeams() || (def().teams === 'optional' && teams2v2 && players === 4);
  /** the mode asks for side seating AND 2 vs 2 is really in play — the same test the engine uses */
  const side = () => sideSeating(def(), count(), isTeams());
  const slots = () => CPU_SEATS[count()];
  let active: Slot = slots()[0];
  let shown = lu[active];
  /** partners: team of a seat. Side seating is always A A B B; swapping seats only moves the avatars. */
  const teamOf = (s: Seat): 0 | 1 => (side() ? (s === 0 || s === 1 ? 0 : 1) : ((s % 2) as 0 | 1));
  /** the seat the human's partner occupies (the next seat, right) */
  const PARTNER_SLOT: Slot = 1;
  /** the occupant shown at a slot after "Cambiar de lado" */
  const shownAt = (s: Slot): { char: Character | null; mine: boolean } => {
    if (side() && swappedSeats && s === PARTNER_SLOT) return { char: null, mine: true };
    return { char: character(lu[s]), mine: false };
  };

  // ── mode cards ──
  const modeCards = o.presets.map((p) => {
    const b = h(
      'button.mode-card',
      { type: 'button', role: 'radio', 'aria-checked': String(p.id === mode), class: `mode-${p.id}` },
      h('span.mode-art', { html: MODE_ART[p.id] }),
      h('span.mode-text', h('span.mode-name', loc(p.label)), h('span.mode-blurb', loc(p.blurb))),
    );
    b.addEventListener('click', () => setMode(p.id));
    return b;
  });
  function setMode(id: GameMode, force = false): void {
    if (mode === id && !force) return;
    mode = id;
    modeCards.forEach((c, i) => c.setAttribute('aria-checked', String(o.presets[i].id === mode)));
    o.onMode(mode);
    if (!slots().includes(active)) active = slots()[0];
    shown = lu[active];
    applyMode();
  }
  const modeGrid = h('div.mode-grid', { role: 'radiogroup', 'aria-label': t('newgame.mode') }, ...modeCards);

  // ── players / seating ──
  // players: a small dropdown ("4 jugadores")
  const playersSeg = h('div.ng-players');
  const renderPlayers = (): void => {
    const word = t('newgame.players').toLocaleLowerCase();
    playersSeg.replaceChildren(
      ruleSelect(
        [2, 3, 4].map((n) => ({
          label: `${n} ${word}`,
          on: n === players,
          pick: () => {
            players = n as 2 | 3 | 4;
            o.onPlayers(players);
            if (!slots().includes(active)) active = slots()[0];
            shown = lu[active];
            applyMode();
            renderPlayers();
          },
        })),
        t('newgame.players'),
        'soft',
      ),
    );
  };
  renderPlayers();
  const fixedNote = h('span.ng-fixed', t('newgame.fixed4'));
  const playersRow = h('div.ng-line', playersSeg, fixedNote);

  const teamsSeg = segmented<string>(
    [
      { value: 'ffa', label: t('newgame.ffa') },
      { value: 'teams', label: t('newgame.teams2v2') },
    ],
    teams2v2 ? 'teams' : 'ffa',
    (v) => {
      teams2v2 = v === 'teams';
      o.onTeams(teams2v2);
      renderSeats();
      updateRules();
    },
    t('newgame.teams'),
  );
  // the switch explains itself (Individual / 2 vs 2): no label
  const seatingRow = h('div.ng-line.ng-seating', teamsSeg);

  // ── table with seats ──
  const felt = h('div.ng-table', { role: 'group', 'aria-label': t('newgame.seats') });
  const POS: Record<Slot, string> = { 1: 'right', 2: 'top', 3: 'left' };
  const seatEls = new Map<Slot, { btn: HTMLButtonElement; face: HTMLElement; name: HTMLElement; meta: HTMLElement }>();
  for (const s of [1, 2, 3] as Slot[]) {
    const face = h('span.ng-seat-face');
    const name = h('span.ng-seat-name');
    const meta = h('span.ng-seat-meta');
    const b = h('button.ng-seat', { type: 'button', class: `pos-${POS[s]}` }, face, name, meta);
    b.addEventListener('click', () => {
      if (b.disabled) return; // after the swap this seat shows "me", not a pickable CPU
      active = s;
      shown = lu[s];
      refresh();
      if (sheetMq.matches) openSheet();
      grid.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
    seatEls.set(s, { btn: b, face, name, meta });
    felt.append(b);
  }
  const meTeam = h('span.ng-team');
  const meFace = h('span.ng-seat-face');
  const meName = h('span.ng-seat-name');
  const meMeta = h('span.ng-seat-meta');
  felt.append(h('div.ng-seat.pos-bottom.me', meFace, meName, meMeta, meTeam));
  // Codo a codo only: swap places with the partner (their avatar comes here, mine goes to their seat)
  const swapSide = h('button.link-btn.ng-swap-side', { type: 'button' }, t('newgame.swapSide'));
  swapSide.addEventListener('click', () => {
    swappedSeats = !swappedSeats;
    // the partner seat now shows my avatar: don't leave the roster picker pointing at "me"
    if (swappedSeats && active === PARTNER_SLOT) {
      active = ([2, 3] as Slot[]).find((s) => slots().includes(s)) ?? PARTNER_SLOT;
      shown = lu[active];
    }
    o.onSwappedSeats?.(swappedSeats);
    renderSeats();
    refresh();
    bump(PARTNER_SLOT);
  });
  const faceNode = (c: Character, live: boolean): HTMLElement => (o.avatars ? (live ? liveFace(c.face, 'idle', c.name).el : staticFace(c.face, 'idle', c.name)) : h('span.ng-letter', c.name.slice(0, 1)));
  const renderSeat = (s: Slot) => {
    const el = seatEls.get(s)!;
    const inUse = slots().includes(s);
    el.btn.hidden = !inUse;
    if (!inUse) return;
    const at = shownAt(s);
    const c = at.char;
    const partners = isTeams();
    const team = partners ? teamOf(s) : null;
    el.btn.classList.toggle('team-0', team === 0);
    el.btn.classList.toggle('team-1', team === 1);
    el.btn.disabled = at.mine;
    if (at.mine) {
      el.face.replaceChildren(o.avatars ? staticFace(o.humanFace, 'idle', o.humanName) : h('span.ng-letter', o.humanName.slice(0, 1)));
      el.name.textContent = o.humanName;
      el.meta.replaceChildren(h('span', t('seat.you')));
      el.btn.setAttribute('aria-label', t('seat.you'));
    } else if (c) {
      el.face.replaceChildren(faceNode(c, true));
      el.name.textContent = c.name;
      const role = partners ? (team === teamOf(0) ? t(c.fem ? 'role.partnerF' : 'role.partner') : t('role.rival')) : null;
      el.meta.replaceChildren(seatMeta(c, role));
      el.btn.setAttribute('aria-label', `${t('newgame.seatAria')}: ${c.name}, ${levelLabel(c)}`);
    }
  };
  const renderSeats = () => {
    for (const s of [1, 2, 3] as Slot[]) renderSeat(s);
    felt.dataset.n = String(count());
    felt.classList.toggle('partners', isTeams());
    const team = isTeams() ? teamOf(0) : null;
    swapSide.hidden = !side();
    // the bottom seat shows the partner's avatar after the swap; the rivals never move
    const partnerHere = side() && swappedSeats ? character(lu[PARTNER_SLOT]) : null;
    if (partnerHere) {
      meFace.replaceChildren(faceNode(partnerHere, false));
      meName.textContent = partnerHere.name;
      meMeta.replaceChildren(seatMeta(partnerHere, t(partnerHere.fem ? 'role.partnerF' : 'role.partner')));
    } else {
      meFace.replaceChildren(o.avatars ? staticFace(o.humanFace, 'idle', o.humanName) : h('span.ng-letter', o.humanName.slice(0, 1)));
      meName.textContent = o.humanName;
      meMeta.replaceChildren();
    }
    meTeam.textContent = team === null ? '' : team === 0 ? 'A' : 'B';
    felt.querySelector('.me')!.classList.toggle('team-0', team === 0);
  };

  // ── roster grid ──
  // screens up to 769 px: the character grid is a bottom sheet (like the dominoes game), the table full width
  const sheetMq = matchMedia('(max-width: 769px)');
  const handle = h('div.ng-handle', { 'aria-hidden': 'true' });
  const scrim = h('div.ng-scrim');
  let sheetOpen = false;
  const openSheet = (): void => {
    sheetOpen = true;
    pickPanel.classList.add('open');
    scrim.classList.add('open');
  };
  const closeSheet = (): void => {
    if (!sheetOpen) return;
    sheetOpen = false;
    pickPanel.classList.remove('open');
    scrim.classList.remove('open');
    pickPanel.style.transform = '';
  };
  scrim.addEventListener('click', closeSheet);
  const pickTitle = h('h3.ng-pick-title');
  const grid = h('div.ng-grid', { role: 'listbox', 'aria-label': t('newgame.characters') });
  const desc = h('p.ng-desc', { 'aria-live': 'polite' });
  const pickPanel = h('section.ng-pick', handle, pickTitle, grid, desc);
  const describe = (id: string) => {
    shown = id;
    const c = character(id);
    desc.replaceChildren(h('strong', c.name), h('span.ng-desc-style', ` · ${loc(c.tag)}. `), loc(c.desc));
  };
  const cells = ROSTER.map((c) => {
    const tag = h('span.ng-cell-seat');
    const b = h(
      'button.ng-cell',
      { type: 'button', role: 'option', 'aria-label': `${c.name} · ${levelLabel(c)} · ${loc(c.tag)}`, class: c.level === 'master' ? 'is-master' : '' },
      h('span.ng-cell-face', o.avatars ? staticFace(c.face, 'idle', c.name) : h('span.ng-letter', c.name.slice(0, 1))),
      h('span.ng-cell-name', h('span.nm-full', c.name), h('span.nm-short', c.short ?? c.name)),
      levelBadge(c),
      tag,
    );
    b.addEventListener('click', () => {
      pick(c.id);
      if (sheetMq.matches) closeSheet();
    });
    b.addEventListener('pointerenter', (e) => e.pointerType === 'mouse' && describe(c.id));
    b.addEventListener('pointerleave', (e) => e.pointerType === 'mouse' && describe(lu[active]));
    b.addEventListener('focus', () => describe(c.id));
    grid.append(b);
    return { id: c.id, b, tag };
  });

  const refresh = () => {
    for (const [s, el] of seatEls) {
      el.btn.classList.toggle('active', s === active);
      el.btn.setAttribute('aria-pressed', String(s === active));
    }
    pickTitle.textContent = t('newgame.pickFor', { seat: t(`newgame.pos.${POS[active]}` as Key) });
    for (const cell of cells) {
      const seat = slots().find((s) => lu[s] === cell.id) ?? null;
      const here = seat === active;
      cell.b.setAttribute('aria-selected', String(here));
      cell.b.classList.toggle('elsewhere', seat !== null && !here);
      cell.tag.textContent = seat !== null && !here ? t(`newgame.tag.${POS[seat]}` as Key) : '';
    }
    describe(shown);
  };

  const bump = (s: Slot) => {
    if (prefersReducedMotion()) return;
    seatEls.get(s)!.face.animate([{ transform: 'scale(.82)' }, { transform: 'scale(1.06)', offset: 0.6 }, { transform: 'scale(1)' }], { duration: 320, easing: 'ease-out' });
  };

  const pick = (id: string) => {
    const prev = lu[active];
    if (prev !== id) {
      const other = ([1, 2, 3] as Slot[]).find((s) => lu[s] === id) ?? null;
      const next = { ...lu };
      if (other !== null) next[other] = prev; // never a dead end: swap seats
      next[active] = id;
      lu = next;
      renderSeat(active);
      if (other !== null) renderSeat(other);
      o.onLineup({ ...lu });
      bump(active);
      if (other !== null && slots().includes(other)) bump(other);
    }
    shown = id;
    refresh();
  };

  // ── rules line + buttons ──
  const rulesName = h('span.preset-v');
  const rulesSum = h('span.ng-rules-sum');
  const updateRules = () => {
    rulesName.textContent = o.presetName(mode);
    rulesSum.textContent = o.rulesSummary(mode);
    renderRuleSelect();
  };
  const rulesLink = h('button.link-btn', { type: 'button' }, t('newgame.changeRules'));
  rulesLink.addEventListener('click', () => o.onRules(mode));
  const plainLine = h('div.ng-rules', h('div.ng-rules-top', h('span.preset-k', `${t('newgame.rules')}:`), rulesName, rulesLink), rulesSum);
  // [REGLAS] [dropdown] [edit]
  const rulesSlot = h('div.rsel-slot');
  const editLabel = t('newgame.editRules');
  const editBtn = h('button.icon-btn.rsel-act', { type: 'button', 'aria-label': editLabel, title: editLabel, html: ICONS.gear });
  editBtn.addEventListener('click', () => o.onRules(mode));
  const rulesPick = h('div.rsel-line.ng-rsel', rulesSlot, editBtn);
  // [TIEMPO] round limit · per move · final minute
  let clock = sanitizeClock(o.clock);
  const clockRow = clockPicker((c) => {
    clock = c;
    o.onClock({ ...c });
  });
  clockRow.render(clock);
  const rulesLine = h('div.ng-rules-wrap', plainLine, clockRow.el);
  function renderRuleSelect(): void {
    // rule sets are picked here (Ajustes › Reglas only edits them): the dropdown always shows, even with
    // only the built-in rules; the plain line is a fallback for when no choices are provided at all
    // the shared game-mode dropdown (built-ins + the player's own modes, with icons)
    rulesPick.hidden = false;
    plainLine.hidden = true;
    rulesSlot.replaceChildren(
      modeSelect({
        current: customId ?? mode,
        onPick: (id) => {
          const c = isBuiltInMode(id) ? null : customMode(id);
          customId = c ? c.id : null;
          o.onCustom?.(customId);
          setMode(c ? c.base : (id as GameMode), true);
          updateRules();
          renderRuleSelect();
        },
      }),
    );
  }

  const surprise = btn(
    t('newgame.surprise'),
    () => {
      const p = ROSTER.map((c) => c.id);
      const d = () => p.splice(Math.floor(Math.random() * p.length), 1)[0];
      lu = { 1: d(), 2: d(), 3: d() };
      renderSeats();
      shown = lu[active];
      refresh();
      o.onLineup({ ...lu });
      for (const s of slots()) bump(s);
    },
    'ghost ng-surprise',
    h('span.btn-icon', { html: DICE }),
  );
  const start = btn(
    t('newgame.start'),
    () => o.onStart({ mode, ...(customId ? { custom: customId } : {}), players: count(), teams: isTeams(), lineup: { ...lu }, clock: { ...clock }, swappedSeats: side() ? swappedSeats : undefined }),
    'primary ng-start',
    h('span.btn-icon', { html: ICONS.play }),
  );
  start.dataset.autofocus = '';

  const applyMode = () => {
    // the partner seat shows my avatar after the swap: never leave the picker pointing at it
    if (side() && swappedSeats && active === PARTNER_SLOT) {
      active = ([2, 3] as Slot[]).find((s) => slots().includes(s)) ?? PARTNER_SLOT;
      shown = lu[active];
    }
    // never hidden, only disabled: Codo a codo is always 4 players, 2 vs 2; teams need 4 players
    fixedNote.hidden = true;
    playersSeg.querySelector<HTMLButtonElement>('.rsel-btn')?.toggleAttribute('disabled', forcedTeams());
    playersSeg.classList.toggle('is-disabled', forcedTeams());
    const teamsLocked = def().teams !== 'optional' || players !== 4;
    const shownTeams = forcedTeams() ? 'teams' : def().teams === 'off' || players !== 4 ? 'ffa' : teams2v2 ? 'teams' : 'ffa';
    teamsSeg.classList.toggle('is-disabled', teamsLocked);
    teamsSeg.querySelectorAll<HTMLButtonElement>('.seg-opt').forEach((b, i) => {
      b.disabled = teamsLocked;
      b.setAttribute('aria-checked', String((i === 0 ? 'ffa' : 'teams') === shownTeams));
    });
    renderSeats();
    refresh();
    updateRules();
  };

  const footInner = h('div.ng-foot-inner', rulesLine, h('div.ng-foot-btns', surprise, start));
  const foot = h('div.ng-foot');
  const sideFoot = h('div.ng-side-foot');
  const root = h(
    'section.screen.panel-screen.newgame',
    screenHeader(t('newgame.title'), o.onBack),
    h(
      'div.scroll.ng-scroll',
      h(
        'div.ng-body',
        h('div.ng-left', rulesPick, h('div.ng-lines', playersRow, seatingRow), h('div.ng-felt-box', felt, swapSide)),
        h('div.ng-right', pickPanel, sideFoot),
      ),
    ),
    foot,
  );
  // sheet mode: the panel lives at the screen root (over the footer), with its scrim
  const right = root.querySelector('.ng-right')!;
  const placeSheet = (): void => {
    closeSheet();
    if (sheetMq.matches) {
      root.append(scrim, pickPanel);
    } else {
      scrim.remove();
      right.prepend(pickPanel);
    }
  };
  placeSheet();
  sheetMq.addEventListener('change', placeSheet);
  // swipe the sheet down (from its handle / title) to close it
  let drag: { y: number; id: number } | null = null;
  pickPanel.addEventListener('pointerdown', (e) => {
    if (!sheetOpen || !(e.target === handle || e.target === pickTitle || e.target === pickPanel)) return;
    drag = { y: e.clientY, id: e.pointerId };
    pickPanel.setPointerCapture(e.pointerId);
    pickPanel.style.transition = 'none';
  });
  pickPanel.addEventListener('pointermove', (e) => {
    if (drag && e.pointerId === drag.id) pickPanel.style.transform = `translateY(${Math.max(0, e.clientY - drag.y)}px)`;
  });
  const endDrag = (e: PointerEvent): void => {
    if (!drag || e.pointerId !== drag.id) return;
    const dy = e.clientY - drag.y;
    drag = null;
    pickPanel.style.transition = '';
    pickPanel.style.transform = '';
    if (dy > 60) closeSheet();
  };
  pickPanel.addEventListener('pointerup', endDrag);
  pickPanel.addEventListener('pointercancel', endDrag);
  // Escape / Android back close the sheet first
  const onKey = (e: KeyboardEvent): void => {
    if (!root.isConnected) return void window.removeEventListener('keydown', onKey, true);
    if (sheetOpen && (e.key === 'Escape' || e.key === 'GoBack' || e.key === 'BrowserBack')) {
      e.stopImmediatePropagation();
      e.preventDefault();
      closeSheet();
    }
  };
  window.addEventListener('keydown', onKey, true);
  // wide screens: the rules line and the two buttons sit under the character picker; phones keep the footer
  const wideMq = matchMedia('(min-width: 701px) and (orientation: landscape)');
  const placeFoot = () => {
    const into = wideMq.matches ? sideFoot : foot;
    if (footInner.parentElement !== into) into.append(footInner);
    foot.hidden = wideMq.matches;
  };
  placeFoot();
  wideMq.addEventListener('change', placeFoot);
  applyMode();
  return root;
}
