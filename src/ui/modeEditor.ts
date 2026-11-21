/**
 * The game-mode editor: create a mode from a template or edit a player-made one. Sections: name + icon,
 * players and teams, deck and powers, rules. Saving needs a free, non-empty name.
 */
import type { CardKind, SettingDescriptor, SettingValue } from '../contracts';
import { buildDeckFromSpec, PENALTY_DRAW } from '../engine/cards';
import { cardSvg } from './cardArt';
import { isPenaltyKind } from '../engine/cards';
import { COLOURLESS_KINDS, DAY_SIDE_DECK, NIGHT_SIDE_DECK, PER_COLOR_KINDS, TWO_SIDED_KINDS, type DeckEntry, type DeckSpec, type ModeDef } from '../engine/modes';
import { h } from './dom';
import { loc, t, tMaybe, type Key } from './i18n';
import { btn, segmented, toggle } from './overlay';
import { screenHeader } from './howto';
import { infoButton, ruleSelect } from './settings';
import { MODE_ICON_IDS, modeIconSvg } from './modeIcons';

const SUN_SVG = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><circle cx="12" cy="12" r="4.5" fill="#ffcb45"/><path d="M12 2.5v2.5M12 19v2.5M4.6 4.6l1.8 1.8M17.6 17.6l1.8 1.8M2.5 12H5M19 12h2.5M4.6 19.4l1.8-1.8M17.6 6.4l1.8-1.8" stroke="#ffcb45" stroke-width="2.2" stroke-linecap="round"/></svg>';
const MOON_SVG = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z" fill="#b9a6ff"/></svg>';

/** at least this many cards (4 players × 7 dealt, plus a draw pile) */
export const MIN_DECK = 56;
/** rules the deck section already covers */
const DECK_KEYS = new Set(['deck', 'power.swap', 'power.sweep', 'power.shield', 'power.mirror']);

export interface ModeEditorOpts {
  draft: ModeDef;
  isNew: boolean;
  descriptors: SettingDescriptor[];
  /** is this name free (ignoring the mode itself)? */
  nameFree(name: string): boolean;
  onSave(def: ModeDef): void;
  onDelete?(): void;
  onBack(): void;
  /** read-only (Ajustes › Reglas): the same sections, controls locked, no name / footer */
  readOnly?: boolean;
}

const countOf = (list: DeckEntry[], kind: CardKind) => list.filter((x) => x.kind === kind).reduce((a, x) => a + x.n, 0);
const setCount = (list: DeckEntry[], kind: CardKind, n: number): DeckEntry[] => {
  const rest = list.filter((x) => x.kind !== kind);
  return n > 0 ? [...rest, { kind, n }] : rest;
};

function stepper(value: number, max: number, onChange: (v: number) => void, label: string): HTMLElement {
  const v = h('span.stp-v', String(value));
  const set = (n: number) => {
    value = Math.max(0, Math.min(max, n));
    v.textContent = String(value);
    onChange(value);
  };
  const minus = h('button.stp-b', { type: 'button', 'aria-label': `${label} −` }, '−');
  const plus = h('button.stp-b.stp-plus', { type: 'button', 'aria-label': `${label} +` }, '+');
  minus.addEventListener('click', () => set(value - 1));
  plus.addEventListener('click', () => set(value + 1));
  return h('div.stp', { role: 'group', 'aria-label': label }, minus, v, plus);
}

const row = (label: string, ctl: Node, help?: string) =>
  h('div.me-row', h('span.me-label-line', h('span.me-label', label), help ? infoButton(label, help) : null), h('div.me-ctl', ctl));
/** a power card's field: its thumbnail, name and ⓘ (the how-to text) over the count control */
/** a card's name on its side (the night +5 and Comodín +6 are draw6 / wild4 kinds) */
export function cardName(kind: CardKind, night: boolean): string {
  if (night && kind === 'draw6') return t('card.draw5');
  if (night && kind === 'wild4') return t('card.wild6');
  return t(`card.${kind}` as Key);
}

/** a thumbnail of the number cards: 0 and 9, or 0, 5 and 9, fanned in an arc, each its own colour */
export function numbersThumb(high: boolean, night: boolean): string {
  const cols = night ? (['rosa', 'naranja', 'celeste'] as const) : (['coral', 'sol', 'mar'] as const);
  const vals = high ? [0, 5, 9] : [0, 9];
  const n = vals.length;
  const cards = vals
    .map((v, i) => {
      const a = (i - (n - 1) / 2) * (n === 3 ? 14 : 16);
      const x = 40 + (i - (n - 1) / 2) * (n === 3 ? 14 : 12);
      const svg = cardSvg({ kind: 'number', color: high ? cols[i] : cols[i === 0 ? 0 : 2], value: v } as Parameters<typeof cardSvg>[0], { width: 40 });
      return `<g transform="translate(${x} 52) rotate(${a}) translate(-20 -30)">${svg.replace(/^<svg[^>]*>/, '<svg width="40" height="60" viewBox="0 0 60 90">')}</g>`;
    })
    .join('');
  // wide enough for three fanned cards (their rotated corners stay inside)
  return `<svg viewBox="0 4 80 90" aria-hidden="true">${cards}</svg>`;
}

/** a card kind's thumbnail SVG on its side (day blue / night purple; colourless night faces flagged) */
export function cardThumbSvg(kind: CardKind, colourless: boolean, night: boolean, width = 60): string {
  const draw = night && kind === 'draw6' ? 5 : night && kind === 'wild4' ? 6 : PENALTY_DRAW[kind];
  const face = { kind, color: colourless ? null : night ? 'morado' : 'mar', ...(draw ? { draw } : {}), ...(night && colourless ? { night: true } : {}) } as Parameters<typeof cardSvg>[0];
  return cardSvg(face, { width });
}

function cardField(kind: CardKind, colourless: boolean, ctl: Node, night = false): HTMLElement {
  const name = cardName(kind, night);
  const draw = night && kind === 'draw6' ? 5 : night && kind === 'wild4' ? 6 : PENALTY_DRAW[kind];
  const face = { kind, color: colourless ? null : night ? 'morado' : 'mar', ...(draw ? { draw } : {}), ...(night && colourless ? { night: true } : {}) } as Parameters<typeof cardSvg>[0];
  const help = tMaybe(`howto.${kind}`);
  // the card in its own column, as tall as the label + the counter beside it
  return h(
    'div.me-card-field',
    h('span.me-card-thumb', { 'aria-hidden': 'true', html: cardSvg(face, { width: 60 }) }),
    h('div.field.me-field', h('span.me-field-head', h('span.field-label', { title: name }, name), help ? infoButton(name, help) : null), ctl),
  );
}

/** a stacked field: one-line label over a full-width control (for the two-column grids) */
const field = (label: string, ctl: Node, help?: string) =>
  h('div.field.me-field', h('span.me-field-head', h('span.field-label', { title: label }, label), help ? infoButton(label, help) : null), ctl);

export function buildModeEditor(o: ModeEditorOpts): HTMLElement {
  let d: ModeDef = JSON.parse(JSON.stringify(o.draft)) as ModeDef;
  const body = h('div.me-body');
  const saveBtn = btn(t('modes.save'), () => {
    if (!valid()) return;
    o.onSave({ ...d, name: d.name.trim() });
  }, 'primary');
  const err = h('p.me-err', { role: 'alert' });
  const deckInfo = h('p.me-deck-info');

  const valid = (): boolean => {
    const name = d.name.trim();
    const msg = !name ? t('modes.nameEmpty') : !o.nameFree(name) ? t('modes.nameTaken') : '';
    err.textContent = msg;
    saveBtn.disabled = !!msg;
    return !msg;
  };

  const deckStats = (spec: DeckSpec) => {
    const cards = buildDeckFromSpec(spec);
    const numbers = cards.filter((c) => c.face.kind === 'number').length;
    const penalties = cards.filter((c) => isPenaltyKind(c.face.kind)).length;
    // the one-sided builder leaves the Eclipses out; a two-sided deck deals them
    const eclipses = d.twoSided ? countOf(spec.perColor, 'flip') * 4 + countOf(spec.wild, 'wildFlip') : 0;
    return { total: cards.length + eclipses, numbers, penalties };
  };
  const renderDeckInfo = () => {
    // two-sided: the day side's count (the night side is paired card for card)
    const st = deckStats(d.deck);
    const warns = [st.total < MIN_DECK ? t('modes.warnSmall', { n: MIN_DECK }) : '', st.penalties * 2 > st.numbers ? t('modes.warnHeavy') : ''].filter(Boolean);
    deckInfo.replaceChildren(h('b', t('modes.deckSize', { n: st.total })), ...warns.map((w) => h('span.me-warn', ` · ${w}`)));
  };

  const render = () => {
    // ── name + icon ──
    const name = h('input.text-input.me-name', { type: 'text', maxlength: 24, value: d.name, placeholder: t('modes.namePh'), 'aria-label': t('modes.name'), autocomplete: 'off' }) as HTMLInputElement;
    name.addEventListener('input', () => {
      d.name = name.value;
      valid();
    });
    const icons = h(
      'div.me-icons',
      { role: 'radiogroup', 'aria-label': t('modes.icon') },
      ...MODE_ICON_IDS.map((id) => {
        const b = h('button.me-icon', { type: 'button', role: 'radio', 'aria-checked': String(id === d.icon), 'aria-label': id, html: modeIconSvg(id) });
        b.addEventListener('click', () => {
          d.icon = id;
          icons.querySelectorAll('.me-icon').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
        });
        return b;
      }),
    );

    // ── players and teams ──
    const seat = segmented<string>(
      [
        { value: 'across', label: t('modes.across') },
        { value: 'side', label: t('modes.side') },
      ],
      d.seating,
      (v) => {
        d.seating = v as ModeDef['seating'];
      },
      t('modes.seating'),
    );
    const seatRow = field(t('modes.seating'), seat);
    const teams = segmented<string>(
      [
        { value: 'off', label: t('modes.teamsOff') },
        { value: 'optional', label: t('modes.teamsOptional') },
        { value: 'always', label: t('modes.teamsAlways') },
      ],
      d.teams,
      (v) => {
        d.teams = v as ModeDef['teams'];
        if (d.teams === 'off') d.seating = 'across';
        seatRow.hidden = d.teams === 'off';
      },
      t('modes.teams'),
    );
    seatRow.hidden = d.teams === 'off';

    // ── deck: one side (one-sided deck, or the Día / Noche side of a two-sided one) ──
    const deckBox = h('div.me-deck');
    const sideControls = (get: () => DeckSpec, set: (sp: DeckSpec) => void, night: boolean): HTMLElement[] => {
      const sp = get();
      const numsThumb = h('span.me-card-thumb.me-nums-thumb', { 'aria-hidden': 'true', html: numbersThumb(sp.numbers.minValue >= 5, night) });
      const nums = segmented<number>(
        [
          { value: 1, label: t('modes.numbersAll') },
          { value: 5, label: t('modes.numbersHigh') },
        ],
        sp.numbers.minValue >= 5 ? 5 : 1,
        (v) => {
          set({ ...get(), numbers: { ...get().numbers, minValue: v } });
          numsThumb.innerHTML = numbersThumb(v >= 5, night);
          renderDeckInfo();
        },
        t('modes.numbers'),
      );
      const copies = stepper(sp.numbers.each, 4, (v) => (set({ ...get(), numbers: { ...get().numbers, each: v } }), renderDeckInfo()), t('modes.copies'));
      const kindRow = (kind: CardKind, colourless: boolean) =>
        cardField(
          kind,
          colourless,
          stepper(countOf(colourless ? get().wild : get().perColor, kind), colourless ? 12 : 6, (v) => {
            const cur = get();
            set(colourless ? { ...cur, wild: setCount(cur.wild, kind, v) } : { ...cur, perColor: setCount(cur.perColor, kind, v) });
            renderDeckInfo();
          }, cardName(kind, night)),
          night,
        );
      const two = d.twoSided;
      const per = PER_COLOR_KINDS.filter((k) => two || !TWO_SIDED_KINDS.includes(k));
      const wild = COLOURLESS_KINDS.filter((k) => two || !TWO_SIDED_KINDS.includes(k));
      // two equal columns, label over control (the stacked-field pattern)
      return [
        h('div.me-grid', h('div.me-card-field', numsThumb, field(t('modes.numbers'), nums)), field(t('modes.copies'), copies)),
        h('h4.me-sub', t('modes.perColor')),
        h('div.me-grid', ...per.map((k) => kindRow(k, false))),
        h('h4.me-sub', t('modes.wild')),
        h('div.me-grid', ...wild.map((k) => kindRow(k, true))),
      ];
    };
    // which side's cards are shown (the sun / moon switch beside the Día y Noche toggle)
    let showNight = false;
    const sideSeg = segmented<string>(
      [
        { value: 'day', label: '' },
        { value: 'night', label: '' },
      ],
      'day',
      (v) => {
        showNight = v === 'night';
        renderDeck();
      },
      t('modes.twoSided'),
    );
    sideSeg.classList.add('me-daynight');
    const [sunBtn, moonBtn] = Array.from(sideSeg.querySelectorAll<HTMLButtonElement>('.seg-opt'));
    sunBtn.innerHTML = SUN_SVG;
    sunBtn.setAttribute('aria-label', t('modes.daySide'));
    moonBtn.innerHTML = MOON_SVG;
    moonBtn.setAttribute('aria-label', t('modes.nightSide'));
    const renderDeck = () => {
      const night = d.twoSided && showNight;
      sideSeg.classList.toggle('is-disabled', !d.twoSided);
      for (const b of [sunBtn, moonBtn]) b.disabled = !d.twoSided;
      deckBox.replaceChildren(
        ...(night ? sideControls(() => d.night ?? NIGHT_SIDE_DECK, (sp) => (d.night = sp), true) : sideControls(() => d.deck, (sp) => (d.deck = sp), false)),
      );
      renderDeckInfo();
    };
    const twoSided = toggle(d.twoSided, (v) => {
      d.twoSided = v;
      // turning the two-sided deck on starts both sides from Día y Noche's lists (they need Eclipses)
      if (v) {
        if (!d.deck.perColor.some((x) => x.kind === 'flip')) d.deck = JSON.parse(JSON.stringify(DAY_SIDE_DECK)) as DeckSpec;
        if (!d.night) d.night = JSON.parse(JSON.stringify(NIGHT_SIDE_DECK)) as DeckSpec;
      } else if (showNight) {
        // back to the day side shown
        showNight = false;
        sunBtn.setAttribute('aria-checked', 'true');
        moonBtn.setAttribute('aria-checked', 'false');
      }
      renderDeck();
    }, t('modes.twoSided'));
    renderDeck();

    // ── rules ──
    const ruleRows = o.descriptors
      .filter((ds) => !DECK_KEYS.has(ds.key))
      .map((ds) => {
        const val = (d.rules[ds.key] ?? ds.default) as SettingValue;
        const set = (v: SettingValue) => (d.rules = { ...d.rules, [ds.key]: v });
        const ctl =
          ds.type === 'toggle'
            ? toggle(val === true, (v) => set(v), loc(ds.label))
            : ruleSelect((ds.options ?? []).map((op) => ({ label: loc(op.label), on: op.value === val, pick: () => (set(op.value), render()) })), loc(ds.label), 'soft');
        return field(loc(ds.label), ctl, ds.help ? loc(ds.help) : undefined);
      });

    body.replaceChildren(
      o.readOnly ? '' : h('section.card.me-card', h('div.me-name-row', h('span.me-current-icon', { html: modeIconSvg(d.icon) }), name), err, icons),
      h('section.card.me-card', h('h3.me-h', t('modes.secPlayers')), h('div.me-grid', field(t('modes.teams'), teams), seatRow)),
      h('section.card.me-card', h('h3.me-h', t('modes.secDeck')), row(t('modes.twoSided'), h('div.me-dn-ctl', twoSided, sideSeg)), deckBox, deckInfo),
      h('section.card.me-card', h('h3.me-h', t('modes.secRules')), h('div.me-grid', ...ruleRows)),
    );
    if (o.onDelete && !o.isNew && !o.readOnly) body.append(h('div.me-del-row', btn(t('modes.delete'), o.onDelete, 'ghost danger')));
    // the big icon follows the picked one
    icons.addEventListener('click', () => {
      const cur = body.querySelector('.me-current-icon');
      if (cur) cur.innerHTML = modeIconSvg(d.icon);
    });
    valid();
  };
  render();

  return h(
    'section.screen.panel-screen.mode-editor',
    screenHeader(o.isNew ? t('modes.new') : t('modes.edit'), o.onBack),
    h('div.scroll.me-scroll', body),
    h('div.me-foot', saveBtn),
  );
}

/** a mode's sections read-only (Ajustes › Reglas shows these under the mode row) */
export function modeDetails(def: ModeDef, descriptors: SettingDescriptor[]): HTMLElement {
  const screen = buildModeEditor({ draft: def, isNew: false, descriptors, nameFree: () => true, onSave: () => {}, onBack: () => {}, readOnly: true });
  const body = screen.querySelector('.me-body') as HTMLElement;
  body.classList.add('me-ro');
  return body;
}
