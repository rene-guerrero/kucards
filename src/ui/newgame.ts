/**
 * Nueva partida: mode cards (the four presets with their blurbs), player count (2–4; Parejas is always 4,
 * with the seating choice Enfrente / Codo a codo), a small table with the seats in play (tap a seat, then
 * a character from the roster grid) and a quick rules summary with "Cambiar reglas".
 * Character picking is ported from Kudominoes (seat ↔ grid, a character seated elsewhere swaps seats).
 */
import type { GameMode, Lineup, RulePreset, RuleSettings, Seat, Seating } from '../contracts';
import { character, LEVEL_STARS, ROSTER, type Character } from '../roster';
import { liveFace, staticFace } from './avatarAdapter';
import { cardSvg } from './cardArt';
import { h, prefersReducedMotion } from './dom';
import { seatingDiagram, screenHeader } from './howto';
import { loc, t, type Key } from './i18n';
import { btn, ICONS, segmented } from './overlay';

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

/** a mini card fan per mode on its card */
const MODE_ART: Record<GameMode, string> = {
  classic: cardSvg({ kind: 'number', color: 'mar', value: 7 }, { width: 26 }) + cardSvg({ kind: 'number', color: 'sol', value: 4 }, { width: 26 }),
  action: cardSvg({ kind: 'swap', color: null }, { width: 26 }) + cardSvg({ kind: 'shield', color: 'palma' }, { width: 26 }),
  cyclone: cardSvg({ kind: 'draw2', color: 'coral', draw: 2 }, { width: 26 }) + cardSvg({ kind: 'wild4', color: null, draw: 4 }, { width: 26 }),
  partners: cardSvg({ kind: 'number', color: 'coral', value: 2 }, { width: 26 }) + cardSvg({ kind: 'number', color: 'coral', value: 2 }, { width: 26 }),
};

export interface NewGameStart {
  mode: GameMode;
  players: 2 | 3 | 4;
  seating?: Seating;
  /** the characters in seats 1..3 (seats not in play hold unused characters) */
  lineup: Required<Lineup>;
}

export interface NewGameOpts {
  presets: RulePreset[];
  mode: GameMode;
  players: 2 | 3 | 4;
  lineup: Lineup;
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
  onSeating(s: Seating): void;
  onRules(mode: GameMode): void;
  onStart(o: NewGameStart): void;
  onBack(): void;
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
  let players: 2 | 3 | 4 = o.players;
  let seating: Seating = o.rulesFor('partners').seating === 'side' ? 'side' : 'across';
  const count = () => (mode === 'partners' ? 4 : players);
  const slots = () => CPU_SEATS[count()];
  let active: Slot = slots()[0];
  let shown = lu[active];
  /** partners: team of a seat */
  const teamOf = (s: Seat): 0 | 1 => (seating === 'side' ? (s <= 1 ? 0 : 1) : ((s % 2) as 0 | 1));

  // ── mode cards ──
  const modeCards = o.presets.map((p) => {
    const b = h(
      'button.mode-card',
      { type: 'button', role: 'radio', 'aria-checked': String(p.id === mode), class: `mode-${p.id}` },
      h('span.mode-art', { html: MODE_ART[p.id] }),
      h('span.mode-text', h('span.mode-name', loc(p.label)), h('span.mode-blurb', loc(p.blurb))),
    );
    b.addEventListener('click', () => {
      if (mode === p.id) return;
      mode = p.id;
      modeCards.forEach((c, i) => c.setAttribute('aria-checked', String(o.presets[i].id === mode)));
      o.onMode(mode);
      if (!slots().includes(active)) active = slots()[0];
      shown = lu[active];
      applyMode();
    });
    return b;
  });
  const modeGrid = h('div.mode-grid', { role: 'radiogroup', 'aria-label': t('newgame.mode') }, ...modeCards);

  // ── players / seating ──
  const playersSeg = segmented<number>(
    [2, 3, 4].map((n) => ({ value: n, label: String(n) })),
    players,
    (v) => {
      players = v as 2 | 3 | 4;
      o.onPlayers(players);
      if (!slots().includes(active)) active = slots()[0];
      shown = lu[active];
      applyMode();
    },
    t('newgame.players'),
  );
  playersSeg.classList.add('seg-players');
  const fixedNote = h('span.ng-fixed', t('newgame.fixed4'));
  const playersRow = h('div.ng-line', h('span.ng-line-label', t('newgame.players')), playersSeg, fixedNote);

  const seatOpt = (v: Seating) => {
    const b = h(
      'button.seating-opt',
      { type: 'button', role: 'radio', 'aria-checked': String(v === seating) },
      seatingDiagram(v === 'across' ? 'ABAB' : 'AABB', 46),
      h('span.seating-text', h('span.seating-name', t(`seating.${v}` as Key)), h('span.seating-code', v === 'across' ? 'A B A B' : 'A A B B')),
    );
    b.addEventListener('click', () => {
      if (seating === v) return;
      seating = v;
      seatBtns.forEach((x, i) => x.setAttribute('aria-checked', String((i === 0 ? 'across' : 'side') === seating)));
      o.onSeating(seating);
      renderSeats();
      updateRules();
    });
    return b;
  };
  const seatBtns = [seatOpt('across'), seatOpt('side')];
  const seatingRow = h('div.ng-line.ng-seating', h('span.ng-line-label', t('newgame.seating')), h('div.seating-opts', { role: 'radiogroup', 'aria-label': t('newgame.seating') }, ...seatBtns));

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
      active = s;
      shown = lu[s];
      refresh();
      grid.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
    seatEls.set(s, { btn: b, face, name, meta });
    felt.append(b);
  }
  const meTeam = h('span.ng-team');
  felt.append(
    h(
      'div.ng-seat.pos-bottom.me',
      h('span.ng-seat-face', o.avatars ? staticFace(o.humanFace, 'idle', o.humanName) : h('span.ng-letter', o.humanName.slice(0, 1))),
      h('span.ng-seat-name', o.humanName),
      meTeam,
    ),
  );
  const faceNode = (c: Character, live: boolean): HTMLElement => (o.avatars ? (live ? liveFace(c.face, 'idle', c.name).el : staticFace(c.face, 'idle', c.name)) : h('span.ng-letter', c.name.slice(0, 1)));
  const renderSeat = (s: Slot) => {
    const el = seatEls.get(s)!;
    const inUse = slots().includes(s);
    el.btn.hidden = !inUse;
    if (!inUse) return;
    const c = character(lu[s]);
    el.face.replaceChildren(faceNode(c, true));
    el.name.textContent = c.name;
    const partners = mode === 'partners';
    const team = partners ? teamOf(s) : null;
    el.btn.classList.toggle('team-0', team === 0);
    el.btn.classList.toggle('team-1', team === 1);
    const role = partners ? (team === teamOf(0) ? t(c.fem ? 'role.partnerF' : 'role.partner') : t('role.rival')) : null;
    el.meta.replaceChildren(c.level === 'master' ? levelBadge(c) : h('span', role ? `${role} · ${levelLabel(c)}` : levelLabel(c)));
    el.btn.setAttribute('aria-label', `${t('newgame.seatAria')}: ${c.name}, ${levelLabel(c)}`);
  };
  const renderSeats = () => {
    for (const s of [1, 2, 3] as Slot[]) renderSeat(s);
    felt.dataset.n = String(count());
    felt.classList.toggle('partners', mode === 'partners');
    const team = mode === 'partners' ? teamOf(0) : null;
    meTeam.textContent = team === null ? '' : team === 0 ? 'A' : 'B';
    felt.querySelector('.me')!.classList.toggle('team-0', team === 0);
  };

  // ── roster grid ──
  const pickTitle = h('h3.ng-pick-title');
  const grid = h('div.ng-grid', { role: 'listbox', 'aria-label': t('newgame.characters') });
  const desc = h('p.ng-desc', { 'aria-live': 'polite' });
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
    b.addEventListener('click', () => pick(c.id));
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
  };
  const rulesLink = h('button.link-btn', { type: 'button' }, t('newgame.changeRules'));
  rulesLink.addEventListener('click', () => o.onRules(mode));
  const rulesLine = h('div.ng-rules', h('div.ng-rules-top', h('span.preset-k', `${t('newgame.rules')}:`), rulesName, rulesLink), rulesSum);

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
    () => o.onStart({ mode, players: count(), seating: mode === 'partners' ? seating : undefined, lineup: { ...lu } }),
    'primary ng-start',
    h('span.btn-icon', { html: ICONS.play }),
  );
  start.dataset.autofocus = '';

  const applyMode = () => {
    const partners = mode === 'partners';
    playersSeg.hidden = partners;
    fixedNote.hidden = !partners;
    seatingRow.hidden = !partners;
    renderSeats();
    refresh();
    updateRules();
  };

  const root = h(
    'section.screen.panel-screen.newgame',
    screenHeader(t('newgame.title'), o.onBack),
    h(
      'div.scroll.ng-scroll',
      h(
        'div.ng-body',
        h('div.ng-left', h('h3.ng-h', t('newgame.mode')), modeGrid, playersRow, seatingRow, h('div.ng-felt-box', felt)),
        h('div.ng-right', h('section.ng-pick', pickTitle, grid, desc), rulesLine),
      ),
    ),
    h('div.ng-foot', surprise, start),
  );
  applyMode();
  return root;
}
