/**
 * In-game HUD (HTML over the 3D table). Built once; per-event updates only write text nodes / classes
 * and animate transform/opacity.
 *
 * Controller API (phase 3):
 *   show(on) · setRound(n) · setTarget(n|null) · setScores(rows, bump?) · setActiveColor(c|null)
 *   setDirection(d) · setPending(n) · notice(text)
 *   setPlayers(list)                      names / faces / counts, used by the target picker
 *   setKu('hidden' | 'shown' | 'armed')   the big ¡Ku! button; onKu fires on tap (also waitKu())
 *   pickColor(): Promise<Color>
 *   pickTarget(seats, title?): Promise<Seat>
 *   showResponse(opts): Promise<'shield' | 'mirror' | 'accept'>   resolves 'accept' when the ring runs out
 *   kuPop(name?): Promise<void>           the big ¡KU! lettering
 *   closeAll()                            drops any open picker / response bar (their promises never resolve)
 */
import type { Color, Direction, Seat } from '../contracts';
import { COLORS } from '../contracts';
import type { FaceSpec } from '../roster';
import { staticFace } from './avatarAdapter';
import { COLOR_HEX, symbolSvg } from './cardArt';
import { h, prefersReducedMotion, svgEl } from './dom';
import { t, type Key } from './i18n';
import { iconBtn, ICONS, type Overlay } from './overlay';

export interface HudPlayer {
  seat: Seat;
  name: string;
  face: FaceSpec;
  count?: number;
  team?: 0 | 1;
}

export interface ScoreRow {
  /** a seat, or a team label in partners mode */
  label: string;
  value: number;
  me?: boolean;
  team?: 0 | 1;
}

export interface ResponseOpts {
  /** the stacked penalty aimed at the human */
  total: number;
  canShield: boolean;
  canMirror: boolean;
  /** wild4Challenge: the +4 (or +10) may be challenged */
  canChallenge?: boolean;
  /** stacking: the human may answer with a penalty card from the hand instead (shown as a hint) */
  canStack?: boolean;
  /** how long the window stays open (ms) */
  ms?: number;
}

export type KuState = 'hidden' | 'shown' | 'armed';
export type ResponseChoice = 'shield' | 'mirror' | 'challenge' | 'accept';

const DIR_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12a7 7 0 1 1-2.05-4.95" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><path d="M17.5 3.5v4h-4" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

export class Hud {
  readonly el: HTMLElement;
  avatars = true;
  /** the human tapped ¡Ku! */
  onKu: (() => void) | null = null;

  private roundEl = h('span.hud-round');
  private targetEl = h('span.hud-target');
  private scoresEl = h('div.hud-scores', { role: 'group' });
  private colorEl = h('span.hud-color', { role: 'status' });
  private dirEl = h('span.hud-dir', { html: DIR_SVG });
  private pendingEl = h('span.hud-pending', { role: 'status' });
  private noticeEl = h('div.notice', { role: 'status', 'aria-live': 'polite' });
  private kuBtn: HTMLButtonElement;
  private kuWaiters: (() => void)[] = [];
  private pauseBtn: HTMLButtonElement;
  private respLayer = h('div.resp-host');
  private popLayer = h('div.ku-pop-host', { 'aria-hidden': 'true' });
  private notices: string[] = [];
  private noticeBusy = false;
  private noticeTimer = 0;
  private round = 0;
  private target: number | null = null;
  private players: HudPlayer[] = [];
  private closers: (() => void)[] = [];

  constructor(
    private overlay: Overlay,
    onPause: () => void,
  ) {
    this.pauseBtn = iconBtn(ICONS.pause, t('hud.pause'), onPause, 'pause-btn');
    this.kuBtn = h('button.ku-btn', { type: 'button', 'aria-label': t('hud.kuAria') }, h('span.ku-btn-word', t('game.ku')));
    this.kuBtn.addEventListener('click', () => {
      if (!this.kuBtn.classList.contains('armed')) return;
      if (!prefersReducedMotion()) this.kuBtn.animate([{ transform: 'scale(.86)' }, { transform: 'scale(1)' }], { duration: 260, easing: 'cubic-bezier(.2,1.6,.4,1)' });
      this.onKu?.();
      const w = this.kuWaiters;
      this.kuWaiters = [];
      w.forEach((f) => f());
    });
    this.el = h(
      'div.hud',
      h(
        'div.hud-top',
        h('div.score-card', this.scoresEl),
        h('div.hud-center', h('div.hud-info', h('div.hand-line', this.roundEl, h('span.sep', '·'), this.targetEl), h('div.hud-chips', this.colorEl, this.dirEl, this.pendingEl)), this.noticeEl),
        this.pauseBtn,
      ),
      this.kuBtn,
      this.respLayer,
      this.popLayer,
    );
    this.setKu('hidden');
    this.setActiveColor(null);
    this.setPending(0);
    this.relabel();
  }

  relabel(): void {
    this.pauseBtn.setAttribute('aria-label', t('hud.pause'));
    this.pauseBtn.title = t('hud.pause');
    this.kuBtn.setAttribute('aria-label', t('hud.kuAria'));
    this.scoresEl.setAttribute('aria-label', t('hud.scoresAria'));
    this.dirEl.title = t('hud.direction');
    this.setRound(this.round);
    this.setTarget(this.target);
  }

  show(on: boolean): void {
    this.el.classList.toggle('on', on);
  }

  setRound(n: number): void {
    this.round = n;
    this.roundEl.textContent = n ? t('hud.round', { n }) : '';
  }

  setTarget(n: number | null): void {
    this.target = n;
    this.targetEl.textContent = n ? t('hud.target', { n }) : t('hud.oneRound');
  }

  /** compact score rows (by seat, or two team rows in partners mode); the leader is highlighted */
  setScores(rows: ScoreRow[], bump = false): void {
    const prev = [...this.scoresEl.querySelectorAll<HTMLElement>('.hs-pts')].map((e) => Number(e.textContent));
    const top = Math.max(0, ...rows.map((r) => r.value));
    this.scoresEl.replaceChildren(
      ...rows.map((r, i) => {
        const pts = h('span.hs-pts', String(r.value));
        if (bump && prev[i] !== undefined && prev[i] !== r.value && !prefersReducedMotion())
          requestAnimationFrame(() => pts.animate([{ transform: 'scale(1.6)' }, { transform: 'scale(1)' }], { duration: 450, easing: 'cubic-bezier(.2,1.6,.4,1)' }));
        return h(
          'div.hs-row',
          { class: `${r.me ? 'me' : ''}${top > 0 && r.value === top ? ' lead' : ''}${r.team !== undefined ? ` team-${r.team}` : ''}` },
          h('span.hs-name', r.label),
          pts,
        );
      }),
    );
    this.scoresEl.classList.toggle('many', rows.length > 2);
  }

  /** the colour in play (after a wild it differs from the top card) */
  setActiveColor(c: Color | null): void {
    this.colorEl.hidden = !c;
    if (!c) return;
    this.colorEl.style.setProperty('--c', COLOR_HEX[c]);
    this.colorEl.innerHTML = symbolSvg(c, 16, '#fff6e6');
    this.colorEl.setAttribute('aria-label', t('hud.activeColor', { color: t(`color.${c}` as Key) }));
    this.colorEl.title = t(`color.${c}` as Key);
  }

  setDirection(d: Direction): void {
    this.dirEl.classList.toggle('ccw', d === -1);
    if (!prefersReducedMotion()) this.dirEl.animate([{ transform: `scaleX(${d === -1 ? 1 : -1})` }, { transform: `scaleX(${d === -1 ? -1 : 1})` }], { duration: 300 });
  }

  /** the stacked penalty waiting to be drawn (0 hides it) */
  setPending(n: number): void {
    this.pendingEl.hidden = n <= 0;
    this.pendingEl.textContent = `+${n}`;
    this.pendingEl.setAttribute('aria-label', t('hud.pendingAria', { n }));
    if (n > 0 && !prefersReducedMotion()) this.pendingEl.animate([{ transform: 'scale(1.5)' }, { transform: 'scale(1)' }], { duration: 380, easing: 'cubic-bezier(.2,1.6,.4,1)' });
  }

  setPlayers(list: HudPlayer[]): void {
    this.players = list.map((p) => ({ ...p }));
  }

  // ───────── ¡Ku! button ─────────

  setKu(state: KuState): void {
    this.kuBtn.classList.toggle('on', state !== 'hidden');
    this.kuBtn.classList.toggle('armed', state === 'armed');
    this.kuBtn.disabled = state !== 'armed';
    this.kuBtn.tabIndex = state === 'armed' ? 0 : -1;
  }

  /** resolves on the next tap of the armed ¡Ku! button */
  waitKu(): Promise<void> {
    return new Promise((r) => this.kuWaiters.push(r));
  }

  // ───────── pickers ─────────

  /** the four colours as big symbol buttons (after a wild) */
  pickColor(): Promise<Color> {
    return new Promise((resolve) => {
      let close = () => {};
      const opts = COLORS.map((c) => {
        const b = h(
          'button.color-opt',
          { type: 'button', style: `--c:${COLOR_HEX[c]}`, 'aria-label': t(`color.${c}` as Key) },
          h('span.color-sym', { html: symbolSvg(c, 44, '#fff6e6') }),
          h('span.color-name', t(`color.${c}` as Key)),
        );
        b.addEventListener('click', () => {
          close();
          resolve(c);
        });
        return b;
      });
      opts[0].dataset.autofocus = '';
      const card = h('div.card.picker.color-picker', h('h2.card-title', t('hud.pickColor')), h('div.color-grid', ...opts));
      close = this.track(this.overlay.openModal(card));
    });
  }

  /** choose a player (Cambio, 7 with the 7-0 rule): their faces, names and card counts */
  pickTarget(seats: Seat[], title: string = t('hud.pickTarget')): Promise<Seat> {
    return new Promise((resolve) => {
      let close = () => {};
      const opts = seats.map((s) => {
        const p = this.players.find((x) => x.seat === s) ?? { seat: s, name: `${t('seat.player')} ${s + 1}`, face: { iris: '#888' } };
        const b = h(
          'button.target-opt',
          { type: 'button', class: p.team !== undefined ? `team-${p.team}` : '' },
          h('span.target-face', this.avatars ? staticFace(p.face, 'idle', p.name) : h('span.ng-letter', p.name.slice(0, 1))),
          h('span.target-name', p.name),
          p.count !== undefined ? h('span.target-count', h('i.plate-card'), String(p.count)) : null,
        );
        b.setAttribute('aria-label', p.count !== undefined ? t('hud.targetAria', { name: p.name, n: p.count }) : p.name);
        b.addEventListener('click', () => {
          close();
          resolve(s);
        });
        return b;
      });
      if (opts[0]) opts[0].dataset.autofocus = '';
      const card = h('div.card.picker.target-picker', h('h2.card-title', title), h('div.target-grid', { class: `n${seats.length}` }, ...opts));
      close = this.track(this.overlay.openModal(card));
    });
  }

  /**
   * A penalty is aimed at the human: Escudo / Espejo / Aceptar with a countdown ring. The table stays
   * visible (a bar at the bottom, not a modal). Runs out → 'accept'.
   */
  showResponse(o: ResponseOpts): Promise<ResponseChoice> {
    return new Promise((resolve) => {
      const ms = Math.max(500, o.ms ?? 4000);
      let done = false;
      let timer = 0;
      const finish = (c: ResponseChoice) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        close();
        resolve(c);
      };
      const ring = svgEl('<svg class="resp-ring" viewBox="0 0 44 44" aria-hidden="true"><circle class="rr-track" cx="22" cy="22" r="19"/><circle class="rr-run" cx="22" cy="22" r="19" pathLength="100"/></svg>');
      const opt = (c: ResponseChoice, label: string, cls: string, on: boolean) => {
        const b = h('button.btn.resp-opt', { type: 'button', class: cls, disabled: !on || undefined }, h('span.btn-label', label));
        b.addEventListener('click', () => finish(c));
        return b;
      };
      const accept = opt('accept', t('hud.accept', { n: o.total }), 'ghost', true);
      const bar = h(
        'div.resp-bar',
        { role: 'alertdialog', 'aria-label': t('hud.responseAria', { n: o.total }) },
        h('div.resp-head', h('span.resp-ring-wrap', ring, h('span.resp-total', `+${o.total}`)), h('span.resp-title', t('hud.responseTitle', { n: o.total }))),
        h('div.resp-row', o.canShield ? opt('shield', t('card.shield'), 'primary', true) : null, o.canMirror ? opt('mirror', t('card.mirror'), 'secondary', true) : null, o.canChallenge ? opt('challenge', t('hud.challenge'), 'secondary', true) : null, accept),
      );
      this.respLayer.append(bar);
      const run = ring.querySelector('.rr-run') as SVGCircleElement;
      run.animate([{ strokeDashoffset: '0' }, { strokeDashoffset: '100' }], { duration: ms, easing: 'linear', fill: 'forwards' });
      timer = window.setTimeout(() => finish('accept'), ms);
      const close = this.track(() => {
        done = true;
        clearTimeout(timer);
        bar.classList.add('leaving');
        setTimeout(() => bar.remove(), 220);
      });
    });
  }

  /** the big ¡KU! lettering (with a name under it when someone else called it) */
  kuPop(name?: string): Promise<void> {
    return new Promise((resolve) => {
      const el = h('div.ku-pop', h('span.ku-pop-word', t('game.kuBig')), name ? h('span.ku-pop-name', name) : null);
      this.popLayer.append(el);
      const ms = prefersReducedMotion() ? 900 : 1300;
      const a = el.animate(
        prefersReducedMotion()
          ? [{ opacity: 0 }, { opacity: 1, offset: 0.15 }, { opacity: 1, offset: 0.8 }, { opacity: 0 }]
          : [
              { opacity: 0, transform: 'scale(.2) rotate(-14deg)' },
              { opacity: 1, transform: 'scale(1.18) rotate(4deg)', offset: 0.18 },
              { opacity: 1, transform: 'scale(1) rotate(-3deg)', offset: 0.3 },
              { opacity: 1, transform: 'scale(1.02) rotate(-3deg)', offset: 0.8 },
              { opacity: 0, transform: 'scale(1.3) rotate(-3deg)' },
            ],
        { duration: ms, easing: 'ease-out', fill: 'forwards' },
      );
      a.onfinish = () => {
        el.remove();
        resolve();
      };
    });
  }

  closeAll(): void {
    const c = this.closers;
    this.closers = [];
    c.forEach((f) => f());
  }

  private track(close: () => void): () => void {
    const f = () => {
      this.closers = this.closers.filter((x) => x !== f);
      close();
    };
    this.closers.push(f);
    return f;
  }

  // ───────── notices ─────────

  notice(text: string): void {
    if (this.notices.includes(text)) return;
    this.notices.push(text);
    if (!this.noticeBusy) this.nextNotice();
  }

  private nextNotice(): void {
    const txt = this.notices.shift();
    if (txt === undefined) {
      this.noticeBusy = false;
      return;
    }
    this.noticeBusy = true;
    this.noticeEl.textContent = txt;
    this.noticeEl.classList.add('on');
    this.noticeTimer = window.setTimeout(() => {
      this.noticeEl.classList.remove('on');
      this.noticeTimer = window.setTimeout(() => this.nextNotice(), 320);
    }, 2300);
  }

  reset(): void {
    this.closeAll();
    clearTimeout(this.noticeTimer);
    this.notices = [];
    this.noticeBusy = false;
    this.noticeEl.classList.remove('on');
    this.setKu('hidden');
    this.setPending(0);
    this.setActiveColor(null);
    this.setRound(0);
    this.setScores([]);
  }
}
