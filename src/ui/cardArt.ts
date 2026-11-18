/**
 * Small SVG card art for the HTML layer (logo, how-to, colour picker, settings swatches). Same style as
 * the 3D cards: a rounded card, a colour field, a centre medallion with the colour symbol (every colour
 * has its own symbol, so colour-blind players can read it) and a corner numeral.
 */
import type { CardBack, CardFace, CardKind, Color, TableStyle } from '../contracts';

export const COLOR_HEX: Record<Color, string> = { sol: '#ffb627', mar: '#14a3a0', palma: '#4caf50', coral: '#ff6f61' };
const CREAM = '#fff6e6';
const INK = '#13232e';
const WILD_FIELD = '#1d2f3b';

/** colour symbols, drawn in a 24×24 box centred on (12,12), filled with `fill` */
export function symbolMarkup(c: Color, fill: string): string {
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
      return `<path d="M12 2.5C17.5 6 18.5 14 12 21.5 5.5 14 6.5 6 12 2.5z" fill="${fill}"/><path d="M12 6v14M12 10l-3-2.2M12 10l3-2.2M12 14l-3.6-2.4M12 14l3.6-2.4" stroke="${CREAM}" stroke-width="1.2" stroke-linecap="round" opacity=".85"/>`;
    case 'coral':
      return `<path d="M12 20.5 3.2 10.4a9.6 9.6 0 0 1 17.6 0z" fill="${fill}"/><path d="M12 20.5 7 7.4M12 20.5 12 5.6M12 20.5 17 7.4M12 20.5 4.6 9.6M12 20.5l7.4-10.9" stroke="${CREAM}" stroke-width="1.1" stroke-linecap="round" opacity=".85"/><rect x="9.6" y="19.4" width="4.8" height="2.6" rx="1" fill="${fill}"/>`;
  }
}

export function symbolSvg(c: Color, size = 24, fill = COLOR_HEX[c]): string {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" focusable="false">${symbolMarkup(c, fill)}</svg>`;
}

/** action glyphs in the same 24×24 box (stroke `col`) */
function glyph(kind: CardKind, col: string): string {
  const st = `fill="none" stroke="${col}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"`;
  switch (kind) {
    case 'skip':
      return `<circle cx="12" cy="12" r="7.6" ${st}/><path d="M6.8 17.2 17.2 6.8" ${st}/>`;
    case 'reverse':
      return `<path d="M5 9h11l-3-3M19 15H8l3 3" ${st}/>`;
    case 'shield':
      return `<path d="M12 3.5 19 6v5.5c0 4.5-3 7.6-7 9-4-1.4-7-4.5-7-9V6z" ${st}/>`;
    case 'mirror':
      return `<path d="M12 3v18M8 7 4 12l4 5M16 7l4 5-4 5" ${st}/>`;
    case 'sweep':
      return `<path d="M15 3.5 9.5 13M6 13.5h8l-1.5 7H7.5z" ${st}/>`;
    case 'swap':
      return `<path d="M4 8h14l-3-3M20 16H6l3 3" ${st}/><circle cx="12" cy="12" r="1.6" fill="${col}"/>`;
    case 'skipAll':
      return `<circle cx="12" cy="12" r="8.4" ${st}/><path d="M12 5.6v3M12 15.4v3M5.6 12h3M15.4 12h3" ${st.replace('2.6', '2.2')}/><circle cx="12" cy="12" r="1.8" fill="${col}"/>`;
    case 'wildColor':
      return `<path d="M12 2.6c2.6 3.4 3.9 5.5 3.9 7.2a3.9 3.9 0 0 1-7.8 0c0-1.7 1.3-3.8 3.9-7.2z" fill="${col}"/><path d="M5 15.5h14M6.5 18.6h11M8 21.6h8" ${st.replace('2.6', '2')}/>`;
    default:
      return '';
  }
}

const cornerText = (f: CardFace): string =>
  f.kind === 'number' ? String(f.value ?? 0) : f.kind === 'draw2' ? '+2' : f.kind === 'wild4' ? '+4' : f.draw ? `+${f.draw}` : '';

/** A whole card face as SVG (60×90 viewBox). */
export function cardSvg(f: CardFace, opts: { width?: number; cls?: string; rotate?: number } = {}): string {
  const w = opts.width ?? 48;
  const hgt = Math.round(w * 1.5);
  const c = f.color;
  const field = c ? COLOR_HEX[c] : WILD_FIELD;
  const wild = !c;
  let medal = '';
  if (wild) {
    // a medallion split in the four colours
    medal =
      `<circle cx="30" cy="45" r="16" fill="${CREAM}"/>` +
      `<path d="M30 45V30A15 15 0 0 1 45 45z" fill="${COLOR_HEX.sol}"/><path d="M30 45h15A15 15 0 0 1 30 60z" fill="${COLOR_HEX.mar}"/>` +
      `<path d="M30 45v15A15 15 0 0 1 15 45z" fill="${COLOR_HEX.palma}"/><path d="M30 45H15A15 15 0 0 1 30 30z" fill="${COLOR_HEX.coral}"/>` +
      (f.kind === 'swap' || f.kind === 'wildColor' ? `<g transform="translate(19 34) scale(.92)">${glyph(f.kind, CREAM)}</g>` : '');
  } else {
    const g = glyph(f.kind, field);
    medal = `<circle cx="30" cy="45" r="16" fill="${CREAM}"/>`;
    if (g) medal += `<g transform="translate(18 33)">${g}</g>`;
    else if (f.kind === 'draw2' || (f.draw ?? 0) > 0) medal += `<text x="30" y="51.5" text-anchor="middle" font-size="17" font-weight="900" fill="${field}">${cornerText(f)}</text>`;
    else medal += `<g transform="translate(19 32) scale(1.08)">${symbolMarkup(c, field)}</g>`;
  }
  const corner = cornerText(f);
  const small = c ? `<g transform="translate(43.5 6) scale(.5)">${symbolMarkup(c, CREAM)}</g>` : '';
  const cornerG = corner
    ? `<text x="9" y="18" font-size="13" font-weight="900" fill="${CREAM}" stroke="${INK}" stroke-width=".8" paint-order="stroke">${corner}</text>` +
      `<text x="51" y="72" font-size="13" font-weight="900" fill="${CREAM}" stroke="${INK}" stroke-width=".8" paint-order="stroke" transform="rotate(180 51 72) translate(0 -1)" text-anchor="start">${corner}</text>`
    : f.kind !== 'number' && c
      ? `<g transform="translate(5 5) scale(.5)">${glyph(f.kind, CREAM)}</g>`
      : '';
  const rot = opts.rotate ? ` style="transform:rotate(${opts.rotate}deg)"` : '';
  return (
    `<svg class="kc-card ${opts.cls ?? ''}" viewBox="0 0 60 90" width="${w}" height="${hgt}" aria-hidden="true" focusable="false"${rot}>` +
    `<rect x="1" y="1" width="58" height="88" rx="8" fill="${CREAM}" stroke="rgba(0,0,0,.25)" stroke-width="1"/>` +
    `<rect x="4" y="4" width="52" height="82" rx="6" fill="${field}"/>` +
    medal +
    cornerG +
    small +
    `</svg>`
  );
}

const BACKS: Record<CardBack, { bg: string; fg: string; art: string }> = {
  ku: { bg: '#163a46', fg: '#ffb627', art: '<text x="30" y="52" text-anchor="middle" font-size="20" font-weight="900" fill="#ffb627">Ku</text>' },
  weave: {
    bg: '#14a3a0',
    fg: '#0e6e6c',
    art: '<path d="M4 10l52 52M4 30l32 32M4 50l12 12M24 4l32 32M44 4l12 12M56 10L4 62M56 30L24 62M56 50l-12 12M36 4L4 36M16 4 4 16" stroke="#0e6e6c" stroke-width="3"/>' +
      '<circle cx="30" cy="45" r="11" fill="#fff6e6"/><text x="30" y="49.5" text-anchor="middle" font-size="11" font-weight="900" fill="#0e6e6c">Ku</text>',
  },
  sun: { bg: '#ffb627', fg: '#c77d00', art: '' },
  night: {
    bg: '#1b2b55',
    fg: '#ffe7a8',
    art: '<path d="M36 30a12 12 0 1 0 6 21 10 10 0 1 1-6-21z" fill="#ffe7a8"/><circle cx="16" cy="20" r="1.4" fill="#ffe7a8"/><circle cx="44" cy="72" r="1.2" fill="#ffe7a8"/><circle cx="18" cy="68" r="1" fill="#ffe7a8"/><circle cx="46" cy="16" r="1" fill="#ffe7a8"/>',
  },
};

export function cardBackSvg(b: CardBack, width = 34): string {
  const d = BACKS[b];
  const art = b === 'sun' ? `<g transform="translate(13 28) scale(1.42)">${symbolMarkup('sol', '#fff6e6')}</g>` : d.art;
  return (
    `<svg viewBox="0 0 60 90" width="${width}" height="${Math.round(width * 1.5)}" aria-hidden="true" focusable="false">` +
    `<rect x="1" y="1" width="58" height="88" rx="8" fill="#fff6e6"/><rect x="4" y="4" width="52" height="82" rx="6" fill="${d.bg}"/>` +
    `<rect x="8" y="8" width="44" height="74" rx="4" fill="none" stroke="${d.fg}" stroke-width="1.6" opacity=".7"/>${art}</svg>`
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

/** the KuCards logo mark: a small fan of three cards */
export function logoFanSvg(size = 120): string {
  const c1 = cardSvg({ kind: 'number', color: 'mar', value: 7 }, { width: 60 });
  const c2 = cardSvg({ kind: 'number', color: 'coral', value: 3 }, { width: 60 });
  const c3 = cardSvg({ kind: 'number', color: 'sol', value: 0 }, { width: 60 });
  const inner = (s: string) => s.replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '');
  return (
    `<svg class="logo-fan" viewBox="0 0 150 120" width="${size}" height="${Math.round(size * 0.8)}" aria-hidden="true" focusable="false">` +
    `<g transform="translate(18 22) rotate(-16 30 90)">${inner(c1)}</g>` +
    `<g transform="translate(72 22) rotate(16 30 90)">${inner(c2)}</g>` +
    `<g transform="translate(45 10)">${inner(c3)}</g></svg>`
  );
}
