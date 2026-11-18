/**
 * Landscape-only games (Parejas "Codo a codo": the table is turned 45° and only fits sideways).
 * - Android app: the Capacitor ScreenOrientation plugin locks the screen to landscape for the game.
 * - Web: screen.orientation.lock works only in some browsers (installed PWA / fullscreen); everywhere
 *   else the game shows a "turn your phone" screen and stays paused while the phone is upright.
 */
import { h, svgEl } from '../ui/dom';
import { t } from '../ui/i18n';

const native = (): boolean => !!(window as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.();

export async function lockLandscape(): Promise<void> {
  try {
    if (native()) {
      const { ScreenOrientation } = await import('@capacitor/screen-orientation');
      await ScreenOrientation.lock({ orientation: 'landscape' });
      return;
    }
    await (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }).lock?.('landscape');
  } catch {
    /* not supported here: the rotate prompt covers it */
  }
}

export async function unlockOrientation(): Promise<void> {
  try {
    if (native()) {
      const { ScreenOrientation } = await import('@capacitor/screen-orientation');
      await ScreenOrientation.unlock();
      return;
    }
    screen.orientation?.unlock?.();
  } catch {
    /* ignore */
  }
}

const PHONE_SVG =
  '<svg viewBox="0 0 64 64" aria-hidden="true"><rect x="22" y="8" width="20" height="36" rx="4" fill="none" stroke="currentColor" stroke-width="3"/><path d="M14 46a20 20 0 0 0 30 8" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><path d="M44 48v7h-7" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/**
 * Watch the orientation while a landscape-only game runs. `onBlock(true)` when the phone is upright
 * (the prompt is shown), `onBlock(false)` when it is sideways again. Returns a stop function.
 */
export function requireLandscape(host: HTMLElement, onBlock: (blocked: boolean) => void): () => void {
  const mq = matchMedia('(orientation: portrait)');
  const prompt = h('div.rotate-prompt', { role: 'alertdialog', 'aria-live': 'assertive' }, h('span.rotate-icon', svgEl(PHONE_SVG)), h('h2.rotate-title', t('game.rotateTitle')), h('p.rotate-body', t('game.rotateBody')));
  let blocked = false;
  const sync = () => {
    const now = mq.matches;
    if (now === blocked) return;
    blocked = now;
    if (now) host.append(prompt);
    else prompt.remove();
    onBlock(now);
  };
  void lockLandscape();
  sync();
  mq.addEventListener('change', sync);
  return () => {
    mq.removeEventListener('change', sync);
    prompt.remove();
    void unlockOrientation();
  };
}
