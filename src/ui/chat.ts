/**
 * The in-game chat button (offline and online): a round button beside the player's own plate that
 * opens a pop-up with the player's chosen gestures (up to 5, Ajustes → Juego) above the quick phrases.
 * Offline it plays on the player's own avatar / plate; online the caller sends it to the room.
 */
import type { FaceSpec } from 'kuavatars';
import { CHAT_GESTURES, type ChatGesture, type QuickPhraseId } from '../net/protocol';
import { staticFace } from './avatarAdapter';
import { h } from './dom';
import { t, type Key } from './i18n';
import { buildPhraseGrid, ONLINE_ICONS } from './online';
import type { SeatPlates } from './plates';

export { CHAT_GESTURES, DEFAULT_GESTURES, MAX_GESTURES, sanitizeGestures } from '../net/protocol';
export const gestureLabel = (g: ChatGesture): string => t(`gesture.${g}` as Key);

export interface ChatOpts {
  layer: HTMLElement;
  plates: SeatPlates;
  gestures(): ChatGesture[];
  /** the player's face (the gesture buttons show it making each gesture) */
  face(): FaceSpec | number;
  onGesture(g: ChatGesture): void;
  onPhrase(id: QuickPhraseId): void;
}

export class ChatButton {
  readonly btn: HTMLButtonElement;
  private pop: HTMLElement | null = null;
  private shown = false;

  constructor(private o: ChatOpts) {
    this.btn = h('button.qp-btn.icon-btn', { type: 'button', 'aria-label': t('chat.title'), title: t('chat.title'), 'aria-expanded': 'false', html: ONLINE_ICONS.chat }) as HTMLButtonElement;
    this.btn.addEventListener('click', () => this.toggle());
  }

  get isOpen(): boolean {
    return !!this.pop;
  }

  show(): void {
    if (!this.btn.isConnected) this.o.layer.append(this.btn);
    this.shown = true;
    this.o.plates.onLayout = () => this.place();
    this.place();
  }

  hide(): void {
    this.toggle(false);
    this.shown = false;
    this.btn.classList.remove('on');
    this.btn.remove();
    this.o.plates.onLayout = null;
  }

  /** just beside the own plate */
  private place(): void {
    const b = this.btn;
    const box = this.o.plates.box(0);
    if (!this.shown || !box || !box.visible) {
      b.classList.remove('on');
      return;
    }
    const W = window.innerWidth;
    const size = 46;
    const pw = box.w * box.scale;
    const ph = box.h * box.scale;
    let x = box.x + pw / 2 + 10;
    if (x + size > W - 8) x = box.x - pw / 2 - 10 - size;
    let y = box.y - size / 2;
    if (box.layout === 'stack') {
      // beside the avatar circle, on its right, level with the lower half of the face
      const d = (box.d ?? box.h * 0.7) * box.scale;
      x = box.x + d / 2 + 6;
      // its bottom stays above the name bar (which starts about 0.96 d down the plate)
      y = box.y - ph / 2 + d * 0.96 - size - 4;
      if (x + size > W - 8) x = box.x - d / 2 - 6 - size;
    }
    b.style.transform = `translate(${Math.round(x)}px,${Math.round(Math.max(8, y))}px)`;
    b.classList.add('on');
    if (this.pop) this.placePop();
  }

  toggle(force?: boolean): void {
    const open = force ?? !this.pop;
    if (!open) {
      this.pop?.remove();
      this.pop = null;
      this.btn.setAttribute('aria-expanded', 'false');
      document.removeEventListener('pointerdown', this.onDocDown, true);
      return;
    }
    if (this.pop) return;
    const face = this.o.face();
    const gestures = this.o.gestures();
    const gRow = gestures.length
      ? h(
          'div.qp-gestures',
          { role: 'menu', 'aria-label': t('chat.gestures') },
          ...gestures.map((g) => {
            const label = gestureLabel(g);
            const b = h('button.qp-gesture', { type: 'button', role: 'menuitem', 'aria-label': label, title: label }, h('span.qp-gface', staticFace(face, 'idle', '', g)));
            b.addEventListener('click', () => {
              this.o.onGesture(g);
              this.toggle(false);
            });
            return b;
          }),
        )
      : null;
    const grid = buildPhraseGrid((id) => {
      this.o.onPhrase(id as QuickPhraseId);
      this.toggle(false);
    });
    this.pop = h('div.qp-pop', gRow, grid);
    this.o.layer.append(this.pop);
    this.btn.setAttribute('aria-expanded', 'true');
    this.placePop();
    setTimeout(() => document.addEventListener('pointerdown', this.onDocDown, true), 0);
  }

  private onDocDown = (e: PointerEvent): void => {
    const el = e.target as Node;
    if (this.pop?.contains(el) || this.btn.contains(el)) return;
    this.toggle(false);
  };

  private placePop(): void {
    const pop = this.pop;
    if (!pop) return;
    const r = this.btn.getBoundingClientRect();
    const pw = pop.offsetWidth;
    const ph = pop.offsetHeight;
    const W = window.innerWidth;
    let x = r.left + r.width / 2 - pw / 2;
    x = Math.max(8, Math.min(W - pw - 8, x));
    let y = r.top - ph - 10;
    if (y < 8) y = r.bottom + 10;
    pop.style.transform = `translate(${Math.round(x)}px,${Math.round(y)}px)`;
  }
}
