/**
 * The +4 challenge on the plates layer, in three beats the renderer times (ChallengeStep):
 *   call    a lightning arrow from the challenger's avatar to the wild's player, a magnifier that rides it
 *           and stays on the accused, and the "¡Desafío!" lettering (the ¡Ku! look);
 *   reveal  the accused hand fanned face up by their seat; the cards that could have been played instead
 *           (the proof) rise and pulse gold, the rest dim; no proof = a clean fan;
 *   verdict a rubber stamp slams on the loser's avatar ("¡Pillado!" red / "¡Falló!" violet), the loser
 *           winces and shakes, the winner cheers.
 * Plain DOM + WAAPI: transforms and opacity only, no filters, a couple of dozen nodes at most. Reduced
 * motion keeps every beat as a short fade.
 */
import './challengeFx.css';
import type { Card, ChallengeStep, Seat } from '../contracts';
import { sortHand } from '../render/layout';
import type { AvatarExpr } from './avatarAdapter';
import { cardSvg } from './cardArt';
import { h, prefersReducedMotion, svgEl } from './dom';
import { t } from './i18n';

export interface ChallengeHost {
  /** the plates layer (absolute, fills the table) */
  layer: HTMLElement;
  /** a seat's avatar box in viewport px, null when that plate is hidden */
  avBox(seat: Seat): DOMRect | null;
  name(seat: Seat): string;
  hurt(seat: Seat): void;
  react(seat: Seat, e: AvatarExpr, sec: number): void;
  gesture(seat: Seat, g: 'thumbsUp' | 'facepalm', delay?: number): void;
}

const MAG = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><circle cx="10" cy="10" r="6.2"/><path d="M15 15l6 6"/></svg>';

interface Pt {
  x: number;
  y: number;
  r: number;
}

export class ChallengeFx {
  private live: HTMLElement[] = [];
  private mag: HTMLElement | null = null;
  private timers: ReturnType<typeof setTimeout>[] = [];

  constructor(private host: ChallengeHost) {}

  handle(s: ChallengeStep): void {
    if (s.step === 'call') this.call(s.by, s.target, s.ms);
    else if (s.step === 'reveal') this.reveal(s.target, s.hand, s.proof, s.ms);
    else this.verdict(s.loser, s.winner, s.caught, s.ms);
  }

  /** drop whatever is still on screen (a new challenge, a reset) */
  clear(): void {
    this.timers.forEach(clearTimeout);
    this.timers = [];
    this.live.forEach((el) => el.remove());
    this.live = [];
    this.mag = null;
  }

  private add<T extends HTMLElement | SVGElement>(el: T): T {
    this.host.layer.append(el);
    this.live.push(el as unknown as HTMLElement);
    return el;
  }
  private drop(el: Element | null): void {
    if (!el) return;
    el.remove();
    this.live = this.live.filter((x) => x !== (el as unknown as HTMLElement));
  }
  private later(ms: number, f: () => void): void {
    this.timers.push(setTimeout(f, ms));
  }
  /** remove el when its animation ends (and by the clock too: a page in the background finishes no animation) */
  private gone(a: Animation, el: Element, ms: number): void {
    a.onfinish = () => this.drop(el);
    this.later(ms + 400, () => this.drop(el));
  }

  /** an avatar's centre and radius in layer px */
  private at(seat: Seat): Pt | null {
    const b = this.host.avBox(seat);
    if (!b || !b.width) return null;
    const l = this.host.layer.getBoundingClientRect();
    return { x: b.left + b.width / 2 - l.left, y: b.top + b.height / 2 - l.top, r: Math.max(b.width, b.height) / 2 };
  }

  // ───────────────────────── 1: the call ─────────────────────────

  private call(by: Seat, target: Seat, ms: number): void {
    this.clear();
    const red = prefersReducedMotion();
    const a = this.at(by);
    const b = this.at(target);
    if (a && b) {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len;
      const uy = dy / len;
      // from the rim of one avatar to just short of the other
      const x0 = a.x + ux * a.r;
      const y0 = a.y + uy * a.r;
      const x1 = b.x - ux * (b.r + 14);
      const y1 = b.y - uy * (b.r + 14);
      const span = Math.max(1, Math.hypot(x1 - x0, y1 - y0));
      const n = Math.max(4, Math.min(11, Math.round(span / 34)));
      const pts: string[] = [];
      for (let i = 0; i <= n; i++) {
        const k = i / n;
        const off = i === 0 || i === n ? 0 : (i % 2 ? 1 : -1) * (7 + ((i * 37) % 7));
        pts.push(`${(x0 + (x1 - x0) * k - uy * off).toFixed(1)},${(y0 + (y1 - y0) * k + ux * off).toFixed(1)}`);
      }
      const ang = (Math.atan2(uy, ux) * 180) / Math.PI;
      const svg = this.add(
        svgEl(
          `<svg class="chal-beam" width="100%" height="100%"><polyline class="chal-bolt-glow" pathLength="1" points="${pts.join(' ')}"/><polyline class="chal-bolt" pathLength="1" points="${pts.join(' ')}"/>` +
            `<g transform="translate(${(x1 + ux * 10).toFixed(1)} ${(y1 + uy * 10).toFixed(1)}) rotate(${ang.toFixed(1)})"><path class="chal-head" d="M4 0L-14 -11L-9 0L-14 11Z"/></g></svg>`,
        ),
      );
      const draw = ms * 0.3;
      const bolts = svg.querySelectorAll('polyline');
      const head = svg.querySelector('.chal-head') as SVGElement;
      if (red) {
        svg.animate([{ opacity: 0 }, { opacity: 1, offset: 0.2 }, { opacity: 1, offset: 0.75 }, { opacity: 0 }], { duration: ms, fill: 'forwards' });
      } else {
        bolts.forEach((p) => p.animate([{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { duration: draw, easing: 'ease-in', fill: 'both' }));
        head.animate([{ opacity: 0, transform: 'scale(.2)' }, { opacity: 1, transform: 'scale(1.5)', offset: 0.6 }, { opacity: 1, transform: 'scale(1)' }], { duration: 200, delay: draw * 0.85, easing: 'ease-out', fill: 'both' });
        // the bolt crackles, then lets go
        svg.animate([{ opacity: 1 }, { opacity: 0.55, offset: 0.42 }, { opacity: 1, offset: 0.5 }, { opacity: 0.6, offset: 0.6 }, { opacity: 1, offset: 0.68 }, { opacity: 1, offset: 0.8 }, { opacity: 0 }], { duration: ms, fill: 'forwards' });
      }
      this.later(ms + 30, () => this.drop(svg));

      // the magnifier rides the bolt and stays on the accused until the verdict
      const mag = this.add(h('div.chal-mag', { html: MAG }));
      const mx = b.x - ux * (b.r * 0.2) + b.r * 0.72;
      const my = b.y - b.r * 0.72;
      this.mag = mag;
      if (red) {
        mag.style.transform = `translate(${mx}px, ${my}px)`;
        mag.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160 });
      } else {
        mag.animate(
          [
            { transform: `translate(${x0}px, ${y0}px) scale(.3) rotate(-40deg)`, opacity: 0 },
            { transform: `translate(${x0 + (x1 - x0) * 0.2}px, ${y0 + (y1 - y0) * 0.2}px) scale(1.25) rotate(-12deg)`, opacity: 1, offset: 0.25 },
            { transform: `translate(${x1}px, ${y1}px) scale(1.1) rotate(8deg)`, opacity: 1, offset: 0.75 },
            { transform: `translate(${mx}px, ${my}px) scale(1) rotate(0deg)`, opacity: 1 },
          ],
          { duration: ms * 0.7, easing: 'cubic-bezier(.3,.1,.2,1)', fill: 'forwards' },
        ).onfinish = () => {
          if (this.mag !== mag) return;
          // looking the hand over
          (mag.firstElementChild as SVGElement).animate([{ transform: 'rotate(-14deg) scale(1)' }, { transform: 'rotate(12deg) scale(1.12)' }], { duration: 320, direction: 'alternate', iterations: 8, easing: 'ease-in-out' });
        };
      }
    }
    // the lettering, like ¡KU!
    const who = this.host.name(by);
    const whom = this.host.name(target);
    const pop = h('div.ku-pop.chal-pop', h('span.ku-pop-word.chal-word', t('chal.call')), who && whom ? h('span.ku-pop-name', `${who} → ${whom}`) : null);
    const hostEl = this.add(h('div.chal-pop-host', pop));
    const dur = ms + 260;
    pop.animate(
      red
        ? [{ opacity: 0 }, { opacity: 1, offset: 0.15 }, { opacity: 1, offset: 0.8 }, { opacity: 0 }]
        : [
            { opacity: 0, transform: 'scale(.2) rotate(-12deg)' },
            { opacity: 1, transform: 'scale(1.16) rotate(3deg)', offset: 0.2 },
            { opacity: 1, transform: 'scale(1) rotate(-3deg)', offset: 0.32 },
            { opacity: 1, transform: 'scale(1.02) rotate(-3deg)', offset: 0.78 },
            { opacity: 0, transform: 'scale(1.25) rotate(-3deg)' },
          ],
      { duration: dur, easing: 'ease-out', fill: 'forwards' },
    );
    this.later(dur + 30, () => this.drop(hostEl));
  }

  // ───────────────────────── 2: the hand, face up ─────────────────────────

  private reveal(target: Seat, hand: Card[], proof: number[], ms: number): void {
    const p = this.at(target);
    const n = hand.length;
    if (!p || !n) return;
    const red = prefersReducedMotion();
    const l = this.host.layer.getBoundingClientRect();
    const W = l.width;
    const H = l.height;
    const cards = sortHand(hand);
    const hit = new Set(proof);
    const w = Math.round(Math.max(34, Math.min(56, Math.min(W, H) * 0.095)));
    const ch = Math.round(w * 1.5);
    const maxSpan = Math.min(W - 28, 380);
    const step = n > 1 ? Math.min(w * 0.6, (maxSpan - w) / (n - 1)) : 0;
    const span = w + step * (n - 1);
    const rot = n > 1 ? Math.min(7, 40 / (n - 1)) : 0;
    // by the seat, on the side of the table centre, kept on screen
    let vx = W / 2 - p.x;
    let vy = H / 2 - p.y;
    const vl = Math.hypot(vx, vy) || 1;
    vx /= vl;
    vy /= vl;
    const reach = p.r + 12;
    let cx = p.x + vx * (reach + span * 0.5 * Math.abs(vx));
    let cy = p.y + vy * (reach + (ch * 0.5 + 14) * Math.abs(vy));
    cx = Math.max(14 + span / 2, Math.min(W - 14 - span / 2, cx));
    cy = Math.max(64 + ch / 2 + 16, Math.min(H - 20 - ch / 2, cy));
    const fan = this.add(h('div.chal-fan', { class: hit.size ? 'has-proof' : 'clean' }));
    fan.style.transform = `translate(${cx.toFixed(1)}px, ${cy.toFixed(1)}px)`;
    const mid = (n - 1) / 2;
    const lag = Math.min(26, 300 / n);
    cards.forEach((c, i) => {
      const is = hit.has(c.id);
      const el = h('div.chal-card', { class: is ? 'proof' : '', html: cardSvg(c.face, { width: w }) });
      el.style.width = `${w}px`;
      el.style.height = `${ch}px`;
      el.style.left = `${-w / 2}px`;
      el.style.top = `${-ch / 2}px`;
      const k = i - mid;
      const x = k * step;
      const y = Math.abs(k) * Math.abs(k) * rot * 0.14 - (is ? 12 : 0);
      const end = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) rotate(${(k * rot).toFixed(1)}deg)`;
      fan.append(el);
      if (red) {
        el.style.transform = end;
        return;
      }
      el.animate(
        [
          { transform: `translate(0px, ${(vy * -18).toFixed(1)}px) rotate(0deg) scale(.3)`, opacity: 0 },
          { transform: `${end} scale(1.08)`, opacity: 1, offset: 0.7 },
          { transform: `${end} scale(1)`, opacity: 1 },
        ],
        { duration: 260, delay: i * lag, easing: 'cubic-bezier(.2,.9,.3,1.2)', fill: 'both' },
      );
      // the proof: a gold pulse
      if (is) el.animate([{ transform: `${end} scale(1)` }, { transform: `${end} translateY(-7px) scale(1.16)` }], { duration: 230, delay: i * lag + 280, direction: 'alternate', iterations: 6, easing: 'ease-in-out', fill: 'forwards' });
    });
    if (red) fan.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160 });
    this.later(ms, () => {
      const a = fan.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 220, fill: 'forwards' });
      // the fan drops back towards the seat as it goes
      if (!red) fan.animate([{ transform: fan.style.transform }, { transform: `translate(${(cx - vx * 16).toFixed(1)}px, ${(cy - vy * 16).toFixed(1)}px) scale(.8)` }], { duration: 220, easing: 'ease-in', fill: 'forwards' });
      this.gone(a, fan, 220);
    });
  }

  // ───────────────────────── 3: the verdict ─────────────────────────

  private verdict(loser: Seat, winner: Seat, caught: boolean, ms: number): void {
    const red = prefersReducedMotion();
    const mag = this.mag;
    this.mag = null;
    if (mag) {
      const tf = getComputedStyle(mag).transform;
      this.gone(mag.animate([{ transform: tf, opacity: 1 }, { transform: `${tf === 'none' ? '' : tf} scale(.2)`, opacity: 0 }], { duration: 160, fill: 'forwards' }), mag, 160);
    }
    const host = this.host;
    host.react(loser, 'hurt', 2);
    host.gesture(loser, 'facepalm', 0.25);
    host.react(winner, 'happy', 2);
    host.gesture(winner, 'thumbsUp', 0.1);
    host.hurt(loser);
    const lp = this.at(loser);
    const wp = this.at(winner);
    const l = this.host.layer.getBoundingClientRect();
    if (wp) {
      // the winner: a gold ring opens round the avatar
      const ring = this.add(h('div.chal-ring.win'));
      ring.style.width = ring.style.height = `${wp.r * 2}px`;
      ring.style.left = `${wp.x - wp.r}px`;
      ring.style.top = `${wp.y - wp.r}px`;
      this.gone(ring.animate(red ? [{ opacity: 0.9 }, { opacity: 0 }] : [{ opacity: 0.95, transform: 'scale(.9)' }, { opacity: 0, transform: 'scale(1.9)' }], { duration: 620, easing: 'ease-out', fill: 'forwards' }), ring, 620);
    }
    if (!lp) return;
    const ring = this.add(h('div.chal-ring.lose'));
    ring.style.width = ring.style.height = `${lp.r * 2}px`;
    ring.style.left = `${lp.x - lp.r}px`;
    ring.style.top = `${lp.y - lp.r}px`;
    const ra = ring.animate(red ? [{ opacity: 0.9 }, { opacity: 0 }] : [{ opacity: 0, transform: 'scale(2.4)' }, { opacity: 1, transform: 'scale(1)', offset: 0.3 }, { opacity: 0, transform: 'scale(1.6)' }], { duration: 560, easing: 'ease-out', fill: 'forwards' });
    this.gone(ra, ring, 560);

    const stamp = this.add(h('div.chal-stamp', { class: caught ? 'caught' : 'missed' }, h('span', t(caught ? 'chal.caught' : 'chal.missed'))));
    // centred on the loser's avatar, never off the screen
    const sw = stamp.offsetWidth;
    const sh = stamp.offsetHeight;
    const x = Math.max(8 + sw / 2, Math.min(l.width - 8 - sw / 2, lp.x)) - sw / 2;
    const y = Math.max(60 + sh / 2, Math.min(l.height - 8 - sh / 2, lp.y)) - sh / 2;
    const at = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    const sa = stamp.animate(
      red
        ? [{ transform: `${at} rotate(-9deg)`, opacity: 0 }, { transform: `${at} rotate(-9deg)`, opacity: 1, offset: 0.15 }, { transform: `${at} rotate(-9deg)`, opacity: 1, offset: 0.8 }, { transform: `${at} rotate(-9deg)`, opacity: 0 }]
        : [
            { transform: `${at} rotate(-26deg) scale(3)`, opacity: 0 },
            { transform: `${at} rotate(-9deg) scale(.9)`, opacity: 1, offset: 0.14 },
            { transform: `${at} rotate(-9deg) scale(1.08)`, opacity: 1, offset: 0.21 },
            { transform: `${at} rotate(-9deg) scale(1)`, opacity: 1, offset: 0.28 },
            { transform: `${at} rotate(-9deg) scale(1)`, opacity: 1, offset: 0.82 },
            { transform: `${at} rotate(-9deg) scale(1.12)`, opacity: 0 },
          ],
      { duration: ms, easing: 'ease-out', fill: 'forwards' },
    );
    this.gone(sa, stamp, ms);
  }
}
