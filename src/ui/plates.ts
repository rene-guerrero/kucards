/**
 * HTML name plates (one per seat), laid out by the 3D view (TableViewOptions.onPlates) so they hug each
 * seat's hand. Each plate shows the avatar (or a letter when avatars are off), the name, the card count
 * badge, an active glow on the seat to move and a team badge in partners mode. Speech bubbles grow from
 * the plate toward the table centre. Ported from Kudominoes; updates only write what actually changed.
 */
import type { ChallengeStep, Color, GameEvent, Seat, SeatPlate } from '../contracts';
import { ChallengeFx } from './challengeFx';
import type { AvatarController } from './avatarAdapter';
import { h, prefersReducedMotion, svgEl } from './dom';
import { t, type Key } from './i18n';

const SEATS: Seat[] = [0, 1, 2, 3, 4, 5];

interface PlateEl {
  root: HTMLElement;
  name: HTMLElement;
  letter: HTMLElement;
  team: HTMLElement;
  num: Text;
  last: { tf: string; w: number; h: number; d: number; layout: string; visible: boolean; active: boolean; winner: boolean; count: number; team: number };
}

export class SeatPlates {
  readonly el: HTMLElement;
  private p: PlateEl[];
  private boxes: (SeatPlate | null)[] = SEATS.map(() => null);
  private bubbles: HTMLElement[] = [];
  /** online: the turn-timer ring of each plate (built on first use) */
  private rings: (SVGSVGElement | null)[] = SEATS.map(() => null);
  private ringSeat: Seat | null = null;
  private ringAnim: Animation | null = null;
  private warnTimer: ReturnType<typeof setTimeout> | null = null;

  /** called after every layout update (the chat button follows the own plate) */
  onLayout: (() => void) | null = null;

  constructor(private avatars: AvatarController) {
    this.el = h('div.plates', { 'aria-hidden': 'true' });
    this.p = SEATS.map((s) => {
      const letter = h('span.plate-letter');
      const team = h('span.plate-team');
      const av = h('div.plate-av', letter, avatars.faceEl(s), team);
      const name = h('span.plate-name');
      const num = document.createTextNode('0');
      const count = h('span.plate-count', h('i.plate-card'), num);
      const root = h('div.plate', { class: `seat-${s}` }, h('div.plate-info', name, count), av);
      // a catchable avatar is tapped to catch a missed ¡Ku!
      root.addEventListener('pointerdown', (e) => {
        if (this.catchSeat !== s || !this.catchFn) return;
        e.preventDefault();
        e.stopPropagation();
        const fn = this.catchFn;
        this.setCatchable(null);
        this.hurt(s);
        fn();
      });
      this.el.append(root);
      return { root, name, letter, team, num, last: { tf: '', w: 0, h: 0, d: 0, layout: '', visible: false, active: false, winner: false, count: -1, team: -1 } };
    });
  }

  private catchSeat: Seat | null = null;
  private catchFn: (() => void) | null = null;

  /**
   * A player who forgot to call ¡Ku!: their avatar swells inside a pulsing ring and becomes a big tap
   * target; tapping it catches them. `null` ends the window.
   */
  setCatchable(seat: Seat | null, onCatch?: () => void): void {
    if (this.catchSeat !== null && this.catchSeat !== seat) this.p[this.catchSeat]?.root.classList.remove('catchable');
    this.catchSeat = seat;
    this.catchFn = seat !== null ? onCatch ?? null : null;
    if (seat !== null) this.p[seat]?.root.classList.add('catchable');
  }

  private chalFx: ChallengeFx | null = null;

  /** the +4 challenge sequence over the plates (the renderer times the steps, see ChallengeFx) */
  challenge(step: ChallengeStep): void {
    this.chalFx ??= new ChallengeFx({
      layer: this.el,
      avBox: (s) => {
        const p = this.p[s];
        return p && p.last.visible ? (p.root.querySelector('.plate-av') as HTMLElement | null)?.getBoundingClientRect() ?? null : null;
      },
      name: (s) => this.p[s]?.name.textContent ?? '',
      hurt: (s) => this.hurt(s),
      react: (s, e, sec) => this.avatars.react(s, e, sec),
      gesture: (s, g, delay) => this.avatars.gesture(s, g, delay),
    });
    this.chalFx.handle(step);
  }

  /** a quick hurt shake of a seat's avatar (caught missing ¡Ku!) */
  hurt(seat: Seat): void {
    const av = this.p[seat]?.root.querySelector('.plate-av') as HTMLElement | null;
    if (!av || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    av.animate(
      [
        { transform: 'translateX(0) rotate(0)' },
        { transform: 'translateX(-6px) rotate(-8deg)' },
        { transform: 'translateX(6px) rotate(7deg)' },
        { transform: 'translateX(-4px) rotate(-5deg)' },
        { transform: 'translateX(3px) rotate(3deg)' },
        { transform: 'translateX(0) rotate(0)' },
      ],
      { duration: 520, easing: 'ease-out' },
    );
  }

  /**
   * a mark (the skip sign) landing on a seat: drawn over the avatar so it never hides behind the plate.
   * The 3D mark flies in; this takes over where it lands with a pop and a fade.
   */
  mark(seat: Seat, img: string, tint: string): void {
    const av = this.p[seat]?.root.querySelector('.plate-av') as HTMLElement | null;
    if (!av) return;
    const el = document.createElement('div');
    el.className = 'plate-mark';
    el.style.backgroundImage = `url(${img})`;
    el.style.setProperty('--tint', tint);
    av.appendChild(el);
    el.animate(
      [
        { transform: 'scale(.7)', opacity: 1 },
        { transform: 'scale(1.18)', opacity: 1, offset: 0.25 },
        { transform: 'scale(1)', opacity: 1, offset: 0.55 },
        { transform: 'scale(1)', opacity: 0 },
      ],
      { duration: 620, easing: 'ease-out' },
    ).onfinish = () => el.remove();
  }

  private ranks: (number | null)[] = SEATS.map(() => null);
  private rankEls: (HTMLElement | null)[] = SEATS.map(() => null);

  /**
   * Final minute: a round badge on the avatar with the seat's position (1 = fewest card points).
   * It pops in with a short glow, bumps when the number changes and fades out on null.
   */
  setRank(seat: Seat, n: number | null): void {
    const p = this.p[seat];
    if (!p || this.ranks[seat] === n) return;
    const prev = this.ranks[seat];
    this.ranks[seat] = n;
    let el = this.rankEls[seat];
    if (!el) {
      if (n === null) return;
      el = h('span.plate-rank');
      this.rankEls[seat] = el;
      (p.root.querySelector('.plate-av') as HTMLElement).append(el);
    }
    el.classList.toggle('on', n !== null);
    if (n === null) return;
    el.textContent = String(n);
    el.dataset.rank = String(n);
    if (prefersReducedMotion()) return;
    const frames: Keyframe[] =
      prev === null
        ? [
            { transform: 'scale(0)', filter: 'brightness(2.2) drop-shadow(0 0 10px #ffe17a)' },
            { transform: 'scale(1.35)', filter: 'brightness(1.6) drop-shadow(0 0 8px #ffe17a)', offset: 0.55 },
            { transform: 'scale(1)', filter: 'brightness(1) drop-shadow(0 0 0 transparent)' },
          ]
        : [
            { transform: 'scale(1)' },
            { transform: 'scale(1.3)', filter: 'brightness(1.7)', offset: 0.4 },
            { transform: 'scale(1)' },
          ];
    el.animate(frames, { duration: prev === null ? 520 : 340, easing: 'cubic-bezier(0.3, 1.6, 0.5, 1)' });
  }

  /** every final-minute badge off */
  clearRanks(): void {
    for (const s of SEATS) this.setRank(s, null);
  }

  setNames(names: readonly string[]): void {
    this.p.forEach((p, s) => {
      const n = names[s] ?? '';
      p.name.textContent = n;
      p.letter.textContent = n.slice(0, 1).toUpperCase();
      p.root.classList.toggle('long-name', n.length > 7);
    });
  }

  setAvatars(on: boolean): void {
    this.el.classList.toggle('no-avatars', !on);
    this.avatars.setEnabled(on);
  }

  /**
   * Online: the turn timer as a thin ring round the avatar of the seat to move, emptying until the
   * deadline (`endsAt` in local Date.now() ms; null seat = none). One WAAPI animation, no per-frame JS.
   * `warnAt` ms before the end the ring turns warm and `onWarn` runs once.
   */
  setTimer(seat: Seat | null, endsAt = 0, total = 30_000, warnAt = 0, onWarn?: () => void): void {
    if (this.warnTimer) clearTimeout(this.warnTimer);
    this.warnTimer = null;
    this.ringAnim?.cancel();
    this.ringAnim = null;
    if (this.ringSeat !== null) this.rings[this.ringSeat]?.classList.remove('on', 'warn');
    this.ringSeat = seat;
    if (seat === null || !this.p[seat]) return;
    let ring = this.rings[seat];
    if (!ring) {
      ring = svgEl('<svg class="plate-timer" viewBox="0 0 100 100" aria-hidden="true"><circle class="pt-track" cx="50" cy="50" r="47"/><circle class="pt-run" cx="50" cy="50" r="47" pathLength="100"/></svg>');
      this.rings[seat] = ring;
      (this.p[seat].root.querySelector('.plate-av') as HTMLElement).append(ring);
    }
    const left = Math.max(0, endsAt - Date.now());
    const elapsed = Math.max(0, total - left);
    ring.classList.add('on');
    const run = ring.querySelector('.pt-run') as SVGCircleElement;
    const anim = run.animate([{ strokeDashoffset: '0' }, { strokeDashoffset: '100' }], { duration: Math.max(1, total), fill: 'forwards', easing: 'linear' });
    anim.currentTime = Math.min(total, elapsed);
    this.ringAnim = anim;
    if (warnAt > 0) {
      const r = ring;
      const warn = () => {
        this.warnTimer = null;
        if (this.ringSeat !== seat) return;
        r.classList.add('warn');
        onWarn?.();
      };
      if (left <= warnAt) {
        if (left > 0) warn();
      } else this.warnTimer = setTimeout(warn, left - warnAt);
    }
  }

  /** one short pulse on a plate (the human's turn, a ¡Ku!) */
  pulse(seat: Seat): void {
    const av = this.p[seat].root.querySelector('.plate-av') as HTMLElement;
    if (prefersReducedMotion()) return;
    av.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.16)', offset: 0.35 }, { transform: 'scale(0.98)', offset: 0.7 }, { transform: 'scale(1)' }], { duration: 560, easing: 'ease-out' });
  }

  hide(): void {
    for (const p of this.p) {
      p.root.classList.remove('on');
      p.last.visible = false;
    }
    this.avatars.setVisible(false);
  }

  update(plates: readonly SeatPlate[]): void {
    let anyVisible = false;
    const seen = new Set<Seat>();
    for (const b of plates) {
      seen.add(b.seat);
      const p = this.p[b.seat];
      if (!p) continue;
      const L = p.last;
      if (b.w !== L.w || b.h !== L.h || b.d !== L.d || b.layout !== L.layout) {
        L.w = b.w;
        L.h = b.h;
        L.d = b.d;
        L.layout = b.layout;
        const st = p.root.style;
        st.width = `${b.w}px`;
        st.height = `${b.h}px`;
        st.setProperty('--d', `${b.d}px`);
        p.root.classList.toggle('stack', b.layout === 'stack');
        p.root.classList.toggle('row', b.layout === 'row');
      }
      const tf = `translate(${(b.x - b.w / 2).toFixed(1)}px,${(b.y - b.h / 2).toFixed(1)}px)${b.scale !== 1 ? ` scale(${b.scale.toFixed(3)})` : ''}`;
      if (tf !== L.tf) p.root.style.transform = L.tf = tf;
      if (b.visible !== L.visible) p.root.classList.toggle('on', (L.visible = b.visible));
      if (b.active !== L.active) p.root.classList.toggle('active', (L.active = b.active));
      if (b.winner !== L.winner) p.root.classList.toggle('winner', (L.winner = b.winner));
      if (b.count !== L.count) {
        const grew = L.count >= 0 && b.count > L.count;
        L.count = b.count;
        p.num.data = String(b.count);
        p.root.classList.toggle('one-card', b.count === 1);
        if (grew && !prefersReducedMotion()) (p.num.parentElement as HTMLElement).animate([{ transform: 'scale(1.5)' }, { transform: 'scale(1)' }], { duration: 360, easing: 'cubic-bezier(.2,1.6,.4,1)' });
      }
      const team = b.team ?? -1;
      if (team !== L.team) {
        L.team = team;
        p.root.classList.toggle('team-0', team === 0);
        p.root.classList.toggle('team-1', team === 1);
        // no A / B letter: the team colour on the plate's border says it
      }
      anyVisible ||= b.visible;
      this.boxes[b.seat] = { ...b, bubble: b.bubble ? { ...b.bubble } : undefined };
    }
    // seats the renderer no longer reports are hidden
    for (const s of SEATS)
      if (!seen.has(s) && this.p[s].last.visible) {
        this.p[s].last.visible = false;
        this.p[s].root.classList.remove('on');
      }
    this.avatars.setVisible(anyVisible);
    this.onLayout?.();
    // face centres for the avatars' glances (the table centre = the middle of the visible plates)
    const vis = SEATS.map((s) => this.boxes[s]).filter((b): b is SeatPlate => !!b && b.visible);
    if (vis.length) {
      const c = { x: vis.reduce((t, b) => t + b.x, 0) / vis.length, y: vis.reduce((t, b) => t + b.y, 0) / vis.length };
      this.avatars.setPositions(SEATS.map((s) => (this.boxes[s] ? { x: this.boxes[s]!.x, y: this.boxes[s]!.y } : c)), c);
    }
  }

  box(seat: Seat): SeatPlate | null {
    return this.boxes[seat];
  }

  /** a speech bubble on a seat's plate, growing toward the table centre; clamped inside the view */
  say(seat: Seat, text: string, strong = false, ms = 1500): void {
    const box = this.boxes[seat];
    if (!box || !box.visible) return;
    let b = this.bubbles[seat];
    if (!b) {
      b = h('div.plate-bubble', { role: 'status', 'aria-live': 'polite' });
      this.bubbles[seat] = b;
      this.el.append(b);
    }
    const anchor = box.bubble;
    const dir = anchor?.dir ?? (seat === 0 ? 'up' : box.y < (this.el.clientHeight || innerHeight) * 0.3 ? 'down' : box.x < (this.el.clientWidth || innerWidth) / 2 ? 'right' : 'left');
    b.className = `plate-bubble dir-${dir}${strong ? ' strong' : ''}`;
    b.textContent = text;
    b.style.transform = 'none';
    b.getAnimations().forEach((a) => a.cancel());
    const bw = b.offsetWidth;
    const bh = b.offsetHeight;
    const pw = box.w * box.scale;
    const ph = box.h * box.scale;
    const gap = 8;
    let x: number;
    let y: number;
    if (anchor) {
      x = dir === 'left' ? anchor.x - bw : dir === 'right' ? anchor.x : anchor.x - bw / 2;
      y = dir === 'up' ? anchor.y - bh : dir === 'down' ? anchor.y : anchor.y - bh / 2;
    } else if (dir === 'right') {
      x = box.x + pw / 2 + gap;
      y = box.y - bh / 2;
    } else if (dir === 'left') {
      x = box.x - pw / 2 - gap - bw;
      y = box.y - bh / 2;
    } else if (dir === 'down') {
      x = box.x - bw / 2;
      y = box.y + ph / 2 + gap;
    } else {
      x = box.x + pw / 2 - bw * 0.35;
      y = box.y - ph / 2 - gap - bh;
    }
    const W = this.el.clientWidth || innerWidth;
    const H = this.el.clientHeight || innerHeight;
    x = Math.max(6, Math.min(W - bw - 6, x));
    y = Math.max(6, Math.min(H - bh - 6, y));
    // never over the HUD top bar
    const o = this.el.getBoundingClientRect();
    for (const hud of document.querySelectorAll<HTMLElement>('.hud-top > *')) {
      const r = hud.getBoundingClientRect();
      if (!r.width) continue;
      const l = r.left - o.left;
      const tp = r.top - o.top;
      if (x < l + r.width && x + bw > l && y < tp + r.height && y + bh > tp) y = Math.min(H - bh - 6, tp + r.height + 4);
    }
    const base = `translate(${x.toFixed(1)}px,${y.toFixed(1)}px)`;
    b.style.transform = base;
    b.style.transformOrigin = dir === 'right' ? '0% 50%' : dir === 'left' ? '100% 50%' : dir === 'down' ? '50% 0%' : '30% 100%';
    b.animate(
      prefersReducedMotion()
        ? [{ opacity: 0 }, { opacity: 1, offset: 0.1 }, { opacity: 1, offset: 0.85 }, { opacity: 0 }]
        : [
            { opacity: 0, transform: `${base} scale(.3)` },
            { opacity: 1, transform: `${base} scale(1.08)`, offset: 0.1 },
            { opacity: 1, transform: `${base} scale(1)`, offset: 0.16 },
            { opacity: 1, transform: `${base} scale(1)`, offset: 0.85 },
            { opacity: 0, transform: `${base} scale(.92)` },
          ],
      { duration: ms, easing: 'ease-out', fill: 'forwards' },
    );
  }

  clearBubbles(): void {
    for (const b of this.bubbles) b?.getAnimations().forEach((a) => a.cancel());
  }
}

/** One speech bubble a GameEvent calls for (null = none). The controller passes it to `say`. */
export function bubbleFor(ev: GameEvent): { seat: Seat; text: string; strong: boolean } | null {
  // the user asked for no event tooltips during play (chat phrases still show): see bubbleText
  return EVENT_BUBBLES ? bubbleText(ev) : null;
}

/** speech bubbles for game events over the avatars (off: the table's animations and voices say it) */
export const EVENT_BUBBLES = false;

function bubbleText(ev: GameEvent): { seat: Seat; text: string; strong: boolean } | null {
  const say = (seat: Seat, key: Key, strong = false, params?: Record<string, string>) => ({ seat, text: t(key, params), strong });
  switch (ev.type) {
    case 'play': {
      const k = ev.card.face.kind;
      if (k === 'draw2') return say(ev.seat, 'say.draw2', true);
      if (k === 'wild4') return say(ev.seat, 'say.wild4', true);
      if (k === 'skip') return say(ev.seat, 'say.skip');
      if (k === 'reverse') return say(ev.seat, 'say.reverse');
      if (k === 'swap') return say(ev.seat, 'say.swap');
      if (k === 'sweep' || k === 'sweepWild') return say(ev.seat, 'say.sweep');
      if (k === 'wheelWild') return say(ev.seat, 'say.wheel');
      if ((k === 'wild' || k === 'wildFlip') && ev.color) return say(ev.seat, 'say.color', false, { color: t(`color.${ev.color as Color}` as Key) });
      if (ev.card.face.draw && ev.card.face.draw > 4) return say(ev.seat, 'say.drawN', true, { n: String(ev.card.face.draw) });
      return null;
    }
    case 'ku':
      return say(ev.seat, 'game.ku', true);
    case 'kuCaught':
      return say(ev.by, 'say.caught', true);
    case 'challenge':
      return say(ev.by, 'say.challenge', true);
    case 'shield':
      return say(ev.seat, 'say.shield', true);
    case 'mirror':
      return say(ev.from, 'say.mirror', true);
    case 'draw':
      return ev.reason === 'penalty' && ev.count >= 4 ? say(ev.seat, 'say.ouch') : null;
    case 'eliminated':
      return say(ev.seat, 'say.out');
    case 'roundEnd':
      return say(ev.winner, 'say.win', true);
    default:
      return null;
  }
}
