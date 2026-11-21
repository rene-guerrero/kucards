/**
 * In-game HUD (HTML over the 3D table). Built once; per-event updates only write text nodes / classes
 * and animate transform/opacity.
 *
 * Controller API (phase 3):
 *   show(on) · setRound(n) · setTarget(n|null) · setScores(rows, bump?)
 *   setPending(n) · notice(text)
 *   setPlayers(list)                      names / faces / counts, used by the target picker
 *   setKu('hidden' | 'shown' | 'armed')   the big ¡Ku! button; onKu fires on tap (also waitKu())
 *   pickColor(): Promise<Color>
 *   pickTarget(seats, title?): Promise<Seat>
 *   showResponse(opts): Promise<'shield' | 'mirror' | 'accept'>   resolves 'accept' when the ring runs out
 *   kuPop(name?): Promise<void>           the big ¡KU! lettering
 *   closeAll()                            drops any open picker / response bar (their promises never resolve)
 */
import type { Color, Seat } from '../contracts';
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
  /** false = no "Robar" button (stacking is mandatory); the ring running out still resolves 'accept' */
  canAccept?: boolean;
  /** how long the window stays open (ms) */
  ms?: number;
}

export type KuState = 'hidden' | 'shown' | 'armed';
export type ResponseChoice = 'shield' | 'mirror' | 'challenge' | 'accept';

export class Hud {
  readonly el: HTMLElement;
  avatars = true;
  /** the human tapped ¡Ku! */
  onKu: (() => void) | null = null;
  /** where the colour pane springs from (the pile's viewport point); centre of the screen when null */
  colorAnchor: (() => { x: number; y: number } | null) | null = null;

  private roundEl = h('span.hud-round');
  private targetEl = h('span.hud-target');
  private clockTxt = h('span.hud-clock-t');
  private clockEl = h(
    'span.hud-clock',
    { hidden: true, role: 'timer', 'aria-label': t('clock.left') },
    h('span.hud-clock-i', {
      'aria-hidden': 'true',
      html: '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><circle cx="12" cy="13" r="8"/><path d="M12 9v4.2l2.6 1.6M9.5 2.5h5"/></svg>',
    }),
    this.clockTxt,
  );
  private clockShown = '';
  /** the final-minute "hurry" glow around the screen edges (and a warmer table light) */
  private hurryEl = h('div.hurry-fx', { 'aria-hidden': 'true' });
  private scoresEl = h('div.hud-scores', { role: 'group' });
  private pendingEl = h('span.hud-pending', { role: 'status' });
  private noticeEl = h('div.notice', { role: 'status', 'aria-live': 'polite' });
  private kuBtn: HTMLButtonElement;

  /**
   * Put the ¡Ku! button beside the human's cards: from the human's plate (left of the hand) mirror to the
   * hand's right edge, level with the plate. Called on every plate layout.
   */
  placeKu(plate: { x: number; y: number; w: number; h: number } | undefined, W: number, H: number): void {
    const b = this.kuBtn;
    if (!plate) return;
    const size = b.offsetWidth || 72;
    // mirrored to the avatar: the plate on the right (partner on the right) puts ¡Ku! on the left
    const right = plate.x > W / 2;
    const px = right ? W - plate.x : plate.x;
    const handRight = W - (px + plate.w / 2 + 10);
    const x0 = Math.min(W - size / 2 - 8, handRight + 12 + size / 2);
    const x = right ? W - x0 : x0;
    const y = Math.min(H - size / 2 - 8, Math.max(size / 2 + 8, plate.y));
    b.style.left = `${x - size / 2}px`;
    b.style.top = `${y - size / 2}px`;
    b.style.right = 'auto';
    b.style.bottom = 'auto';
  }
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
      this.hurryEl,
      h(
        'div.hud-top',
        h('div.score-card', this.scoresEl),
        h('div.hud-center', h('div.hud-info', h('div.hand-line', this.roundEl, this.clockEl), h('div.hud-chips', this.pendingEl)), this.noticeEl),
        this.pauseBtn,
      ),
      this.kuBtn,
      this.respLayer,
      this.popLayer,
    );
    this.setKu('hidden');
    this.setPending(0);
    this.relabel();
  }

  relabel(): void {
    this.pauseBtn.setAttribute('aria-label', t('hud.pause'));
    this.pauseBtn.title = t('hud.pause');
    this.kuBtn.setAttribute('aria-label', t('hud.kuAria'));
    this.scoresEl.setAttribute('aria-label', t('hud.scoresAria'));
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

  /** the round countdown next to the round pill (null hides it); urgent = final minute (red, pulsing) */
  setClock(msLeft: number | null, urgent: boolean): void {
    this.clockEl.hidden = msLeft === null;
    const hurry = urgent && msLeft !== null && msLeft > 0;
    this.clockEl.classList.toggle('urgent', urgent);
    this.hurryEl.classList.toggle('on', hurry);
    if (msLeft === null) return void (this.clockShown = '');
    const sec = Math.ceil(msLeft / 1000);
    const txt = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
    if (txt === this.clockShown) return;
    // no "time's up" notice: the clock at 0:00 and the round end say it
    this.clockShown = txt;
    this.clockTxt.textContent = txt;
    this.clockEl.classList.toggle('last10', urgent && sec <= 10);
    // the final minute ticks: a little kick on every second (harder in the last ten)
    if (urgent && sec > 0 && !prefersReducedMotion()) {
      const k = sec <= 10 ? 1.4 : 1.25;
      this.clockEl.animate([{ transform: `scale(${k})` }, { transform: 'scale(1)' }], { duration: 380, easing: 'cubic-bezier(.2,1.5,.4,1)' });
    }
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
          // one compact line in partners mode: "Nosotros 0 · Ellos 0,
          { class: `${r.me ? 'me' : ''}${top > 0 && r.value === top ? ' lead' : ''}${r.team !== undefined ? ` team-${r.team}` : ''}` },
          h('span.hs-name', r.label),
          pts,
        );
      }),
    );
    this.scoresEl.classList.toggle('many', rows.length > 2);
    this.scoresEl.classList.toggle('teams', rows.length === 2 && rows[0].team !== undefined);
  }

  /** the stacked penalty waiting to be drawn (0 hides it) */
  setPending(_n: number): void {
    // the pending-draw chip is no longer shown: the table's +N mark and the voice say it
    this.pendingEl.hidden = true;
  }

  private setPendingOld(n: number): void {
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

  /**
   * The four colours as one rounded diamond (four equal quadrants) springing open over the pile card, once the
   * played wild has landed. Not a modal: no backdrop, the table keeps animating, Esc does nothing; it stays until
   * a colour is tapped or closeAll() runs (pause/exit, or the online turn timer resolving the choice).
   */
  pickColor(colors: readonly Color[] = COLORS): Promise<Color> {
    return new Promise((resolve) => {
      const pane = this.colorPane(colors, (c, quad) => {
        // the tapped quadrant presses in, then the pane closes and play goes on
        quad.classList.add('pressed');
        setTimeout(() => {
          pane.close();
          resolve(c);
        }, prefersReducedMotion() ? 0 : 220);
      });
    });
  }

  /**
   * Another player's colour choice, shown with the same diamond: it opens over the pile (not tappable), the
   * chosen colour presses in, and it closes. Resolves when it has closed.
   */
  showColorChoice(chosen: Color, colors: readonly Color[] = COLORS): Promise<void> {
    const fast = prefersReducedMotion();
    return new Promise((resolve) => {
      const pane = this.colorPane(colors, null);
      setTimeout(() => {
        pane.quads.get(chosen)?.classList.add('pressed');
        setTimeout(() => {
          pane.close();
          resolve();
        }, fast ? 150 : 420);
      }, fast ? 100 : 420);
    });
  }

  /** the colour diamond over the pile; `onPick` null = display only (another player is choosing) */
  private colorPane(colors: readonly Color[], onPick: ((c: Color, quad: HTMLElement) => void) | null): { close(): void; quads: Map<Color, HTMLElement> } {
    let done = false;
    // grid cells of the square before its 45° turn: top-left → top, top-right → right, bottom-right → bottom, bottom-left → left
    const cells = ['q-t', 'q-r', 'q-b', 'q-l'];
    const quads = new Map<Color, HTMLElement>();
    const opts = (colors.length === 4 ? colors : COLORS).map((c, i) => {
      const b = h(
        'button.color-quad',
        { type: 'button', class: cells[i], style: `--c:${COLOR_HEX[c]};--ca:${COLOR_HEX[c]}d4`, 'aria-label': t(`color.${c}` as Key), title: t(`color.${c}` as Key) },
        h('span.color-sym', { html: symbolSvg(c, 40, '#fff6e6') }),
      );
      quads.set(c, b);
      if (onPick) {
        b.addEventListener('click', () => {
          if (done) return;
          done = true;
          onPick(c, b);
        });
      } else {
        b.disabled = true;
        b.tabIndex = -1;
      }
      return b;
    });
    const pane = h(
      'div.color-pane',
      { role: 'group', 'aria-label': t('hud.pickColor'), class: `${prefersReducedMotion() ? 'still' : ''}${onPick ? '' : ' watch'}` },
      onPick ? h('span.color-pane-title', t('hud.pickColor')) : null,
      h('div.color-diamond', ...opts),
    );
    this.el.append(pane);
    const diamond = pane.lastElementChild as HTMLElement;
    // stay over the pile while open (window resize / rotation / table re-layout), always fully on screen
    let px = NaN;
    let py = NaN;
    let raf = 0;
    let closed = false;
    const place = () => {
      const half = (diamond.offsetWidth || 120) * 0.71;
      const p = this.colorAnchor?.() ?? null;
      const W = window.innerWidth;
      const H = window.innerHeight;
      const x = Math.round(Math.min(Math.max(p ? p.x : W / 2, half + 6), W - half - 6));
      const y = Math.round(Math.min(Math.max(p ? p.y : H / 2, half + 46), H - half - 6));
      if (x !== px || y !== py) {
        px = x;
        py = y;
        pane.style.left = `${x}px`;
        pane.style.top = `${y}px`;
      }
      if (!closed) raf = requestAnimationFrame(place);
    };
    place();
    if (onPick) requestAnimationFrame(() => opts[0].focus({ preventScroll: true }));
    const close = this.track(() => {
      if (closed) return;
      closed = true;
      done = true;
      cancelAnimationFrame(raf);
      pane.classList.add('leaving');
      setTimeout(() => pane.remove(), 200);
    });
    return { close, quads };
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
      const accept = o.canAccept === false ? null : opt('accept', t('hud.accept', { n: o.total }), 'ghost', true);
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

  /**
   * a question with buttons in the response bar's place (like the +4 challenge): it can't be dismissed;
   * when its ring runs out it resolves with `onTimeout`
   */
  askChoice<T extends string>(o: { title: string; options: { id: T; label: string; cls?: string }[]; ms: number; onTimeout: T }): Promise<T> {
    return new Promise((resolve) => {
      const ms = Math.max(500, o.ms);
      let done = false;
      let timer = 0;
      const finish = (c: T) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        close();
        resolve(c);
      };
      const ring = svgEl('<svg class="resp-ring" viewBox="0 0 44 44" aria-hidden="true"><circle class="rr-track" cx="22" cy="22" r="19"/><circle class="rr-run" cx="22" cy="22" r="19" pathLength="100"/></svg>');
      const bar = h(
        'div.resp-bar.ask-bar',
        { role: 'alertdialog', 'aria-label': o.title },
        h('div.resp-head', h('span.resp-ring-wrap', ring), h('span.resp-title', o.title)),
        h(
          'div.resp-row',
          ...o.options.map((op) => {
            const b = h('button.btn.resp-opt', { type: 'button', class: op.cls ?? 'secondary' }, h('span.btn-label', op.label));
            b.addEventListener('click', () => finish(op.id));
            return b;
          }),
        ),
      );
      this.respLayer.append(bar);
      const run = ring.querySelector('.rr-run') as SVGCircleElement;
      run.animate([{ strokeDashoffset: '0' }, { strokeDashoffset: '100' }], { duration: ms, easing: 'linear', fill: 'forwards' });
      timer = window.setTimeout(() => finish(o.onTimeout), ms);
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
    this.setRound(0);
    this.setScores([]);
  }
}
