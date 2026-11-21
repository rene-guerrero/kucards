/**
 * Round summary, match end and the pause card. Ported from Kudominoes' sheets (fixed header and footer,
 * only the middle scrolls), rewritten for cards: cards left per player, their points, running totals,
 * team totals in partners mode.
 */
import { canFullscreen, toggleFullscreen } from '../app/fullscreen';
import type { Seat } from '../contracts';
import type { FaceSpec } from '../roster';
import { staticFace, type AvatarExpr } from './avatarAdapter';
import { countUp, h, prefersReducedMotion } from './dom';
import { t } from './i18n';
import { btn, ICONS } from './overlay';

export interface SummaryPlayer {
  seat: Seat;
  name: string;
  face: FaceSpec;
  /** cards left in hand at the end of the round */
  cardsLeft: number;
  /** the points those cards are worth */
  handPoints: number;
  /** running total before / after this round */
  prev: number;
  total: number;
  team?: 0 | 1;
  eliminated?: boolean;
}

export interface SummaryTeam {
  name: string;
  prev: number;
  total: number;
}

export interface RoundSummaryCtx {
  roundNo: number;
  winner: Seat;
  /** points the winner (or the winning team) scored this round */
  points: number;
  players: SummaryPlayer[];
  /** partners mode: the two teams (index = team) */
  teams?: [SummaryTeam, SummaryTeam];
  target: number | null;
  matchOver: boolean;
  /** the round ended because its time ran out (the fewest card points won) */
  byTime?: boolean;
  avatars?: boolean;
  /** animation speed factor (1 normal, < 1 faster) */
  speed?: number;
}

const face = (p: { face: FaceSpec; name: string }, avatars: boolean, expr: AvatarExpr) =>
  avatars ? h('span.avatar.has-face', staticFace(p.face, expr, p.name)) : h('span.avatar', p.name.slice(0, 1).toUpperCase());

/** keeps the scroll fades of a scrolling zone in sync */
function scrollFades(el: HTMLElement): void {
  const sync = () => {
    const more = el.scrollHeight - el.clientHeight > 2;
    el.classList.toggle('more-above', more && el.scrollTop > 2);
    el.classList.toggle('more-below', more && el.scrollTop + el.clientHeight < el.scrollHeight - 2);
  };
  el.addEventListener('scroll', sync, { passive: true });
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(sync).observe(el);
  requestAnimationFrame(sync);
}

/** a few tiny card backs standing for the cards left (capped, with a number) */
function miniCards(n: number): HTMLElement {
  const shown = Math.min(n, 8);
  return h('span.sum-cards', { 'aria-hidden': 'true' }, ...Array.from({ length: shown }, (_, i) => h('i.mini-card', { style: `--i:${i}` })));
}

export function buildRoundSummary(ctx: RoundSummaryCtx, onNext: () => void, onMenu: () => void): HTMLElement {
  const avatars = ctx.avatars !== false;
  const speed = ctx.speed ?? 1;
  const w = ctx.players.find((p) => p.seat === ctx.winner);
  const partners = !!ctx.teams;
  const myTeam = ctx.players.find((p) => p.seat === 0)?.team;
  const won = partners ? w?.team === myTeam : ctx.winner === 0;
  const u = t(ctx.points === 1 ? 'summary.point' : 'summary.points');
  const title = won ? t('summary.youWin') : t('summary.theyWin', { name: w?.name ?? '' });
  const sub = partners
    ? t('summary.teamPoints', { team: ctx.teams![w?.team ?? 0].name, n: ctx.points, u })
    : ctx.winner === 0
      ? t('summary.pointsYou', { n: ctx.points, u })
      : t('summary.pointsBy', { name: w?.name ?? '', n: ctx.points, u });
  // "Andrés suma 57 puntos de 500" (the match target replaces the old "a 500" line)
  const subLine = ctx.target ? t('summary.ofTarget', { text: sub, t: String(ctx.target) }) : sub;

  const rows = ctx.players.map((p, i) => {
    const num = h('span.sum-total', String(p.prev));
    const isW = p.seat === ctx.winner;
    const expr: AvatarExpr = isW ? 'happy' : partners && p.team === w?.team ? 'smug' : 'sad';
    const el = h(
      'div.sum-row',
      { class: `${p.seat === 0 ? 'me' : ''}${isW ? ' winner' : ''}${p.team !== undefined ? ` team-${p.team}` : ''}${p.eliminated ? ' out' : ''}`, style: `--i:${i}` },
      face(p, avatars, expr),
      h('span.sum-name', p.name, p.eliminated ? h('span.sum-out', ` · ${t('summary.out')}`) : null),
      h('span.sum-left', miniCards(p.cardsLeft), h('span.sum-left-n', isW && !ctx.byTime ? t('summary.empty') : t(p.cardsLeft === 1 ? 'summary.cards1' : 'summary.cardsN', { n: p.cardsLeft }))),
      h('span.sum-hand', isW ? '—' : String(p.handPoints)),
      num,
    );
    return { p, el, num };
  });
  // only the number columns are labelled (the rows say who and how many cards)
  const head = h('div.sum-row.sum-cols', h('span'), h('span.sum-name'), h('span.sum-left'), h('span.sum-hand', t('summary.pts')), h('span.sum-total', t('summary.total')));

  const teamEls = ctx.teams?.map((tm, i) => {
    const num = h('span.big-num', String(tm.prev));
    return { tm, num, el: h('div.score-col', { class: `team-${i}${i === myTeam ? ' me' : ''}` }, h('span.score-name', tm.name), num) };
  });

  const next = btn(ctx.matchOver ? t('summary.toMatchEnd') : t('summary.next'), onNext, 'primary lg', h('span.btn-icon', { html: ICONS.play }));
  next.dataset.autofocus = '';
  const body = h(
    'div.sum-body',
    h('div.sum-table', { role: 'table', 'aria-label': t('summary.title') }, head, ...rows.map((r) => r.el)),
    teamEls ? h('div.score-block.teams', ...teamEls.map((x) => x.el)) : null,
  );
  const card = h(
    'div.card.sheet.summary',
    { class: won ? 'tone-win' : 'tone-lose' },
    h('header.sum-head', h('div.kicker', t('summary.round', { n: ctx.roundNo })), h('h2.summary-title', title), h('p.summary-sub', subLine)),
    body,
    h('footer.sum-foot', btn(t('match.menu'), onMenu, 'ghost lg', h('span.btn-icon', { html: ICONS.home })), next),
  );
  scrollFades(body);
  const ms = 1000 * speed;
  setTimeout(() => {
    for (const r of rows) {
      void countUp(r.num, r.p.prev, r.p.total, ms);
      if (r.p.total !== r.p.prev && !prefersReducedMotion())
        setTimeout(() => r.num.animate([{ transform: 'scale(1.3)' }, { transform: 'scale(1)' }], { duration: 380, easing: 'cubic-bezier(.2,1.6,.4,1)' }), ms);
    }
    for (const x of teamEls ?? []) void countUp(x.num, x.tm.prev, x.tm.total, ms);
  }, prefersReducedMotion() ? 0 : 500 * speed);
  return card;
}

export interface MatchEndCtx {
  /** the winning seat (individual) */
  winner: Seat | null;
  /** partners: the winning team */
  winnerTeam?: 0 | 1 | null;
  players: { seat: Seat; name: string; face: FaceSpec; total: number; team?: 0 | 1 }[];
  teams?: [SummaryTeam, SummaryTeam];
  avatars?: boolean;
}

export function buildMatchEnd(ctx: MatchEndCtx, onRematch: () => void, onMenu: () => void): HTMLElement {
  const avatars = ctx.avatars !== false;
  const partners = !!ctx.teams && ctx.winnerTeam !== undefined && ctx.winnerTeam !== null;
  const myTeam = ctx.players.find((p) => p.seat === 0)?.team;
  const won = partners ? ctx.winnerTeam === myTeam : ctx.winner === 0;
  const isW = (p: MatchEndCtx['players'][number]) => (partners ? p.team === ctx.winnerTeam : p.seat === ctx.winner);
  const wName = ctx.players.find((p) => p.seat === ctx.winner)?.name ?? '';
  const title = won ? t('match.win') : partners ? t('match.loseTeam') : t('match.lose', { name: wName });
  const ranked = ctx.players.slice().sort((a, b) => b.total - a.total);
  const faces = avatars
    ? h(
        'div.me-faces',
        ...ctx.players.map((p, i) =>
          h('div.me-face', { class: isW(p) ? 'win' : 'lose', style: `--i:${i}`, title: p.name }, staticFace(p.face, isW(p) ? 'happy' : 'sad', p.name), h('span.me-name', p.name)),
        ),
      )
    : null;
  const standings = partners
    ? h(
        'div.final-score',
        h('div.fs-col', { class: `team-0${myTeam === 0 ? ' me' : ''}` }, h('span.score-name', ctx.teams![0].name), h('span.big-num', String(ctx.teams![0].total))),
        h('span.fs-dash', '–'),
        h('div.fs-col', { class: `team-1${myTeam === 1 ? ' me' : ''}` }, h('span.score-name', ctx.teams![1].name), h('span.big-num', String(ctx.teams![1].total))),
      )
    : h(
        'ol.standings',
        { 'aria-label': t('match.standings') },
        ...ranked.map((p, i) =>
          h('li.standing', { class: `${p.seat === 0 ? 'me' : ''}${isW(p) ? ' first' : ''}`, style: `--i:${i}` }, h('span.st-rank', String(i + 1)), h('span.st-name', p.name), h('span.st-pts', String(p.total))),
        ),
      );
  const confetti = won && !prefersReducedMotion() ? h('div.confetti', ...Array.from({ length: 36 }, (_, i) => h('i', { style: `--i:${i};--x:${(i * 37) % 100};--d:${(i * 53) % 10}` }))) : null;
  const rematch = btn(t('match.rematch'), onRematch, 'primary lg', h('span.btn-icon', { html: ICONS.resume }));
  rematch.dataset.autofocus = '';
  return h(
    'div.card.sheet.match-end',
    { class: won ? 'tone-win' : 'tone-lose' },
    confetti,
    h('div.sheet-a', h('div.trophy', { html: won ? TROPHY : CARDS_DOWN }), h('h2.summary-title', title), faces),
    h('div.sheet-b', standings, h('div.sheet-actions', btn(t('match.menu'), onMenu, 'ghost lg', h('span.btn-icon', { html: ICONS.home })), rematch)),
  );
}

export type AudioKey = 'sound' | 'voice' | 'music' | 'vibration';

export function audioToggle(key: AudioKey, on: boolean, onChange: (key: AudioKey, on: boolean) => void): HTMLButtonElement {
  const label = t(`settings.${key}`);
  const b = h('button.icon-btn.audio-tg', { type: 'button', 'aria-pressed': String(on), 'aria-label': label, title: label, html: AUDIO_ICONS[key] });
  b.addEventListener('click', () => {
    on = !on;
    b.setAttribute('aria-pressed', String(on));
    onChange(key, on);
  });
  return b;
}

/** an icon-only fullscreen button, styled like the audio toggles */
function fullscreenToggle(): HTMLButtonElement {
  const label = t('menu.fullscreen');
  const b = h('button.icon-btn.audio-tg.fs-tg', { type: 'button', 'aria-label': label, title: label, html: ICONS.fullscreen });
  b.addEventListener('click', () => void toggleFullscreen());
  return b;
}

export function buildPause(o: {
  audio: Record<AudioKey, boolean>;
  onAudio(key: AudioKey, on: boolean): void;
  onResume(): void;
  onSettings(): void;
  /** the mode's rules, read-only (replaces Cómo jugar: that lives in the main menu) */
  onRules(): void;
  onQuit(): void;
}): HTMLElement {
  const resume = btn(t('pause.resume'), o.onResume, 'primary lg', h('span.btn-icon', { html: ICONS.play }));
  resume.dataset.autofocus = '';
  return h(
    'div.card.pause',
    h('h2.card-title', t('pause.title')),
    h(
      'div.stack',
      resume,
      // two equal halves: settings, the mode's rules
      h(
        'div.pause-grid',
        btn(t('menu.settings'), o.onSettings, 'secondary', h('span.btn-icon', { html: ICONS.gear })),
        btn(t('modes.rules'), o.onRules, 'secondary', h('span.btn-icon', { html: ICONS.book })),
      ),
      // equal icon toggles across the whole row: sound, music, vibration, fullscreen
      h(
        'div.pause-grid.pause-icons',
        audioToggle('sound', o.audio.sound, o.onAudio),
        audioToggle('voice', o.audio.voice, o.onAudio),
        audioToggle('music', o.audio.music, o.onAudio),
        typeof navigator.vibrate === 'function' ? audioToggle('vibration', o.audio.vibration, o.onAudio) : null,
        canFullscreen() ? fullscreenToggle() : null,
      ),
      btn(t('pause.quit'), o.onQuit, 'ghost', h('span.btn-icon', { html: ICONS.home })),
    ),
  );
}

const STROKE = 'fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"';
const SLASH = `<path class="off" d="M4 4l16 16" ${STROKE}/>`;
const AUDIO_ICONS: Record<AudioKey, string> = {
  sound: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 9.2h3.6L11.8 5v14l-4.7-4.2H3.5z"/><path class="on" d="M15.2 9a4.2 4.2 0 0 1 0 6M17.9 6.3a8 8 0 0 1 0 11.4" ${STROKE}/><path class="off" d="M15.5 9.5l5 5M20.5 9.5l-5 5" ${STROKE}/></svg>`,
  voice: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3.5" width="6" height="11" rx="3" ${STROKE}/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v2.6M8.8 20.6h6.4" ${STROKE}/>${SLASH}</svg>`,
  music: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9.5 17.2V6.4l10-2.2v10.6" ${STROKE}/><circle cx="7" cy="17.4" r="2.7"/><circle cx="17" cy="15" r="2.7"/>${SLASH}</svg>`,
  vibration: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="3.5" width="8" height="17" rx="2.2" ${STROKE}/><path class="on" d="M4.6 9v6M19.4 9v6M1.8 10.6v2.8M22.2 10.6v2.8" ${STROKE}/>${SLASH}</svg>`,
};

const TROPHY = `<svg viewBox="0 0 120 110" aria-hidden="true">
<path d="M30 14h60v22c0 20-13 36-30 36S30 56 30 36z" fill="#ffb627"/>
<path d="M30 22H14c0 18 8 28 20 30M90 22h16c0 18-8 28-20 30" fill="none" stroke="#ffb627" stroke-width="7" stroke-linecap="round"/>
<path d="M52 70h16l3 16H49z" fill="#d98a0b"/><rect x="38" y="86" width="44" height="12" rx="4" fill="#14a3a0"/>
<path d="M44 20h8v26c0 6 3 10 6 12-8-1-14-7-14-15z" fill="#fff" opacity=".35"/>
<circle cx="60" cy="38" r="9" fill="#fff6e6"/></svg>`;
const CARDS_DOWN = `<svg viewBox="0 0 120 110" aria-hidden="true">
<g transform="rotate(-14 60 60)"><rect x="34" y="22" width="44" height="66" rx="8" fill="#fff6e6"/><rect x="38" y="26" width="36" height="58" rx="5" fill="#14a3a0"/></g>
<g transform="rotate(10 60 60)"><rect x="44" y="20" width="44" height="66" rx="8" fill="#fff6e6"/><rect x="48" y="24" width="36" height="58" rx="5" fill="#ff6f61"/><circle cx="66" cy="53" r="10" fill="#fff6e6"/></g>
<path d="M18 100q42-14 84 0" fill="none" stroke="#fff" stroke-opacity=".25" stroke-width="4" stroke-linecap="round"/></svg>`;
