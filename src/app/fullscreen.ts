/**
 * Fullscreen in a browser tab. Android browsers let a page go fullscreen from a tap; iPhones (every iOS
 * browser runs on WebKit) only do it for video, so there the button is hidden and adding the game to the
 * home screen is the way (the manifest opens it fullscreen). An installed app / home-screen icon is
 * already fullscreen, so nothing shows there either.
 */

const doc = document as Document & { webkitFullscreenEnabled?: boolean; webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => Promise<void> };
type FsEl = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> };

const native = (): boolean => !!(window as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.();
const standalone = (): boolean => matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches;

/** a fullscreen button makes sense here (supported, and not already an app / home-screen icon) */
export function canFullscreen(): boolean {
  return !native() && !standalone() && !!(doc.fullscreenEnabled || doc.webkitFullscreenEnabled);
}

export function isFullscreen(): boolean {
  return !!(doc.fullscreenElement || doc.webkitFullscreenElement);
}

/** go fullscreen (must run inside a tap); quietly does nothing where it isn't allowed */
export async function enterFullscreen(): Promise<void> {
  if (!canFullscreen() || isFullscreen()) return;
  const el = document.documentElement as FsEl;
  try {
    if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: 'hide' });
    else await el.webkitRequestFullscreen?.();
  } catch {
    /* refused (no gesture, policy): stay as is */
  }
}

export async function toggleFullscreen(): Promise<void> {
  if (!isFullscreen()) return enterFullscreen();
  try {
    if (doc.exitFullscreen) await doc.exitFullscreen();
    else await doc.webkitExitFullscreen?.();
  } catch {
    /* ignore */
  }
}
