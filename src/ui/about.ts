/**
 * "Acerca de": app name and logo fan, version, tagline and the author link.
 * Links open outside the app (target=_blank on the web; the Capacitor bridge hands other hosts to the
 * system browser).
 */
import { logoFanSvg } from './cardArt';
import { h } from './dom';
import { t } from './i18n';
import { btn } from './overlay';

export const AUTHOR_URL = 'https://rene-guerrero.github.io/cv/';
export const AUTHOR_NAME = 'rene-guerrero';

const extLink = (href: string, label: string) => h('a.about-link', { href, target: '_blank', rel: 'noopener noreferrer' }, label);

export function buildAbout(onClose: () => void): HTMLElement {
  const [before, after = ''] = t('about.madeBy').split('{author}');
  const close = btn(t('common.close'), onClose, 'ghost');
  close.dataset.autofocus = '';
  return h(
    'div.card.about',
    { 'aria-label': t('about.title') },
    h(
      'div.about-head',
      h('div.about-tile', { html: logoFanSvg(72) }),
      h('h2.about-name', h('span.ku', 'Ku'), 'Cards'),
      h('p.about-version', t('about.version', { v: __APP_VERSION__ })),
    ),
    h('p.about-tagline', t('about.tagline')),
    h('p.about-made', before, extLink(AUTHOR_URL, AUTHOR_NAME), after),
    h('div.about-actions', close),
  );
}
