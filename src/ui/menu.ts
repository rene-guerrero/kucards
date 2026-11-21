import { logoFanSvg } from './cardArt';
import { h } from './dom';
import { t } from './i18n';
import { btn, ICONS } from './overlay';
import { canFullscreen, toggleFullscreen } from '../app/fullscreen';
import { served } from '../net/config';

export interface MenuOpts {
  /** a saved match to continue (null = none) */
  save: { round: number } | null;
  onPlay(): void;
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

function squareBtn(icon: string, label: string, onClick: () => void, cls = ''): HTMLButtonElement {
  const b = h('button.btn.ghost.about-btn', { type: 'button', class: cls, 'aria-label': label, title: label }, h('span.about-btn-icon', { html: icon }));
  b.addEventListener('click', onClick);
  return b;
}

export function buildMenu(o: MenuOpts): HTMLElement {
  const icon = (svg: string) => h('span.btn-icon', { html: svg });
  const actions = h('div.menu-actions');
  if (o.save) {
    actions.append(
      btn(t('menu.continue'), o.onContinue, 'primary xl', h('span.btn-sub', t('menu.continueSub', { n: o.save.round }))),
      btn(t('menu.play'), o.onPlay, 'secondary lg'),
    );
  } else actions.append(btn(t('menu.play'), o.onPlay, 'primary xl', icon(ICONS.play)));
  // Jugar en línea and Jugar con amigos share one row (whichever this build offers)
  const net = [
    o.onOnline ? btn(t('menu.online'), o.onOnline, 'secondary lg menu-online', icon(GLOBE)) : null,
    o.onFriends ? btn(t('menu.friends'), o.onFriends, 'secondary lg menu-online menu-friends', icon(FRIENDS)) : null,
  ].filter((b): b is HTMLButtonElement => !!b);
  if (net.length === 1) actions.append(net[0]);
  else if (net.length) actions.append(h('div.row.menu-row.menu-net', ...net));
  actions.append(
    h(
      'div.row.menu-row',
      squareBtn(ICONS.gear, t('menu.settings'), o.onSettings, 'settings-btn'),
      squareBtn(ICONS.book, t('menu.howto'), o.onHowto),
      squareBtn(ICONS.info, t('menu.about'), o.onAbout),
      // fullscreen (Android browsers; hidden on iPhone and when installed as an app)
      canFullscreen() ? squareBtn(ICONS.fullscreen, t('menu.fullscreen'), () => void toggleFullscreen()) : null,
      apkBtn(),
    ),
  );
  (actions.firstElementChild as HTMLElement).dataset.autofocus = '';
  return h(
    'section.screen.menu',
    h('div.menu-hero', logo(), h('p.tagline', t('app.tagline'))),
    h('div.menu-bottom', actions),
  );
}
