import { logoFanSvg } from './cardArt';
import { h } from './dom';
import { t } from './i18n';
import { btn, ICONS } from './overlay';
import { served } from '../net/config';

export interface MenuOpts {
  /** a saved match to continue (null = none) */
  save: { round: number } | null;
  /** quick start with the last setup */
  onPlay(): void;
  /** the full setup screen (the line under Jugar) */
  onSetup(): void;
  /** the last setup, e.g. "Clásico · 4 jugadores · 2 vs 2" */
  setupLine: string;
  /** the player's chip: face + name; tapping it opens their profile */
  profile: { face: HTMLElement; name: string; onOpen(): void };
  onContinue(): void;
  onSettings(): void;
  onHowto(): void;
  onAbout(): void;
  /** "Jugar en línea": hidden until the room server exists (phase 8) */
  onOnline?: () => void;
  /** "Jugar con amigos" (same Wi-Fi or Bluetooth, no internet) */
  onFriends?: () => void;
}

/** The brand mark: a small fan of three cards over the word KuCards. */
export function logo(): HTMLElement {
  return h('div.logo', h('div.logo-cards', { html: logoFanSvg(132) }), h('h1.logo-word', h('span.ku', 'Ku'), h('span', 'Cards')));
}

const DOWNLOAD_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v10.5M7.5 10.5 12 15l4.5-4.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 17.5V19a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19v-1.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';

/** Android APK download: only on the published web build, never inside the installed app (dev: ?apk=1) */
function apkBtn(): HTMLElement | null {
  const native = !!(window as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.();
  const devPreview = import.meta.env.DEV && new URLSearchParams(location.search).has('apk');
  if (native || served() || !(import.meta.env.PROD || devPreview)) return null;
  const label = t('menu.apk');
  return h('a.btn.ghost.about-btn.apk-btn', { href: './kucards.apk', download: 'kucards.apk', 'aria-label': label, title: label }, h('span.about-btn-icon', { html: DOWNLOAD_SVG }));
}

const GLOBE =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.6" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M3.6 12h16.8M12 3.4c2.4 2.4 3.6 5.3 3.6 8.6s-1.2 6.2-3.6 8.6c-2.4-2.4-3.6-5.3-3.6-8.6s1.2-6.2 3.6-8.6z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';

/** two people side by side (Jugar con amigos) */
const FRIENDS =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="8.6" cy="8.4" r="3.3" fill="none" stroke="currentColor" stroke-width="2.1"/><path d="M2.6 19.4c.5-3.4 2.9-5.4 6-5.4s5.5 2 6 5.4" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"/><circle cx="16.4" cy="7.6" r="2.7" fill="none" stroke="currentColor" stroke-width="2"/><path d="M16.4 12.9c2.7 0 4.6 1.8 5 4.8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

/** sliders: change the game setup */
const ADJUST =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h9M17 7h3M4 17h3M11 17h9" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round"/><circle cx="15" cy="7" r="2.3" fill="none" stroke="currentColor" stroke-width="2.2"/><circle cx="9" cy="17" r="2.3" fill="none" stroke="currentColor" stroke-width="2.2"/></svg>';

function squareBtn(icon: string, label: string, onClick: () => void, cls = ''): HTMLButtonElement {
  const b = h('button.btn.ghost.about-btn', { type: 'button', class: cls, 'aria-label': label, title: label }, h('span.about-btn-icon', { html: icon }));
  b.addEventListener('click', onClick);
  return b;
}

const withSub = (b: HTMLElement, sub: string) => (b.append(h('span.btn-sub', sub)), b);

/** Multijugador: a bottom sheet with the ways this build can play with others */
function multiSheet(host: HTMLElement, o: MenuOpts, icon: (svg: string) => HTMLElement): void {
  const close = () => {
    wrap.remove();
    window.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' && e.key !== 'GoBack' && e.key !== 'BrowserBack') return;
    e.stopImmediatePropagation();
    e.preventDefault();
    close();
  };
  const go = (f?: () => void) => () => {
    close();
    f?.();
  };
  const sheet = h(
    'div.menu-sheet',
    { role: 'dialog', 'aria-label': t('menu.multi') },
    h('h2.menu-sheet-title', t('menu.multi')),
    o.onOnline ? withSub(btn(t('menu.viaInternet'), go(o.onOnline), 'primary lg menu-sheet-opt', icon(GLOBE)), t('menu.viaInternetSub')) : null,
    o.onFriends ? withSub(btn(t('menu.viaLocal'), go(o.onFriends), 'secondary lg menu-sheet-opt', icon(FRIENDS)), t('menu.viaLocalSub')) : null,
    btn(t('modes.close'), close, 'ghost menu-sheet-close'),
  );
  const wrap = h('div.menu-sheet-wrap', sheet);
  wrap.addEventListener('click', (e) => e.target === wrap && close());
  window.addEventListener('keydown', onKey, true);
  host.append(wrap);
  (sheet.querySelector('.btn') as HTMLElement | null)?.focus();
}

export function buildMenu(o: MenuOpts): HTMLElement {
  const icon = (svg: string) => h('span.btn-icon', { html: svg });
  const actions = h('div.menu-actions');
  const hasNet = !!(o.onOnline || o.onFriends);
  let el: HTMLElement;
  const multi = hasNet ? btn(t('menu.multi'), () => multiSheet(el, o, icon), 'secondary lg menu-multi', icon(FRIENDS)) : null;
  // the split play button: start with the last setup | change the setup
  const split = (label: string, kind: 'primary' | 'secondary') => {
    const go = h('button.menu-split-go', { type: 'button' }, h('span.menu-split-label', icon(ICONS.play), h('span', label)), h('span.btn-sub.menu-split-sub', o.setupLine));
    go.addEventListener('click', o.onPlay);
    const cfg = h('button.menu-split-cfg', { type: 'button', 'aria-label': t('menu.setup'), title: t('menu.setup'), html: ADJUST });
    cfg.addEventListener('click', o.onSetup);
    // the wrapper is a shared .btn (fill, rim, 3D lip, press); its two halves are transparent hit areas
    return h(`div.menu-split.btn.${kind}`, go, cfg);
  };
  if (o.save) actions.append(btn(t('menu.continue'), o.onContinue, 'primary xl', h('span.btn-sub', t('menu.continueSub', { n: o.save.round }))), split(t('menu.newGame'), 'secondary'));
  else actions.append(split(t('menu.play'), 'primary'));
  if (multi) actions.append(multi);
  ((actions.querySelector('.menu-split-go, button.btn') as HTMLElement | null) ?? actions).dataset.autofocus = '';
  const chip = h('button.menu-profile', { type: 'button', 'aria-label': t('settings.name') }, h('span.menu-profile-face', o.profile.face), h('span.menu-profile-name', o.profile.name));
  chip.addEventListener('click', o.profile.onOpen);
  const top = h(
    'div.menu-top',
    chip,
    h('div.menu-top-icons', apkBtn(), squareBtn(ICONS.book, t('menu.howto'), o.onHowto), squareBtn(ICONS.gear, t('menu.settings'), o.onSettings, 'settings-btn')),
  );
  el = h('section.screen.menu', top, h('div.menu-hero', logo(), h('p.tagline', t('app.tagline'))), h('div.menu-bottom', actions));
  return el;
}
