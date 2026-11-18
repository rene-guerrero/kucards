import type { CardFace } from '../contracts';
import { cardSvg } from './cardArt';
import { h } from './dom';
import { t, type Key } from './i18n';
import { iconBtn, ICONS } from './overlay';

export function screenHeader(title: string, onBack: () => void): HTMLElement {
  return h('header.screen-head', iconBtn(ICONS.back, t('common.back'), onBack, 'back'), h('h2', title));
}

interface Item {
  cards?: CardFace[];
  /** a seating diagram instead of cards */
  seats?: 'ABAB' | 'AABB';
  title?: Key;
  text: Key;
  /** bold the text up to its first full stop (rule name + explanation in one string) */
  lead?: boolean;
}
interface Section {
  title: Key;
  items: Item[];
}

const N = (color: CardFace['color'], value: number): CardFace => ({ kind: 'number', color, value });

const SECTIONS: Section[] = [
  {
    title: 'howto.goal.title',
    items: [
      { cards: [N('mar', 7), N('mar', 3), N('sol', 3)], text: 'howto.goal.body' },
      { text: 'howto.turn.body' },
    ],
  },
  {
    title: 'howto.ku.title',
    items: [{ cards: [N('coral', 5)], text: 'howto.ku.body' }, { text: 'howto.ku.rule' }],
  },
  {
    title: 'howto.actions.title',
    items: [
      { cards: [{ kind: 'skip', color: 'palma' }], title: 'card.skip', text: 'howto.skip' },
      { cards: [{ kind: 'reverse', color: 'mar' }], title: 'card.reverse', text: 'howto.reverse' },
      { cards: [{ kind: 'draw2', color: 'coral', draw: 2 }], title: 'card.draw2', text: 'howto.draw2' },
      { cards: [{ kind: 'wild', color: null }], title: 'card.wild', text: 'howto.wild' },
      { cards: [{ kind: 'wild4', color: null, draw: 4 }], title: 'card.wild4', text: 'howto.wild4' },
    ],
  },
  {
    title: 'howto.challenge.title',
    items: [{ cards: [{ kind: 'wild4', color: null, draw: 4 }, N('sol', 2)], text: 'howto.challenge.body' }],
  },
  {
    title: 'howto.power.title',
    items: [
      { text: 'howto.power.intro' },
      { cards: [{ kind: 'swap', color: null }], title: 'card.swap', text: 'howto.swap' },
      { cards: [{ kind: 'shield', color: 'sol' }], title: 'card.shield', text: 'howto.shield' },
      { cards: [{ kind: 'mirror', color: 'mar' }], title: 'card.mirror', text: 'howto.mirror' },
      { cards: [{ kind: 'sweep', color: 'palma' }], title: 'card.sweep', text: 'howto.sweep' },
    ],
  },
  {
    title: 'howto.cyclone.title',
    items: [
      { cards: [{ kind: 'skipAll', color: 'coral' }], title: 'card.skipAll', text: 'howto.skipAll' },
      { cards: [{ kind: 'draw6', color: 'mar', draw: 6 }], title: 'card.draw6', text: 'howto.draw6' },
      { cards: [{ kind: 'draw10', color: null, draw: 10 }], title: 'card.draw10', text: 'howto.draw10' },
      { cards: [{ kind: 'wildColor', color: null }], title: 'card.wildColor', text: 'howto.wildColor' },
    ],
  },
  {
    title: 'howto.modes.title',
    items: [
      { title: 'mode.classic', text: 'howto.mode.classic' },
      { title: 'mode.action', text: 'howto.mode.action' },
      { title: 'mode.cyclone', text: 'howto.mode.cyclone' },
      { title: 'mode.partners', text: 'howto.mode.partners' },
      { seats: 'ABAB', title: 'seating.across', text: 'howto.seat.across' },
      { seats: 'AABB', title: 'seating.side', text: 'howto.seat.side' },
    ],
  },
  {
    title: 'howto.rules.title',
    items: [
      { text: 'howto.rules.intro' },
      { cards: [{ kind: 'draw2', color: 'sol', draw: 2 }, { kind: 'draw2', color: 'mar', draw: 2 }], text: 'howto.rule.stacking', lead: true },
      { cards: [N('palma', 4), N('palma', 4)], text: 'howto.rule.jumpIn', lead: true },
      { cards: [N('coral', 7), N('mar', 0)], text: 'howto.rule.sevenZero', lead: true },
      { text: 'howto.rule.drawMode', lead: true },
      { text: 'howto.rule.forcePlay', lead: true },
      { text: 'howto.rule.partnerOpen', lead: true },
      { text: 'howto.rule.partnerPass', lead: true },
      { cards: [{ kind: 'shield', color: 'palma' }], text: 'howto.rule.partnerShield', lead: true },
    ],
  },
  { title: 'howto.score.title', items: [{ text: 'howto.score.body' }] },
];

/** A B A B / A A B B round a small table (seat 0 at the bottom, turn order clockwise) */
export function seatingDiagram(kind: 'ABAB' | 'AABB', size = 64): HTMLElement {
  // positions: bottom, left, top, right (turn order 0 → 1 → 2 → 3)
  const pos = [
    [32, 54],
    [10, 32],
    [32, 10],
    [54, 32],
  ];
  const teams = kind === 'ABAB' ? ['A', 'B', 'A', 'B'] : ['A', 'A', 'B', 'B'];
  const dots = pos
    .map(([x, y], i) => `<circle cx="${x}" cy="${y}" r="8.5" class="sd-${teams[i]}"/><text x="${x}" y="${y + 4}" text-anchor="middle">${teams[i]}</text>`)
    .join('');
  return h('span.seat-diagram', {
    html: `<svg viewBox="0 0 64 64" width="${size}" height="${size}" aria-hidden="true"><rect x="16" y="16" width="32" height="32" rx="9" class="sd-table"/>${dots}</svg>`,
  });
}

function itemText(it: Item): (HTMLElement | string)[] {
  const s = t(it.text);
  if (it.title) return [h('strong', `${t(it.title)}. `), s];
  const cut = it.lead ? s.indexOf('. ') : -1;
  return cut > 0 ? [h('strong', s.slice(0, cut + 1)), s.slice(cut + 1)] : [s];
}

export function buildHowto(onBack: () => void): HTMLElement {
  const sections = SECTIONS.map((s, i) =>
    h(
      'article.card.howto-sec',
      { style: `--i:${i}` },
      h('h3', t(s.title)),
      ...s.items.map((it) =>
        h(
          'div.howto-item',
          { class: it.cards || it.seats ? 'with-art' : '' },
          it.cards ? h('span.howto-cards', { html: it.cards.map((c) => cardSvg(c, { width: 38 })).join('') }) : it.seats ? seatingDiagram(it.seats, 58) : null,
          h('p', ...itemText(it)),
        ),
      ),
    ),
  );
  return h('section.screen.panel-screen.howto', screenHeader(t('menu.howto'), onBack), h('div.scroll', h('div.content', ...sections)));
}
