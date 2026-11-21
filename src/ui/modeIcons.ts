/**
 * Thumbnails a game mode can wear (ModeBase.icon): a little fan of two of the game's own cards in a square
 * (100 × 100 viewBox), some with a coloured emblem on top. The first five belong to the built-in modes (the
 * same pairs as the old mode cards); players pick any of them for their own modes. The ids are stored with
 * player-made modes, so they must stay.
 */
import type { CardBack } from '../contracts';
import type { AtlasFace } from '../render/cardAtlas';
import { cardBackSvg, cardSvg } from './cardArt';

const CREAM = '#fff6e6';
const INK = '#13232e';
const GOLD_RIM = '#6b3d00';

/** the inside of a card SVG (no outer <svg>), to place with a transform */
const inner = (s: string): string => s.replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '');
const face = (f: AtlasFace): string => inner(cardSvg(f, { width: 60 }));
/** a card back; its gradient and clip ids are renamed per thumbnail (`key`), so thumbnails never share ids */
const back = (b: CardBack, key: string): string =>
  inner(cardBackSvg(b, 60))
    .replace(/kbg-[a-z]+/g, `mt-${key}-g`)
    .replace(/kbc\b/g, `mt-${key}-c`);

const num = (color: AtlasFace['color'], value: number): string => face({ kind: 'number', color, value } as AtlasFace);
const act = (kind: AtlasFace['kind'], color: AtlasFace['color'] = null, extra: Partial<AtlasFace> = {}): string =>
  face({ kind, color, ...extra } as AtlasFace);

// ── emblems: chunky shapes in a 24 × 24 box, with a halo round the whole figure ──
interface Part {
  /** the element without its paint, e.g. `path d="…"` or `circle cx="…" cy="…" r="…"` */
  s: string;
  fill?: string;
  /** a line: stroke colour and width */
  stroke?: string;
  w?: number;
  /** a detail inside the figure: it gets no halo */
  in?: boolean;
}
const HALO = 3.6;
function emblem(parts: Part[], halo = CREAM): string {
  const round = 'stroke-linecap="round" stroke-linejoin="round"';
  const under = parts
    .filter((p) => !p.in)
    .map((p) => (p.stroke ? `<${p.s} fill="none" stroke="${halo}" stroke-width="${(p.w ?? 2) + HALO}" ${round}/>` : `<${p.s} fill="${halo}" stroke="${halo}" stroke-width="${HALO}" ${round}/>`))
    .join('');
  const over = parts.map((p) => (p.stroke ? `<${p.s} fill="none" stroke="${p.stroke}" stroke-width="${p.w ?? 2}" ${round}/>` : `<${p.s} fill="${p.fill}"/>`)).join('');
  return under + over;
}
const dot = (cx: number, cy: number, r: number): string => `circle cx="${cx}" cy="${cy}" r="${r}"`;

const EMBLEMS: Record<string, string> = {
  crown: emblem(
    [
      { s: 'path d="M3.2 20.5 2.2 7.2l5.4 4.3L12 4l4.4 7.5 5.4-4.3-1 13.3z"', fill: '#ffc93c' },
      { s: 'path d="M3.2 20.5 3 17.6h18l-.2 2.9z"', fill: '#f09a00', in: true },
      { s: dot(12, 13.2, 1.9), fill: '#e04a3f', in: true },
      { s: dot(6.6, 14.4, 1.2), fill: '#0c7489', in: true },
      { s: dot(17.4, 14.4, 1.2), fill: '#0c7489', in: true },
    ],
    GOLD_RIM,
  ),
  flame: emblem([
    { s: 'path d="M12 21.5c4 0 6.5-2.6 6.5-6.2 0-3.6-2.6-5.7-4-8.8-.7 2.2-1.9 3.2-3 3.6.3-2.6-.6-5.3-2.7-7.6.2 3.9-4.3 6.2-4.3 11.2 0 4 3 7.8 7.5 7.8z"', fill: '#ff6a1a' },
    { s: 'path d="M12 20.3c2.1 0 3.6-1.4 3.6-3.4 0-1.9-1.3-3-2.2-4.7-.5 1.3-1.5 1.9-2.4 2.9-1 1.1-2.4 2.1-2.4 3.6 0 1 1.2 1.6 3.4 1.6z"', fill: '#ffd23c', in: true },
  ]),
  star: emblem([{ s: 'path d="m12 2.6 2.8 5.9 6.4.9-4.6 4.5 1.1 6.4L12 17.2l-5.7 3.1 1.1-6.4-4.6-4.5 6.4-.9z"', fill: '#ffd23c' }], GOLD_RIM),
  heart: emblem([
    { s: 'path d="M12 21s-8.5-5-8.5-11.2A4.6 4.6 0 0 1 12 7.2a4.6 4.6 0 0 1 8.500 2.6C20.5 16 12 21 12 21z"', fill: '#ff3d7a' },
    { s: 'path d="M6.2 9.6a2.4 2.4 0 0 1 2.300-2.300"', stroke: '#ffc2d6', w: 1.4, in: true },
  ]),
  rocket: emblem(
    [
      { s: 'path d="M8.4 10.6 3.6 11.400 2.400 15.600 7 14.800zM13.400 15.600 12.600 20.400 8.400 21.600 9.200 17z"', fill: '#e04a3f' },
      { s: 'path d="M7.800 16.200C5.300 16.500 3.500 18.300 2.800 21.200 5.700 20.500 7.500 18.700 7.800 16.200z"', fill: '#ffb627' },
      { s: 'path d="M21 3c-5.800-.400-10.400 2.300-13 7.700l5.300 5.300C18.700 13.400 21.400 8.800 21 3z"', fill: '#f4f7fb' },
      { s: 'path d="M21 3c-2.300-.200-4.300.200-6.100 1l5.100 5.100c.800-1.800 1.200-3.800 1-6.100z"', fill: '#e04a3f', in: true },
      { s: dot(14.2, 9.8, 2.1), fill: '#0c7489', in: true },
    ],
    INK,
  ),
  dice: emblem(
    [
      { s: 'rect x="3.500" y="3.500" width="17" height="17" rx="4.500"', fill: CREAM },
      { s: dot(8, 8, 1.8), fill: '#e04a3f', in: true },
      { s: dot(16, 8, 1.8), fill: INK, in: true },
      { s: dot(12, 12, 1.8), fill: INK, in: true },
      { s: dot(8, 16, 1.8), fill: INK, in: true },
      { s: dot(16, 16, 1.8), fill: '#e04a3f', in: true },
    ],
    INK,
  ),
  target: emblem([
    { s: dot(12, 12, 9.6), fill: '#e04a3f' },
    { s: dot(12, 12, 6.5), fill: CREAM, in: true },
    { s: dot(12, 12, 3.3), fill: '#e04a3f', in: true },
  ]),
  snow: emblem(
    [
      { s: 'path d="M12 2.500v19M3.800 7.250l16.400 9.500M3.800 16.750l16.400-9.500"', stroke: '#f1fbff', w: 2.6 },
      { s: 'path d="m9.300 4.200 2.700 2.200 2.700-2.200M9.300 19.800l2.700-2.200 2.700 2.200"', stroke: '#f1fbff', w: 2 },
    ],
    '#0f6f9e',
  ),
  wave: emblem([
    { s: 'path d="M1.500 20.500V17c3 0 4.300-2.300 5.300-5C8.300 8 11.300 5 15.600 5c3.200 0 5.300 1.700 5.900 4.300-1.600-1-3.600-.900-4.700.300-1.700 1.800-.600 4.800 2.500 5.300 1.200.200 2.300 0 3.200-.500v6.100z"', fill: '#19a6c9' },
    { s: 'path d="M9.300 11.500c1.200-2.400 3.200-3.900 5.700-4.200"', stroke: '#d9f6ff', w: 1.5, in: true },
  ]),
  leaf: emblem([
    { s: 'path d="M4.300 19.700C3.300 11 9 4.600 20 4c.500 11-5.900 16.900-15.700 15.700z"', fill: '#4db33d' },
    { s: 'path d="M4.800 19.200c3.200-4.200 6.400-6.700 10.600-8.700M9.300 14.300l-.300-3.300M12.300 12.200l3.300.400"', stroke: CREAM, w: 1.3, in: true },
  ]),
  skull: emblem(
    [
      { s: 'path d="M12 2.500a8 8 0 0 0-5.300 14V19.500A2 2 0 0 0 8.700 21.500h6.600a2 2 0 0 0 2-2v-3A8 8 0 0 0 12 2.500z"', fill: CREAM },
      { s: dot(8.8, 11.2, 2.2), fill: INK, in: true },
      { s: dot(15.2, 11.2, 2.2), fill: INK, in: true },
      { s: 'path d="M12 13.600 10.900 16h2.200z"', fill: INK, in: true },
      { s: 'path d="M10.300 21v-2.500M13.700 21v-2.500"', stroke: INK, w: 1.3, in: true },
    ],
    INK,
  ),
  clock: emblem(
    [
      { s: dot(12, 12.5, 9.2), fill: '#0c7489' },
      { s: dot(12, 12.5, 6.6), fill: CREAM, in: true },
      { s: 'path d="M12 8.300v4.400l2.800 1.700"', stroke: INK, w: 1.9, in: true },
    ],
    CREAM,
  ),
  shield: emblem([
    { s: 'path d="M12 21.800s8-3.500 8-10.500V5.200L12 2.400 4 5.200v6.100c0 7 8 10.500 8 10.500z"', fill: '#2a8fd6' },
    { s: 'path d="M8.200 11.900l2.700 2.700 4.900-5.100"', stroke: CREAM, w: 2.4, in: true },
  ]),
  ghost: emblem(
    [
      { s: 'path d="M4.500 21V10.200a7.500 7.500 0 0 1 15 0V21l-2.500-1.900-2.500 1.900-2.500-1.900L9.500 21 7 19.100z"', fill: '#f4f0ff' },
      { s: dot(9.3, 10.6, 1.7), fill: '#2a1c52', in: true },
      { s: dot(14.7, 10.6, 1.700), fill: '#2a1c52', in: true },
      { s: 'path d="M10.400 14.600q1.600 1.300 3.200 0"', stroke: '#2a1c52', w: 1.2, in: true },
    ],
    '#2a1c52',
  ),
  gem: emblem([
    { s: 'path d="M6.300 3.300h11.400L22 9 12 21.500 2 9z"', fill: '#2fc4e8' },
    { s: 'path d="M6.300 3.300h11.400L22 9H2z"', fill: '#9eeeff', in: true },
    { s: 'path d="M8.200 9 12 21.500 15.800 9z"', fill: '#62dcf5', in: true },
    { s: 'path d="M2 9h20M9.400 3.300 8.200 9M14.600 3.300 15.800 9"', stroke: '#0f7fb5', w: 0.9, in: true },
  ]),
  music: emblem([
    { s: 'path d="M9.200 17.500V6l10.300-2.200V15.400"', stroke: '#ff3d9a', w: 2.6 },
    { s: 'path d="M9.200 4.900 19.500 2.700v3.600L9.200 8.500z"', fill: '#ff3d9a' },
    { s: dot(6.4, 17.6, 3.4), fill: '#ff3d9a' },
    { s: dot(16.7, 15.5, 3.4), fill: '#ff3d9a' },
  ]),
  palm: emblem([
    { s: 'path d="M11.400 21.500c0-4.600.600-8.300 2.300-11.600"', stroke: '#a8642a', w: 2.8 },
    { s: 'path d="M14 9.500C12 5.600 7.600 4.900 3.500 7.300c3.200.400 5.600 1.600 7.200 3.500z"', fill: '#4db33d' },
    { s: 'path d="M14 9.500c1-3.900 4.800-6 8.700-4.900-2.700 1.100-4.400 2.800-5.400 5z"', fill: '#4db33d' },
    { s: 'path d="M14 9.500c3.300-.100 6.600 2.100 7.600 5.500-2.700-1.700-5.300-2.200-7.600-1.600z"', fill: '#3a9a2e' },
    { s: 'path d="M14 9.500c-2.800.500-6 3.300-6.500 7.100 2.100-2.200 4.300-3.800 6.500-4.400z"', fill: '#3a9a2e' },
    { s: dot(13.6, 10.6, 1.3), fill: '#7a4416', in: true },
  ]),
  sun: emblem(
    [
      { s: 'path d="M12 2.300v2.400M12 19.300v2.400M5.100 5.100l1.700 1.700M17.200 17.200l1.700 1.700M2.300 12h2.400M19.300 12h2.400M5.100 18.900l1.700-1.700M17.200 6.800l1.700-1.700"', stroke: '#ffd23c', w: 2.6 },
      { s: dot(12, 12, 5.4), fill: '#ffd23c' },
      { s: dot(12, 12, 3.2), fill: '#ffe680', in: true },
    ],
    GOLD_RIM,
  ),
  infinity: emblem([{ s: 'path d="M12 12c-2-2.700-3.600-4.200-5.600-4.200a4.200 4.200 0 0 0 0 8.400c2 0 3.600-1.500 5.600-4.200s3.600-4.200 5.600-4.200a4.200 4.200 0 0 1 0 8.400c-2 0-3.600-1.500-5.600-4.200z"', stroke: '#ffb627', w: 3.2 }], INK),
};

/**
 * Two cards fanned in the square, the first behind and turned left, the second in front and turned right
 * (the old mode-card composition), and an optional emblem over the bottom right corner.
 */
function thumb(a: string, b: string, emb?: string): string {
  const s = emb ? 0.74 : 0.8;
  const [ax, bx, y] = emb ? [7, 34, 8] : [9, 43, 13];
  return (
    `<svg class="mode-thumb" viewBox="0 0 100 100" aria-hidden="true" focusable="false">` +
    `<g transform="translate(${ax} ${y}) scale(${s}) rotate(-10 30 45)">${a}</g>` +
    `<g transform="translate(${bx} ${y + 2}) scale(${s}) rotate(8 30 45)">${b}</g>` +
    (emb ? `<g transform="translate(44 44) scale(2.2)">${emb}</g>` : '') +
    `</svg>`
  );
}

export const MODE_ICONS: Record<string, string> = {
  // built-ins (the pairs of the old mode cards)
  cards: thumb(num('mar', 7), num('sol', 4)),
  bolt: thumb(act('swap'), act('sweep', 'palma')),
  tornado: thumb(act('draw2', 'coral', { draw: 2 }), act('wild4', null, { draw: 4 })),
  pair: thumb(num('coral', 2), num('coral', 2)),
  sunmoon: thumb(act('flip', 'sol'), act('flip', 'morado')),
  // to pick for player-made modes
  crown: thumb(num('sol', 1), num('sol', 9), EMBLEMS.crown),
  flame: thumb(act('draw2', 'coral', { draw: 2 }), act('draw6', 'coral', { draw: 6 }), EMBLEMS.flame),
  star: thumb(act('wild'), num('mar', 5), EMBLEMS.star),
  heart: thumb(num('rosa', 2), num('coral', 2), EMBLEMS.heart),
  rocket: thumb(act('draw6', 'mar', { draw: 6 }), act('draw10', null, { draw: 10 }), EMBLEMS.rocket),
  dice: thumb(num('palma', 6), num('coral', 1), EMBLEMS.dice),
  target: thumb(act('skip', 'mar'), num('sol', 1), EMBLEMS.target),
  snow: thumb(num('celeste', 0), act('skip', 'celeste'), EMBLEMS.snow),
  wave: thumb(num('mar', 3), act('reverse', 'mar'), EMBLEMS.wave),
  leaf: thumb(num('palma', 5), act('reverse', 'sol'), EMBLEMS.leaf),
  skull: thumb(act('draw6', 'morado', { draw: 6 }), act('wild4', null, { draw: 4, night: true }), EMBLEMS.skull),
  clock: thumb(num('sol', 9), act('skip', 'coral'), EMBLEMS.clock),
  shield: thumb(num('palma', 8), act('skip', 'sol'), EMBLEMS.shield),
  ghost: thumb(back('night', 'ghost'), num('morado', 0), EMBLEMS.ghost),
  gem: thumb(num('morado', 7), num('rosa', 7), EMBLEMS.gem),
  music: thumb(act('reverse', 'naranja'), num('celeste', 3), EMBLEMS.music),
  palm: thumb(num('palma', 4), act('sweep', 'palma'), EMBLEMS.palm),
  sun: thumb(num('sol', 7), back('sun', 'sun'), EMBLEMS.sun),
  infinity: thumb(back('ku', 'infinity'), act('wild'), EMBLEMS.infinity),
};

/** the icon ids a player can choose, in picker order */
export const MODE_ICON_IDS = Object.keys(MODE_ICONS);

/** a thumbnail's SVG, sized by CSS (unknown ids fall back to the cards thumbnail) */
export const modeIconSvg = (id: string): string => MODE_ICONS[id] ?? MODE_ICONS.cards;

/** a thumbnail as an SVG of `size` × `size` px */
export const modeThumb = (id: string, size = 32): string => modeIconSvg(id).replace('<svg ', `<svg width="${size}" height="${size}" `);
