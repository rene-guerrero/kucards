/**
 * "Buscar modos": search the online catalog by name or open a share code, and save a mode to your own.
 */
import type { CatalogItem } from '../modes/catalog';
import type { ModeDef } from '../engine/modes';
import { CatalogNetError, openOnline, searchOnline } from '../net/catalogClient';
import { h } from './dom';
import { loc, t } from './i18n';
import { btn } from './overlay';
import { screenHeader } from './howto';
import { modeIconSvg } from './modeIcons';
import { RULE_PRESETS } from '../engine/rules';
import { normalizeCatalogCode } from '../modes/catalog';

const SEARCH = '<svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="2.6"/><path d="M15.5 15.5 20.5 20.5" stroke="currentColor" stroke-width="2.8" stroke-linecap="round"/></svg>';

export interface ModeCatalogOpts {
  /** save a fetched mode to the player's modes (a free name if taken) */
  onSave(def: ModeDef): void;
  onBack(): void;
}

const failText = (e: unknown): string =>
  e instanceof CatalogNetError
    ? e.reason === 'unavailable'
      ? t('modes.unavailable')
      : e.reason === 'offline'
        ? t('modes.offline')
        : e.reason === 'not_found'
          ? t('modes.notFound')
          : t('modes.error')
    : t('modes.error');

const baseName = (id: string) => {
  const p = RULE_PRESETS.find((x) => x.id === id);
  return p ? loc(p.label) : '';
};

export function buildModeCatalog(o: ModeCatalogOpts): HTMLElement {
  const q = h('input.text-input.mc-q', { type: 'search', placeholder: t('modes.searchPh'), 'aria-label': t('modes.searchPh'), autocomplete: 'off', enterkeyhint: 'search' }) as HTMLInputElement;
  const msg = h('p.mc-msg', { role: 'status', 'aria-live': 'polite' });
  const list = h('div.mc-list');
  const say = (text: string) => (msg.textContent = text);

  const get = async (c: string) => {
    try {
      const { mode } = await openOnline(c);
      o.onSave(mode);
      say(t('modes.copied'));
    } catch (e) {
      say(failText(e));
    }
  };

  const row = (it: CatalogItem) => {
    const save = btn(t('modes.get'), () => void get(it.code), 'secondary mc-get');
    return h(
      'div.mc-item',
      h('span.mc-ico', { html: modeIconSvg(it.icon) }),
      h(
        'span.mc-text',
        h('span.mc-name', it.name),
        h('span.mc-meta', [baseName(it.base), it.author ? t('modes.by', { name: it.author }) : '', t('modes.downloads', { n: it.downloads }), it.code].filter(Boolean).join(' · ')),
      ),
      save,
    );
  };

  let seq = 0;
  const search = async () => {
    const my = ++seq;
    say('');
    try {
      const items = await searchOnline(q.value);
      if (my !== seq) return;
      list.replaceChildren(...items.map(row));
      if (!items.length) say(t('modes.none'));
    } catch (e) {
      if (my !== seq) return;
      list.replaceChildren();
      say(failText(e));
    }
  };
  let timer = 0;
  q.addEventListener('input', () => {
    clearTimeout(timer);
    timer = window.setTimeout(() => void search(), 300);
  });
  // one field: a share code opens that mode, anything else searches by name
  const go = () => (normalizeCatalogCode(q.value) ? void get(q.value) : void search());
  q.addEventListener('keydown', (e) => e.key === 'Enter' && go());
  const openBtn = btn(t('modes.open'), go, 'primary mc-open');

  const el = h(
    'section.screen.panel-screen.mode-catalog',
    screenHeader(t('modes.browse'), o.onBack),
    h('div.scroll.me-scroll', h('div.me-body', h('div.mc-code-row', h('label.mc-search', h('span.mc-search-ico', { 'aria-hidden': 'true', html: SEARCH }), q), openBtn), msg, list)),
  );
  void search();
  return el;
}
