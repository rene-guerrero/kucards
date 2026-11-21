/**
 * A game mode, read-only (Ajustes › Reglas, the pause menu, the Sala): who plays, the cards in the deck
 * (only those it really has, with counts) and the rules that are on, as text and thumbnails. No form
 * controls: nothing here looks editable. The sun / moon switch only picks which side of a Día y Noche
 * deck is shown.
 */
import type { CardKind, SettingDescriptor, SettingValue } from '../contracts';
import { COLOURLESS_KINDS, NIGHT_SIDE_DECK, PER_COLOR_KINDS, type DeckSpec, type ModeDef } from '../engine/modes';
import { h } from './dom';
import { loc, t, tMaybe } from './i18n';
import { infoButton } from './settings';
import { cardName, cardThumbSvg, numbersThumb } from './modeEditor';

const DECK_KEYS = new Set(['deck', 'power.swap', 'power.sweep', 'power.shield', 'power.mirror']);
const SUN =
  '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><circle cx="12" cy="12" r="4.5" fill="#ffcb45"/><path d="M12 2.5v2.5M12 19v2.5M4.6 4.6l1.8 1.8M17.6 17.6l1.8 1.8M2.5 12H5M19 12h2.5M4.6 19.4l1.8-1.8M17.6 6.4l1.8-1.8" stroke="#ffcb45" stroke-width="2.2" stroke-linecap="round"/></svg>';
const MOON = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z" fill="#b9a6ff"/></svg>';

const count = (list: DeckSpec['perColor'], kind: CardKind) => list.filter((x) => x.kind === kind).reduce((a, x) => a + x.n, 0);

/** a rule that is "off": a false toggle, or a select whose option reads No / Off */
function isOff(ds: SettingDescriptor, v: SettingValue): boolean {
  if (ds.type === 'toggle') return v !== true;
  const op = (ds.options ?? []).find((o) => o.value === v);
  return v === 'off' || v === false || (!!op && ['no', 'off'].includes(op.label.es.toLowerCase()));
}

const nameLine = (name: string, help: string | null) => h('span.mv-name-line', h('span.mv-name', name), help ? infoButton(name, help) : null);

const item = (thumb: string, name: string, value: string, help: string | null) =>
  h('div.mv-item', h('span.mv-thumb', { 'aria-hidden': 'true', html: thumb }), h('span.mv-text', nameLine(name, help), h('span.mv-value', value)));

const textItem = (name: string, value: string, help: string | null) => h('div.mv-item.mv-rule', h('span.mv-text', nameLine(name, help), h('span.mv-value', value)));

function deckSide(sp: DeckSpec, night: boolean): HTMLElement[] {
  const high = sp.numbers.minValue >= 5;
  const out: HTMLElement[] = [item(numbersThumb(high, night), t('modes.numbers'), `${high ? t('modes.numbersHigh') : t('modes.numbersAll')} · ×${sp.numbers.each}`, null)];
  for (const k of PER_COLOR_KINDS) {
    const n = count(sp.perColor, k);
    if (n > 0) out.push(item(cardThumbSvg(k, false, night), cardName(k, night), `×${n} ${t('modes.perColorShort')}`, tMaybe(`howto.${k}`)));
  }
  for (const k of COLOURLESS_KINDS) {
    const n = count(sp.wild, k);
    if (n > 0) out.push(item(cardThumbSvg(k, true, night), cardName(k, night), `×${n}`, tMaybe(`howto.${k}`)));
  }
  return out;
}

export function modeView(def: ModeDef, descriptors: SettingDescriptor[]): HTMLElement {
  // ── players ──
  const teams = def.teams === 'off' ? t('modes.teamsOff') : def.teams === 'always' ? t('modes.teamsAlways') : t('modes.teamsOptional');
  const players = h(
    'div.mv-grid',
    textItem(t('modes.teams'), teams, null),
    def.teams !== 'off' ? textItem(t('modes.seating'), def.seating === 'side' ? t('modes.side') : t('modes.across'), null) : '',
  );

  // ── deck ──
  const deckGrid = h('div.mv-grid');
  let night = false;
  const renderDeck = () => deckGrid.replaceChildren(...deckSide(night ? (def.night ?? NIGHT_SIDE_DECK) : def.deck, night));
  renderDeck();
  let sideSwitch: HTMLElement | string = '';
  if (def.twoSided) {
    const sun = h('button.mv-side', { type: 'button', 'aria-pressed': 'true', 'aria-label': t('modes.daySide'), html: SUN });
    const moon = h('button.mv-side', { type: 'button', 'aria-pressed': 'false', 'aria-label': t('modes.nightSide'), html: MOON });
    const pick = (n: boolean) => {
      night = n;
      sun.setAttribute('aria-pressed', String(!n));
      moon.setAttribute('aria-pressed', String(n));
      renderDeck();
    };
    sun.addEventListener('click', () => pick(false));
    moon.addEventListener('click', () => pick(true));
    sideSwitch = h('div.mv-sides', h('span.mv-badge', t('modes.twoSided')), h('div.mv-side-pick', sun, moon));
  }

  // ── rules that are on ──
  const rules = descriptors
    .filter((ds) => !DECK_KEYS.has(ds.key))
    .map((ds) => ({ ds, v: (def.rules[ds.key] ?? ds.default) as SettingValue }))
    .filter(({ ds, v }) => !isOff(ds, v))
    .map(({ ds, v }) => {
      const op = (ds.options ?? []).find((o) => o.value === v);
      return textItem(loc(ds.label), ds.type === 'toggle' ? t('modes.on') : op ? loc(op.label) : String(v), ds.help ? loc(ds.help) : null);
    });

  return h(
    'div.mode-view',
    h('section.card.mv-card', h('h3.me-h', t('modes.secPlayers')), players),
    h('section.card.mv-card', h('h3.me-h', t('modes.secDeck')), sideSwitch, deckGrid),
    h('section.card.mv-card', h('h3.me-h', t('modes.secRules')), h('div.mv-grid', ...rules)),
  );
}

/** the read-only view in a sheet (pause menu, Sala): title, the view, a close button */
export function rulesSheet(def: ModeDef, title: string, descriptors: SettingDescriptor[], onClose: () => void): HTMLElement {
  const close = h('button.btn.primary.mv-close', { type: 'button' }, t('modes.close'));
  close.addEventListener('click', onClose);
  return h('div.card.sheet.mv-sheet', h('h2.card-title', title), h('div.mv-scroll', modeView(def, descriptors)), close);
}
