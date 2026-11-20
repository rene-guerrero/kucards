/**
 * Small SVG card art for the HTML layer (logo, how-to, colour picker, settings swatches). Same style as
 * the 3D cards: a rounded card, a colour field, a centre medallion with the colour symbol (every colour
 * has its own symbol, so colour-blind players can read it) and a corner numeral.
 */
import type { CardBack, CardFace, CardKind, Color, TableStyle } from '../contracts';
import { BACK_FIELD, backDesign } from '../render/cardBacks';
import type { AnyColor, AtlasFace, NightColor } from '../render/cardAtlas';

const DESIGN_IDS: readonly string[] = ['ku', 'weave', 'sun', 'night'];

/** the four card colours (the same values as COLOR_HEX / COLOR_DEEP in src/render/cardAtlas.ts) */
export const COLOR_HEX: Record<AnyColor, string> = {
  sol: '#f7b417', mar: '#0c7489', palma: '#4db33d', coral: '#e04a3f',
  naranja: '#ff8a1f', celeste: '#3fc8ff', rosa: '#ff3d9a', morado: '#8a4dff',
};
/** a deep shade of each colour, for the marks on the ivory capsule */
export const COLOR_DEEP: Record<AnyColor, string> = {
  sol: '#b86e00', mar: '#0a5d6f', palma: '#2f8a26', coral: '#bf2f2c',
  naranja: '#b34e00', celeste: '#0f7fb5', rosa: '#b8125f', morado: '#4f1fb8',
};
const COLORS: Color[] = ['sol', 'mar', 'palma', 'coral'];

// night side (Día y Noche): the same values as the night section of src/render/cardAtlas.ts. A face is a
// night face when its colour (or the tint of a played wild) is a night colour or it carries `night: true`.
export const NIGHT_COLORS: readonly NightColor[] = ['naranja', 'celeste', 'rosa', 'morado'];
/** the bright version of the night colours: the marks on the black capsule */
export const NIGHT_GLOW: Record<NightColor, string> = { naranja: '#ffb05c', celeste: '#8fe1ff', rosa: '#ff8cc4', morado: '#b894ff' };
const NIGHT_PAPER = '#08080c';
const NIGHT_LIGHT = '#efe9ff';
const NIGHT_WILD_FIELD = '#17122b';
const isNightColor = (c: string | null | undefined): c is NightColor => !!c && (NIGHT_COLORS as readonly string[]).includes(c);
const CREAM = '#fff6e6';
const INK = '#13232e';
const WILD_FIELD = '#0b0b0d';

/** colour symbols, drawn in a 24×24 box centred on (12,12), filled with `fill` */
export function symbolMarkup(c: AnyColor, fill: string, vein = CREAM): string {
  switch (c) {
    case 'sol': {
      const rays = Array.from({ length: 8 }, (_, i) => {
        const a = (i * Math.PI) / 4;
        const x1 = 12 + Math.cos(a) * 7.4, y1 = 12 + Math.sin(a) * 7.4, x2 = 12 + Math.cos(a) * 10.6, y2 = 12 + Math.sin(a) * 10.6;
        return `M${x1.toFixed(2)} ${y1.toFixed(2)}L${x2.toFixed(2)} ${y2.toFixed(2)}`;
      }).join('');
      return `<circle cx="12" cy="12" r="5.2" fill="${fill}"/><path d="${rays}" stroke="${fill}" stroke-width="2.2" stroke-linecap="round"/>`;
    }
    case 'mar':
      return `<path d="M2 9.5q2.5-3 5 0t5 0 5 0 5 0M2 15.5q2.5-3 5 0t5 0 5 0 5 0" fill="none" stroke="${fill}" stroke-width="2.6" stroke-linecap="round"/>`;
    case 'palma':
      return `<path d="M12 2.5C17.5 6 18.5 14 12 21.5 5.5 14 6.5 6 12 2.5z" fill="${fill}"/><path d="M12 6v14M12 10l-3-2.2M12 10l3-2.2M12 14l-3.6-2.4M12 14l3.6-2.4" stroke="${vein}" stroke-width="1.2" stroke-linecap="round" opacity=".85"/>`;
    case 'coral':
      return `<path d="M12 20.5 3.2 10.4a9.6 9.6 0 0 1 17.6 0z" fill="${fill}"/><path d="M12 20.5 7 7.4M12 20.5 12 5.6M12 20.5 17 7.4M12 20.5 4.6 9.6M12 20.5l7.4-10.9" stroke="${vein}" stroke-width="1.1" stroke-linecap="round" opacity=".85"/><rect x="9.6" y="19.4" width="4.8" height="2.6" rx="1" fill="${fill}"/>`;
    case 'naranja': // comet
      return `<circle cx="8.2" cy="15.8" r="4.8" fill="${fill}"/><path d="M12.8 11.2 21 3M14.6 15.4 21.6 9.8M8.6 9.4 14.6 2.6" fill="none" stroke="${fill}" stroke-width="2" stroke-linecap="round"/>`;
    case 'celeste': // crescent moon
      return `<path d="M15.8 3.84A9 9 0 1 0 20.16 15.8 7.6 7.6 0 0 1 15.8 3.84z" fill="${fill}"/>`;
    case 'rosa': // four-point star with a spark
      return `<path d="M11 3.5Q12.5 11 20 12.5 12.5 14 11 21.5 9.5 14 2 12.5 9.5 11 11 3.5zM19 2.2Q19.5 4.7 22 5.2 19.5 5.7 19 8.2 18.5 5.7 16 5.2 18.5 4.7 19 2.2z" fill="${fill}"/>`;
    case 'morado': // crystal
      return `<path d="M12 2 18.6 8v8L12 22 5.4 16V8z" fill="${fill}"/><path d="M5.4 8 12 11.2 18.6 8M12 11.2V22" fill="none" stroke="${vein}" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" opacity=".85"/>`;
  }
}

export function symbolSvg(c: AnyColor, size = 24, fill = COLOR_HEX[c]): string {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" focusable="false">${symbolMarkup(c, fill)}</svg>`;
}

/** action glyphs in the same 24×24 box (stroke `col`) */
function glyph(kind: CardKind, col: string, isIndex = col === CREAM): string {
  const st = `fill="none" stroke="${col}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"`;
  switch (kind) {
    case 'skip':
      return `<circle cx="12" cy="12" r="7.6" ${st}/><path d="M6.8 17.2 17.2 6.8" ${st}/>`;
    case 'reverse':
      // two arrows chasing each other round a ring, like the direction ring on the table
      return (
        `<path d="M4.95 9.43A7.5 7.5 0 0 1 18.5 8.25M19.05 14.57A7.5 7.5 0 0 1 5.5 15.75" ${st}/>` +
        `<path d="M20.7 12.06 21.6 6.45 15.4 10.05ZM3.3 11.94 2.4 17.55 8.6 13.95Z" fill="${col}" stroke="${col}" stroke-width="1.2" stroke-linejoin="round"/>`
      );
    case 'shield':
      return `<path d="M12 3.5 19 6v5.5c0 4.5-3 7.6-7 9-4-1.4-7-4.5-7-9V6z" ${st}/><path d="M8.6 12l2.4 2.4 4.4-4.6" ${st.replace('2.6', '2')}/>`;
    case 'mirror':
      return `<path d="M12 3v18M8 7 4 12l4 5M16 7l4 5-4 5" ${st}/>`;
    case 'sweep': {
      // the hand, fanned out, goes down onto the pile. On the capsule (deep colour): four cards, a curved
      // arrow and a short stack (top card and two edges); as the ivory corner index: three cards over a plain down arrow.
      const small = isIndex;
      const fan = (small
        ? ['M4.25 5.88L7.55 3.98Q8.67 3.33 9.32 4.46L12.82 10.52Q13.47 11.65 12.35 12.3L9.05 14.2Q7.93 14.85 7.28 13.72L3.78 7.66Q3.13 6.53 4.25 5.88Z', 'M16.45 3.98L19.75 5.88Q20.87 6.53 20.22 7.66L16.72 13.72Q16.07 14.85 14.95 14.2L11.65 12.3Q10.53 11.65 11.18 10.52L14.68 4.46Q15.33 3.33 16.45 3.98Z', 'M10.1 3.3L13.9 3.3Q15.2 3.3 15.2 4.6L15.2 11.6Q15.2 12.9 13.9 12.9L10.1 12.9Q8.8 12.9 8.8 11.6L8.8 4.6Q8.8 3.3 10.1 3.3Z']
        : ['M1.27 6.51L3.35 4.63Q4.09 3.96 4.76 4.71L8.51 8.87Q9.18 9.61 8.43 10.28L6.35 12.15Q5.61 12.82 4.94 12.08L1.19 7.92Q0.53 7.17 1.27 6.51Z', 'M5.22 3.64L7.94 2.96Q8.91 2.72 9.15 3.69L10.51 9.12Q10.75 10.09 9.78 10.33L7.06 11.01Q6.09 11.25 5.85 10.28L4.49 4.85Q4.25 3.88 5.22 3.64Z', 'M10.06 2.96L12.78 3.64Q13.75 3.88 13.51 4.85L12.15 10.28Q11.91 11.25 10.94 11.01L8.22 10.33Q7.25 10.09 7.49 9.12L8.85 3.69Q9.09 2.72 10.06 2.96Z', 'M14.65 4.63L16.73 6.51Q17.47 7.17 16.81 7.92L13.06 12.08Q12.39 12.82 11.65 12.15L9.57 10.28Q8.82 9.61 9.49 8.87L13.24 4.71Q13.91 3.96 14.65 4.63Z']
      )
        .map((d) => `<path d="${d}" fill="${col}" stroke="${small ? INK : CREAM}" stroke-width="${small ? 1.1 : 0.8}" stroke-linejoin="round"/>`)
        .join('');
      if (small) return fan + `<path d="M12 15.4v6M8.6 18.6l3.4 3.4 3.4-3.4" ${st}/>`;
      return (
        fan +
        `<path d="M19.6 5Q23.4 11 18 15.4" ${st.replace('2.6', '2')}/>` +
        `<path d="M16.14 16.91 19.78 16.78 17 13.38ZM5 17.2h7.6l2 3H3Z" fill="${col}" stroke="${col}" stroke-width="1" stroke-linejoin="round"/>` +
        `<path d="M3.2 21.9h11.2M3.2 23.4h11.2" ${st.replace('2.6', '1.2')}/>`
      );
    }
    case 'swap':
      return `<path d="M4 8h14l-3-3M20 16H6l3 3" ${st}/><circle cx="12" cy="12" r="1.6" fill="${col}"/>`;
    case 'flip':
      return `<circle cx="12" cy="12" r="8" ${st}/><path d="M12 4a8 8 0 0 1 0 16z" fill="${col}"/>`;
    case 'skipAll':
      return `<circle cx="12" cy="12" r="8.4" ${st}/><path d="M12 5.6v3M12 15.4v3M5.6 12h3M15.4 12h3" ${st.replace('2.6', '2.2')}/><circle cx="12" cy="12" r="1.8" fill="${col}"/>`;
    case 'wildColor':
      return `<path d="M12 2.6c2.6 3.4 3.9 5.5 3.9 7.2a3.9 3.9 0 0 1-7.8 0c0-1.7 1.3-3.8 3.9-7.2z" fill="${col}"/><path d="M5 15.5h14M6.5 18.6h11M8 21.6h8" ${st.replace('2.6', '2')}/>`;
    default:
      return '';
  }
}

const KIND_DRAW_TEXT: Record<string, string | undefined> = { draw1: '+1', draw2: '+2', wild4: '+4', draw5: '+5', draw6: '+6', draw10: '+10' };
const cornerText = (f: Pick<CardFace, 'kind' | 'value' | 'draw'>): string => (f.kind === 'number' ? String(f.value ?? 0) : f.draw ? `+${f.draw}` : KIND_DRAW_TEXT[f.kind] ?? '');

const FONT = "system-ui,-apple-system,'Segoe UI',Roboto,sans-serif";
/** the gloss on the top of the colour field (turned half a turn it is the shade at the bottom) */
const SHEEN = 'M3.4 9A5.6 5.6 0 0 1 9 3.4H51A5.6 5.6 0 0 1 56.6 9V30Q30 46 3.4 30Z';
/** the four quarters of the wild capsule */
const QUADS: readonly string[] = [
  'M30 45H17.3V36.5A12.7 12.7 0 0 1 30 23.8Z',
  'M30 45V23.8A12.7 12.7 0 0 1 42.7 36.5V45Z',
  'M30 45H42.7V53.5A12.7 12.7 0 0 1 30 66.2Z',
  'M30 45V66.2A12.7 12.7 0 0 1 17.3 53.5V45Z',
];
/** the wild's four colours, clockwise from the top-left quarter: day and night */
const WILD_ORDER: readonly AnyColor[] = ['coral', 'sol', 'mar', 'palma'];
const NIGHT_WILD_ORDER: readonly AnyColor[] = ['rosa', 'naranja', 'celeste', 'morado'];
/** the small four-colour disc in the corner of the plain wild */
const CORNER_QUADS: readonly string[] = [
  'M11.5 13H5.9A5.6 5.6 0 0 1 11.5 7.4Z',
  'M11.5 13V7.4A5.6 5.6 0 0 1 17.1 13Z',
  'M11.5 13H17.1A5.6 5.6 0 0 1 11.5 18.6Z',
  'M11.5 13V18.6A5.6 5.6 0 0 1 5.9 13Z',
];
const quads = (q: readonly string[], order: readonly AnyColor[]): string => q.map((d, i) => `<path d="${d}" fill="${COLOR_HEX[order[i]]}"/>`).join('');
const text = (t: string, x: number, y: number, size: number, fill: string, extra = ''): string =>
  `<text x="${x}" y="${y}" text-anchor="middle" font-family="${FONT}" font-size="${size}" font-weight="900" fill="${fill}"${extra}>${t}</text>`;

/**
 * A whole card face as SVG (60×90 viewBox): the same design as drawFace in src/render/cardAtlas.ts, shape
 * for shape. No ids inside (no gradients or clip paths), so any number of cards can share a document or be
 * inlined into one SVG. `tint` is the colour chosen for a played wild-type card. Night faces (a night colour, a
 * night tint or `night: true`) are drawn in neon on black, as in the atlas.
 */
export function cardSvg(f: AtlasFace, opts: { width?: number; cls?: string; rotate?: number } = {}): string {
  const w = opts.width ?? 48;
  const hgt = Math.round(w * 1.5);
  const c = f.color;
  const hue = c ?? f.tint ?? null;
  // night side: the ivory parts are black, the marks on the capsule glow, the index is black with a light rim
  const night = !!f.night || isNightColor(c) || isNightColor(f.tint);
  const paper = night ? NIGHT_PAPER : CREAM;
  const order = night ? NIGHT_WILD_ORDER : WILD_ORDER;
  const ink = night ? NIGHT_LIGHT : INK;
  const idxFill = night ? (hue ? NIGHT_PAPER : NIGHT_WILD_FIELD) : CREAM;
  const idxRim = night ? (isNightColor(hue) ? NIGHT_GLOW[hue] : NIGHT_LIGHT) : INK;
  const onField = night ? (hue ? NIGHT_PAPER : NIGHT_LIGHT) : CREAM;
  const field = hue ? COLOR_HEX[hue] : night ? NIGHT_WILD_FIELD : WILD_FIELD;
  const t = cornerText(f);
  let mid =
    `<rect x="15.5" y="23.3" width="29" height="46" rx="14.5" fill="#000" fill-opacity=".24"/>` +
    `<rect x="15.5" y="22" width="29" height="46" rx="14.5" fill="${paper}"/>`;
  if (!c) {
    mid += quads(QUADS, order) + `<path d="M30 23.8V66.2M17.3 45H42.7" stroke="${paper}" stroke-width=".9"/>`;
    if (f.kind === 'draw10') mid += `<rect x="13.4" y="19.9" width="33.2" height="50.2" rx="16.6" fill="none" stroke="${night ? onField : paper}" stroke-width="1.3" stroke-dasharray="3 2.2"/>`;
    mid += `<circle cx="30" cy="45" r="9.8" fill="${paper}" stroke="${night ? NIGHT_LIGHT : '#000'}" stroke-opacity="${night ? '.3' : '.22'}" stroke-width=".8"/>`;
    const m = f.kind === 'wild' ? 'Ku' : t;
    mid += m
      ? text(m, 30, m.length > 2 ? 48.2 : 48.9, m.length > 2 ? 9 : m === 'Ku' ? 10.5 : 11.5, ink)
      : `<g transform="translate(21.6 36.6) scale(.7)">${glyph(f.kind, ink, false)}</g>`;
  } else {
    const deep = isNightColor(c) ? NIGHT_GLOW[c] : COLOR_DEEP[c];
    mid += `<rect x="17.4" y="23.9" width="25.2" height="42.2" rx="12.6" fill="none" stroke="${deep}" stroke-opacity="${night ? '.7' : '.45'}" stroke-width=".9"/>`;
    // night: a soft halo of the card colour round the bright figure
    const halo = night ? ` stroke="${COLOR_HEX[c]}" stroke-opacity=".4" stroke-width="2.6" stroke-linejoin="round" paint-order="stroke"` : '';
    mid += t
      ? text(t, 30, t.length > 1 ? 45.6 : 47.4, t.length > 2 ? 13 : t.length > 1 ? 17 : 25, deep, halo)
      : `<g transform="translate(18.6 26.2) scale(.95)">${glyph(f.kind, deep, false)}</g>`;
    mid += `<g transform="translate(22.8 50.6) scale(.6)">${symbolMarkup(c, deep, paper)}</g>`;
  }
  // corner: the outlined index (or the glyph) on its own; repeated half a turn round
  let cor = '';
  if (t) {
    // multi-character indices ("+2" … "+10") are fitted to a fixed width so they keep a margin from the border
    const multi = t.length > 1;
    const maxW = t.length > 2 ? 13.2 : 12.2;
    const outline = ` stroke="${idxRim}" stroke-width="${multi ? 1.8 : 2.2}" stroke-linejoin="round" paint-order="stroke"`;
    cor = multi
      ? text(t, 6.6 + maxW / 2, 19, t.length > 2 ? 9.2 : 12.4, idxFill, `${outline} textLength="${maxW}" lengthAdjust="spacingAndGlyphs"`)
      : text(t, 12.4, 20.6, 18, idxFill, outline);
  } else if (f.kind === 'wild') {
    cor = quads(CORNER_QUADS, order) + `<circle cx="11.5" cy="13" r="5.6" fill="none" stroke="${night ? NIGHT_LIGHT : CREAM}" stroke-width="1"/>`;
  } else {
    cor = `<g transform="translate(4.2 5) scale(.68)">${glyph(f.kind, onField, true)}</g>`;
  }
  const weave = hue
    ? ''
    : (night ? NIGHT_COLORS : COLORS).map((col, i) => `<path d="M3.4 ${12 + i * 20}L56.6 ${30 + i * 20}" stroke="${COLOR_HEX[col]}" stroke-width="1.2" stroke-opacity=".3"/>`).join('');
  const rot = opts.rotate ? ` style="transform:rotate(${opts.rotate}deg)"` : '';
  return (
    `<svg class="kc-card ${opts.cls ?? ''}" viewBox="0 0 60 90" width="${w}" height="${hgt}" aria-hidden="true" focusable="false"${rot}>` +
    `<rect x=".3" y=".3" width="59.4" height="89.4" rx="6.8" fill="${paper}" stroke="${night ? '#fff' : '#000'}" stroke-opacity=".25" stroke-width=".6"/>` +
    `<rect x="3.4" y="3.4" width="53.2" height="83.2" rx="5.6" fill="${field}"/>` +
    `<path d="${SHEEN}" fill="#fff" fill-opacity=".12"/><path d="${SHEEN}" fill="#000" fill-opacity=".12" transform="rotate(180 30 45)"/>` +
    weave +
    mid +
    cor +
    `<g transform="rotate(180 30 45)">${cor}</g>` +
    `</svg>`
  );
}

/**
 * A card back as SVG: the shared design of src/render/cardBacks.ts, the same data drawBack (card atlas)
 * paints on canvas. The ids are the same in every copy of a back, so repeating them in a page is harmless.
 */
export function cardBackSvg(b: CardBack, width = 34): string {
  const d = backDesign(b);
  const id = DESIGN_IDS.includes(b) ? b : 'ku';
  const layers = d.layers
    .map((l) => `<path d="${l.d}" fill="${l.fill ?? 'none'}"${l.stroke ? ` stroke="${l.stroke}" stroke-width="${l.width ?? 1}"` : ''} opacity="${l.alpha}"/>`)
    .join('');
  const ku =
    (d.mark.under ?? [])
      .map((u) => text('Ku', 30, d.mark.y, d.mark.size, 'none', ` stroke="${u.stroke}" stroke-width="${u.width}" stroke-linejoin="round" opacity="${u.alpha}"`))
      .join('') + text('Ku', 30, d.mark.y, d.mark.size, d.mark.fill);
  return (
    `<svg viewBox="0 0 60 90" width="${width}" height="${Math.round(width * 1.5)}" aria-hidden="true" focusable="false">` +
    `<defs><radialGradient id="kbg-${id}" gradientUnits="userSpaceOnUse" cx="30" cy="45" r="50"><stop offset="0" stop-color="${d.hi}"/><stop offset="1" stop-color="${d.lo}"/></radialGradient>` +
    `<clipPath id="kbc"><path d="${BACK_FIELD}"/></clipPath></defs>` +
    `<rect x=".3" y=".3" width="59.4" height="89.4" rx="6.8" fill="${CREAM}" stroke="#000" stroke-opacity=".25" stroke-width=".6"/>` +
    `<path d="${BACK_FIELD}" fill="url(#kbg-${id})"/><g clip-path="url(#kbc)">${layers}</g>` +
    ku +
    `</svg>`
  );
}

export const TABLE_HEX: Record<TableStyle, [string, string]> = {
  teal: ['#178079', '#0c4b47'],
  navy: ['#24497a', '#122641'],
  wine: ['#7a2b3c', '#3f1520'],
  charcoal: ['#3d454c', '#1e2328'],
  wood: ['#8a5a32', '#4a2e18'],
  sand: ['#d3b07a', '#9c7b48'],
};

export function tableSwatchSvg(s: TableStyle, w = 84, hh = 58): string {
  const [a, b] = TABLE_HEX[s];
  const id = `tg-${s}`;
  return (
    `<svg viewBox="0 0 84 58" width="${w}" height="${hh}" aria-hidden="true" focusable="false"><defs><radialGradient id="${id}" cx="50%" cy="45%" r="70%"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></radialGradient></defs>` +
    `<rect x="1" y="1" width="82" height="56" rx="10" fill="#2a1c12"/><rect x="5" y="5" width="74" height="48" rx="7" fill="url(#${id})"/>` +
    `<g transform="translate(36 17) scale(.27)"><rect x="1" y="1" width="58" height="88" rx="8" fill="#fff6e6"/></g></svg>`
  );
}

/** the KuCards logo mark: a small fan of three cards (the viewBox holds the turned corners of the side cards) */
export function logoFanSvg(size = 120): string {
  const c1 = cardSvg({ kind: 'number', color: 'mar', value: 7 }, { width: 60 });
  const c2 = cardSvg({ kind: 'number', color: 'coral', value: 3 }, { width: 60 });
  const c3 = cardSvg({ kind: 'number', color: 'sol', value: 0 }, { width: 60 });
  const inner = (s: string) => s.replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '');
  return (
    `<svg class="logo-fan" viewBox="-10 4 170 122" width="${size}" height="${Math.round((size * 122) / 170)}" overflow="visible" aria-hidden="true" focusable="false">` +
    `<g transform="translate(18 22) rotate(-16 30 90)">${inner(c1)}</g>` +
    `<g transform="translate(72 22) rotate(16 30 90)">${inner(c2)}</g>` +
    `<g transform="translate(45 10)">${inner(c3)}</g></svg>`
  );
}
