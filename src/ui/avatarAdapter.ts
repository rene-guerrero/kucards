/**
 * The one place KuCards touches avatar faces. Plates, the new-game screen, the HUD pickers and the
 * summaries call only this module; the faces themselves come from the shared KuAvatars library
 * (`kuavatars`, pinned in package.json), so face improvements reach both games. Card-game specifics
 * (which GameEvent means which mood) live here. New moods, events or sizes are asked of KuAvatars,
 * never patched locally.
 *
 * Sizing: library faces fill their container, so every face is returned inside a `.face-static` box
 * that fills the caller's box.
 */
import {
  AvatarController as KuController,
  liveFace as kuLiveFace,
  sanitizeFace,
  staticFace as kuStaticFace,
  type FaceSpec,
  type Gesture,
  type Mood,
} from 'kuavatars';
import type { GameEvent, Seat } from '../contracts';
import { h } from './dom';

/** Moods KuCards uses (all in KuAvatars since v0.2.0). */
export type AvatarExpr = 'idle' | 'perk' | 'happy' | 'sad' | 'angry' | 'amazed' | 'thinking' | 'smug' | 'meh' | 'shout' | 'hurt' | 'cry';

export const mood = (e: AvatarExpr): Mood => e;

/** the player's face: a FaceSpec from the editor, or an old HUMAN_FACES index */
export const humanFace = (f: number | FaceSpec): FaceSpec => sanitizeFace(f);

const box = (el: Element): HTMLElement => h('span.face-static.av-fill', el as unknown as HTMLElement);

/** A still face (grids, summaries, pickers). `_initial` is kept for the old placeholder call sites. */
export function staticFace(spec: FaceSpec | number, expr: AvatarExpr = 'idle', _initial = '', gesture?: Gesture): HTMLElement {
  return box(kuStaticFace(spec, mood(expr), gesture ? { gesture } : {}));
}

/** A face that blinks and glances, whose expression can change (new-game seats). */
export function liveFace(spec: FaceSpec | number, expr: AvatarExpr = 'idle', _initial = ''): { el: HTMLElement; setExpr(e: AvatarExpr): void } {
  const lf = kuLiveFace(spec, mood(expr));
  return { el: box(lf.el), setExpr: (e) => lf.setExpr(mood(e)) };
}

const isAction = (ev: Extract<GameEvent, { type: 'play' }>) => ev.card.face.kind !== 'number';

/** Per-seat faces for the table plates; maps KuCards GameEvents to the library's game-agnostic hooks. */
export class AvatarController {
  private readonly ku = new KuController({ seats: 6 });
  /** seats in play, for round/match results */
  private seats: Seat[] = [0, 1, 2, 3];

  faceEl(seat: Seat): HTMLElement {
    return this.ku.faceEl(seat);
  }
  setSeats(seats: Seat[]): void {
    this.seats = seats.slice();
  }
  setSeatFace(seat: Seat, spec: FaceSpec, _name = ''): void {
    this.ku.setFace(seat, spec);
  }
  setHumanFace(f: number | FaceSpec, _name = ''): void {
    this.ku.setFace(0, humanFace(f));
  }
  /** hands pop in next to a seat's head and play a gesture */
  gesture(seat: Seat, g: Gesture, delay = 0): void {
    this.ku.gesture(seat, g, { delay });
  }
  /** face centres + table centre in CSS px (for glances); call on every plate layout */
  setPositions(...args: Parameters<KuController['setPositions']>): void {
    this.ku.setPositions(...args);
  }
  setEnabled(on: boolean): void {
    this.ku.setEnabled(on);
  }
  setVisible(v: boolean): void {
    this.ku.setVisible(v);
  }
  setPaused(p: boolean): void {
    this.ku.setPaused(p);
  }
  setReducedMotion(r: boolean): void {
    this.ku.setReducedMotion(r);
  }
  setQuality(q: 'low' | 'medium' | 'high'): void {
    this.ku.setQuality(q);
  }

  /** a mood on a seat for a while, then back to idle */
  react(seat: Seat, e: AvatarExpr, sec = 1.6): void {
    this.ku.react(seat, mood(e), sec);
  }

  onTurn(seat: Seat | null): void {
    this.ku.onTurn(seat);
    if (seat === 0) this.ku.perk(0);
  }

  onEvent(ev: GameEvent): void {
    const ku = this.ku;
    switch (ev.type) {
      case 'deal':
        ku.onRoundStart();
        break;
      case 'turn':
        this.onTurn(ev.seat);
        break;
      case 'play': {
        const strong = isAction(ev);
        ku.onPlay(ev.seat, strong);
        ku.onImpact(ev.seat, strong ? 'slam' : 'clack');
        break;
      }
      case 'draw':
        if (ev.reason === 'penalty' || ev.reason === 'catch') {
          this.react(ev.seat, 'hurt', 1.6);
          if (ev.count >= 6) this.gesture(ev.seat, 'facepalm', 0.3);
        }
        else ku.onPass(ev.seat);
        break;
      case 'skip':
        this.react(ev.seat, 'meh', 1.4);
        break;
      case 'ku':
        this.react(ev.seat, 'shout', 1.2);
        break;
      case 'kuCaught':
        // caught: the forgetful player winces (the plate shakes, see SeatPlates.hurt); the catcher cheers
        this.react(ev.target, 'hurt', 1.8);
        // KuAvatars' hurt face plus its facepalm hands
        this.gesture(ev.target, 'facepalm', 0.1);
        this.gesture(ev.by, 'thumbsUp');
        break;
      case 'challenge':
        // the call: the challenger accuses, the accused is startled. The verdict faces (the loser's wince,
        // the winner's cheer) come with the stamp, from the table's challenge sequence (SeatPlates.challenge)
        this.react(ev.by, 'angry', 1.3);
        this.react(ev.target, 'amazed', 1.3);
        break;
      case 'shield':
        this.react(ev.seat, 'smug', 1.4);
        break;
      case 'mirror':
        this.gesture(ev.from, 'rub');
        this.react(ev.to, 'amazed', 1.6);
        break;
      case 'swapHands':
        this.react(ev.a, 'amazed', 1.4);
        this.react(ev.b, 'amazed', 1.4);
        break;
      case 'eliminated':
        this.react(ev.seat, 'cry', 3);
        break;
      case 'roundEnd':
        ku.onRoundEnd(this.result((s) => (s === ev.winner ? 'happy' : 'sad'), 'meh'));
        break;
      case 'matchEnd':
        ku.onMatchEnd(this.result((s) => s === ev.winner, false));
        break;
      default:
        break;
    }
  }

  reset(): void {
    this.ku.reset();
  }

  /** a per-seat array over all 6 seats (seats not in play get the neutral value) */
  private result<T>(f: (s: Seat) => T, neutral: T): T[] {
    return ([0, 1, 2, 3, 4, 5] as Seat[]).map((s) => (this.seats.includes(s) ? f(s) : neutral));
  }
}
