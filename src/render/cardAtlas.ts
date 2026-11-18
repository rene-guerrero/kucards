/**
 * Card faces, backs and table textures, all drawn on canvases with paths (no image assets).
 *
 * Every distinct face lives in ONE atlas texture (12×8 cells; 2048² on high, 1024² otherwise). A card
 * instance only carries its cell offset (see FaceMap / cellUv); the shader adds `uv * CELL_SU/SV`.
 * The mapping part is pure (unit-tested in node); the drawing functions need a DOM canvas.
 *
 * Look (our own): rounded ivory card, colour field, a round centre medallion holding the colour symbol
 * (sol = sun, mar = wave, palma = palm leaf, coral = shell) or the action glyph, and a big corner value
 * with the small colour symbol under it. Wild-type cards are dark with a four-colour medallion. Same
 * design as the HTML art in src/ui/cardArt.ts, drawn in the same 60×90 design space.
 */
import * as THREE from 'three';
import type { CardBack, CardFace, CardKind, Color, TableStyle } from '../contracts';

export const COLOR_HEX: Record<Color, string> = { sol: '#ffb627', mar: '#14a3a0', palma: '#4caf50', coral: '#ff6f61' };
export const CREAM = '#fff6e6';
const INK = '#13232e';
const WILD_FIELD = '#1d2f3b';
const COLORS: Color[] = ['sol', 'mar', 'palma', 'coral'];

// ───────────────────────── atlas mapping (pure) ─────────────────────────

export const ATLAS_COLS = 12;
export const ATLAS_ROWS = 8;
export const ATLAS_CELLS = ATLAS_COLS * ATLAS_ROWS;
/** inner card width as a fraction of the cell (the rest is an ivory gutter against mip bleeding) */
const INNER_W = 0.94;
export const CELL_SU = (INNER_W / ATLAS_COLS);
export const CELL_SV = (INNER_W / ATLAS_COLS) * 1.5;

const DEFAULT_DRAW: Partial<Record<CardKind, number>> = { draw2: 2, wild4: 4, draw6: 6, draw10: 10 };

/** identity of a face for the atlas (two cards with the same key look the same) */
export function faceKey(f: CardFace): string {
  const v = f.kind === 'number' ? String(f.value ?? 0) : '';
  const d = f.draw && f.draw !== DEFAULT_DRAW[f.kind] ? String(f.draw) : '';
  return `${f.kind}:${f.color ?? 'x'}:${v}:${d}`;
}

/** every face the decks can hold (classic + power cards + Ciclón + Eclipse), in atlas order (82 of 96 cells) */
export function baseFaces(): CardFace[] {
  const out: CardFace[] = [];
  for (const c of COLORS) {
    for (let v = 0; v <= 9; v++) out.push({ kind: 'number', color: c, value: v });
    out.push({ kind: 'skip', color: c }, { kind: 'reverse', color: c }, { kind: 'draw2', color: c, draw: 2 });
    out.push({ kind: 'shield', color: c }, { kind: 'sweep', color: c }, { kind: 'mirror', color: c }, { kind: 'flip', color: c });
  }
  out.push({ kind: 'wild', color: null }, { kind: 'wild4', color: null, draw: 4 }, { kind: 'swap', color: null }, { kind: 'flip', color: null });
  // Ciclón: coloured skipAll / +6, dark +10 and "draw until the colour"
  for (const c of COLORS) out.push({ kind: 'skipAll', color: c }, { kind: 'draw6', color: c, draw: 6 });
  out.push({ kind: 'draw10', color: null, draw: 10 }, { kind: 'wildColor', color: null });
  return out;
}

/** inner card rect of cell `i` in an atlas canvas of `size` px (y down) */
export function cellPx(i: number, size: number): { x: number; y: number; w: number; h: number } {
  const cw = size / ATLAS_COLS;
  const chh = size / ATLAS_ROWS;
  const col = i % ATLAS_COLS;
  const row = Math.floor(i / ATLAS_COLS);
  const w = cw * INNER_W;
  const h = w * 1.5;
  return { x: col * cw + (cw - w) / 2, y: row * chh + (chh - h) / 2, w, h };
}

/** uv of the inner card's bottom-left corner (textures are flipY: v = 1 at the canvas top) */
export function cellUv(i: number): { u0: number; v0: number } {
  const r = cellPx(i, 1);
  return { u0: r.x, v0: 1 - (r.y + r.h) };
}

/** face → atlas cell. Unknown faces (harsh-mode extras) get a free cell; `added` says it must be drawn. */
export class FaceMap {
  readonly faces: CardFace[] = [];
  private keys = new Map<string, number>();
  constructor() {
    for (const f of baseFaces()) this.add(f);
  }
  private add(f: CardFace): number {
    const i = this.faces.length;
    this.faces.push({ ...f });
    this.keys.set(faceKey(f), i);
    return i;
  }
  get size(): number {
    return this.faces.length;
  }
  lookup(f: CardFace): number {
    return this.keys.get(faceKey(f)) ?? -1;
  }
  /** cell for a face, adding it when there is room; falls back to the same kind/colour's base face */
  index(f: CardFace): { i: number; added: boolean } {
    const k = this.keys.get(faceKey(f));
    if (k !== undefined) return { i: k, added: false };
    if (this.faces.length < ATLAS_CELLS) return { i: this.add(f), added: true };
    const base = this.keys.get(faceKey({ kind: f.kind, color: f.color, value: f.value })) ?? 0;
    return { i: base, added: false };
  }
}

// ───────────────────────── drawing (DOM) ─────────────────────────

type G = CanvasRenderingContext2D;

const pathCache = new Map<string, Path2D>();
function P(d: string): Path2D {
  let p = pathCache.get(d);
  if (!p) {
    p = new Path2D(d);
    pathCache.set(d, p);
  }
  return p;
}

export function roundRect(g: G, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/** a colour symbol in a 24×24 box centred on (12, 12) of the current transform */
function drawSymbol(g: G, c: Color, fill: string, vein = CREAM): void {
  g.lineCap = 'round';
  g.lineJoin = 'round';
  switch (c) {
    case 'sol': {
      g.fillStyle = fill;
      g.beginPath();
      g.arc(12, 12, 5.2, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = fill;
      g.lineWidth = 2.2;
      g.beginPath();
      for (let i = 0; i < 8; i++) {
        const a = (i * Math.PI) / 4;
        g.moveTo(12 + Math.cos(a) * 7.4, 12 + Math.sin(a) * 7.4);
        g.lineTo(12 + Math.cos(a) * 10.6, 12 + Math.sin(a) * 10.6);
      }
      g.stroke();
      break;
    }
    case 'mar':
      g.strokeStyle = fill;
      g.lineWidth = 2.6;
      g.stroke(P('M2 9.5q2.5-3 5 0t5 0 5 0 5 0M2 15.5q2.5-3 5 0t5 0 5 0 5 0'));
      break;
    case 'palma':
      g.fillStyle = fill;
      g.fill(P('M12 2.5C17.5 6 18.5 14 12 21.5 5.5 14 6.5 6 12 2.5z'));
      g.strokeStyle = vein;
      g.globalAlpha *= 0.85;
      g.lineWidth = 1.2;
      g.stroke(P('M12 6v14M12 10l-3-2.2M12 10l3-2.2M12 14l-3.6-2.4M12 14l3.6-2.4'));
      g.globalAlpha /= 0.85;
      break;
    case 'coral':
      g.fillStyle = fill;
      g.fill(P('M12 20.5 3.2 10.4a9.6 9.6 0 0 1 17.6 0z'));
      roundRect(g, 9.6, 19.4, 4.8, 2.6, 1);
      g.fill();
      g.strokeStyle = vein;
      g.globalAlpha *= 0.85;
      g.lineWidth = 1.1;
      g.stroke(P('M12 20.5 7 7.4M12 20.5 12 5.6M12 20.5 17 7.4M12 20.5 4.6 9.6M12 20.5l7.4-10.9'));
      g.globalAlpha /= 0.85;
      break;
  }
}

/** action glyphs, 24×24 box (stroke `col`); returns false when the kind has no glyph */
function drawGlyph(g: G, kind: CardKind, col: string): boolean {
  g.strokeStyle = col;
  g.fillStyle = col;
  g.lineWidth = 2.6;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  switch (kind) {
    case 'skip':
      g.beginPath();
      g.arc(12, 12, 7.6, 0, Math.PI * 2);
      g.stroke();
      g.stroke(P('M6.8 17.2 17.2 6.8'));
      return true;
    case 'reverse':
      g.stroke(P('M5 9h11l-3-3M19 15H8l3 3'));
      return true;
    case 'shield':
      g.stroke(P('M12 3.5 19 6v5.5c0 4.5-3 7.6-7 9-4-1.4-7-4.5-7-9V6z'));
      g.lineWidth = 2;
      g.stroke(P('M8.6 12l2.4 2.4 4.4-4.6'));
      return true;
    case 'mirror':
      g.stroke(P('M12 3v18M8 7 4 12l4 5M16 7l4 5-4 5'));
      return true;
    case 'sweep':
      g.stroke(P('M15 3.5 9.5 13M6 13.5h8l-1.5 7H7.5z'));
      return true;
    case 'swap':
      g.stroke(P('M4 8h14l-3-3M20 16H6l3 3'));
      g.beginPath();
      g.arc(12, 12, 1.6, 0, Math.PI * 2);
      g.fill();
      return true;
    case 'flip':
      g.beginPath();
      g.arc(12, 12, 8, 0, Math.PI * 2);
      g.stroke();
      g.fill(P('M12 4a8 8 0 0 1 0 16z'));
      return true;
    case 'skipAll':
      // a ring of four short bars around a centre dot: everybody stops
      g.beginPath();
      g.arc(12, 12, 8.4, 0, Math.PI * 2);
      g.stroke();
      g.lineWidth = 2.2;
      g.stroke(P('M12 5.6v3M12 15.4v3M5.6 12h3M15.4 12h3'));
      g.beginPath();
      g.arc(12, 12, 1.8, 0, Math.PI * 2);
      g.fill();
      return true;
    case 'wildColor':
      // a drop falling into a cup of stacked lines: draw until the colour comes
      g.fill(P('M12 2.6c2.6 3.4 3.9 5.5 3.9 7.2a3.9 3.9 0 0 1-7.8 0c0-1.7 1.3-3.8 3.9-7.2z'));
      g.lineWidth = 2;
      g.stroke(P('M5 15.5h14M6.5 18.6h11M8 21.6h8'));
      return true;
    default:
      return false;
  }
}

const KIND_DRAW_TEXT: Partial<Record<CardKind, string>> = { draw2: '+2', wild4: '+4', draw6: '+6', draw10: '+10' };
const cornerText = (f: CardFace): string =>
  f.kind === 'number' ? String(f.value ?? 0) : f.draw && f.draw !== DEFAULT_DRAW[f.kind] ? `+${f.draw}` : KIND_DRAW_TEXT[f.kind] ?? (f.draw ? `+${f.draw}` : '');

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

function fourColourDisc(g: G, cx: number, cy: number, r: number): void {
  const order: Color[] = ['coral', 'sol', 'mar', 'palma'];
  for (let q = 0; q < 4; q++) {
    g.fillStyle = COLOR_HEX[order[q]];
    g.beginPath();
    g.moveTo(cx, cy);
    g.arc(cx, cy, r, -Math.PI / 2 + (q - 1) * (Math.PI / 2), -Math.PI / 2 + q * (Math.PI / 2));
    g.closePath();
    g.fill();
  }
}

/** draw one face into (x, y, w, h); w:h = 2:3 (60×90 design space) */
export function drawFace(g: G, f: CardFace, x: number, y: number, w: number): void {
  const s = w / 60;
  g.save();
  g.translate(x, y);
  g.scale(s, s);
  const c = f.color;
  const field = c ? COLOR_HEX[c] : WILD_FIELD;
  // ivory card + colour field (the ivory gutter around the cell is filled by the caller)
  g.fillStyle = CREAM;
  roundRect(g, 0, 0, 60, 90, 7);
  g.fill();
  g.fillStyle = field;
  roundRect(g, 3.4, 3.4, 53.2, 83.2, 5.6);
  g.fill();
  // a soft inner light so the field is not flat
  const grad = g.createRadialGradient(30, 36, 4, 30, 45, 52);
  grad.addColorStop(0, 'rgba(255,255,255,0.18)');
  grad.addColorStop(1, 'rgba(0,0,0,0.16)');
  g.fillStyle = grad;
  roundRect(g, 3.4, 3.4, 53.2, 83.2, 5.6);
  g.fill();
  if (!c) {
    // wild-type: thin woven lines in the four colours
    g.globalAlpha = 0.22;
    g.lineWidth = 1.2;
    for (let i = 0; i < 4; i++) {
      g.strokeStyle = COLOR_HEX[COLORS[i]];
      g.beginPath();
      g.moveTo(3.4, 12 + i * 20);
      g.lineTo(56.6, 30 + i * 20);
      g.stroke();
    }
    g.globalAlpha = 1;
  }
  // centre medallion (a plain circle; nothing tilted)
  g.fillStyle = CREAM;
  g.beginPath();
  g.arc(30, 45, 16.5, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = 'rgba(0,0,0,0.18)';
  g.lineWidth = 0.8;
  g.stroke();
  if (!c) {
    fourColourDisc(g, 30, 45, 14.6);
    if (f.kind !== 'wild') {
      g.fillStyle = CREAM;
      g.beginPath();
      g.arc(30, 45, 9.2, 0, Math.PI * 2);
      g.fill();
      if (f.kind === 'swap' || f.kind === 'flip' || f.kind === 'wildColor') {
        g.save();
        g.translate(21, 36);
        g.scale(0.75, 0.75);
        drawGlyph(g, f.kind, INK);
        g.restore();
      } else {
        g.fillStyle = INK;
        const t = cornerText(f);
        g.font = `900 ${t.length > 2 ? 9 : 11}px ${FONT}`;
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText(t, 30, 45.6);
        if (f.kind === 'draw10') {
          // the +10 carries a thin storm ring so it never reads as a +4 at a glance
          g.strokeStyle = CREAM;
          g.lineWidth = 1.4;
          g.setLineDash([3, 2.2]);
          g.beginPath();
          g.arc(30, 45, 16.2, 0, Math.PI * 2);
          g.stroke();
          g.setLineDash([]);
        }
      }
    }
  } else {
    g.save();
    g.translate(18, 33);
    if (f.kind === 'number') {
      g.translate(-1, -1);
      g.scale(1.08, 1.08);
      drawSymbol(g, c, field);
    } else if (!drawGlyph(g, f.kind, field)) {
      g.restore();
      g.save();
      g.fillStyle = field;
      g.font = `900 16px ${FONT}`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(cornerText(f), 30, 46);
    }
    g.restore();
  }
  // corners: big value (or glyph), the small colour symbol under it; mirrored bottom-right
  const corner = cornerText(f);
  for (let k = 0; k < 2; k++) {
    g.save();
    if (k === 1) {
      g.translate(60, 90);
      g.rotate(Math.PI);
    }
    if (corner) {
      g.font = `900 ${corner.length > 2 ? 11 : corner.length > 1 ? 14 : 17}px ${FONT}`;
      g.textAlign = 'center';
      g.textBaseline = 'alphabetic';
      g.lineJoin = 'round';
      g.lineWidth = 2.2;
      g.strokeStyle = INK;
      g.strokeText(corner, 11.5, 19.5);
      g.fillStyle = CREAM;
      g.fillText(corner, 11.5, 19.5);
    } else if (f.kind === 'wild') {
      fourColourDisc(g, 11.5, 13, 5.6);
      g.strokeStyle = CREAM;
      g.lineWidth = 1;
      g.beginPath();
      g.arc(11.5, 13, 5.6, 0, Math.PI * 2);
      g.stroke();
    } else {
      g.save();
      g.translate(4.3, 5.6);
      g.scale(0.6, 0.6);
      drawGlyph(g, f.kind, CREAM);
      g.restore();
    }
    if (c) {
      g.save();
      g.translate(6.5, 22.5);
      g.scale(0.42, 0.42);
      drawSymbol(g, c, CREAM, field);
      g.restore();
    }
    g.restore();
  }
  g.restore();
}

export interface AtlasCanvas {
  canvas: HTMLCanvasElement;
  size: number;
}

/** draw the whole atlas (ivory background = gutter colour) */
export function drawAtlas(size: number, map: FaceMap): AtlasCanvas {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d')!;
  g.fillStyle = CREAM;
  g.fillRect(0, 0, size, size);
  for (let i = 0; i < map.size; i++) drawCell(g, size, i, map.faces[i]);
  return { canvas, size };
}

export function drawCell(g: G, size: number, i: number, f: CardFace): void {
  const r = cellPx(i, size);
  drawFace(g, f, r.x, r.y, r.w);
}

export function makeTexture(c: HTMLCanvasElement, mip = true): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.generateMipmaps = mip;
  t.minFilter = mip ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  return t;
}

// ───────────────────────── backs ─────────────────────────

const BACKS: Record<CardBack, { bg: string; fg: string }> = {
  ku: { bg: '#163a46', fg: '#ffb627' },
  weave: { bg: '#14a3a0', fg: '#0e6e6c' },
  sun: { bg: '#ffb627', fg: '#c77d00' },
  night: { bg: '#1b2b55', fg: '#ffe7a8' },
};

/** a card back (w × 1.5w px, 60×90 design space). Every back carries the "Ku" mark. */
export function drawBack(b: CardBack, w = 256): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = Math.round(w * 1.5);
  const g = canvas.getContext('2d')!;
  const d = BACKS[b] ?? BACKS.ku;
  g.fillStyle = CREAM;
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.scale(w / 60, w / 60);
  g.fillStyle = d.bg;
  roundRect(g, 3.4, 3.4, 53.2, 83.2, 5.6);
  g.fill();
  g.save();
  roundRect(g, 3.4, 3.4, 53.2, 83.2, 5.6);
  g.clip();
  g.lineCap = 'round';
  if (b === 'weave') {
    g.strokeStyle = d.fg;
    g.lineWidth = 3;
    for (let k = -90; k < 90; k += 12) {
      g.beginPath();
      g.moveTo(k, 0);
      g.lineTo(k + 90, 90);
      g.moveTo(k + 60, 0);
      g.lineTo(k - 30, 90);
      g.stroke();
    }
  } else if (b === 'ku') {
    // woven diamonds
    g.strokeStyle = 'rgba(255,182,39,0.22)';
    g.lineWidth = 1;
    for (let k = -90; k < 150; k += 7) {
      g.beginPath();
      g.moveTo(k, 0);
      g.lineTo(k - 60, 90);
      g.moveTo(k - 60, 0);
      g.lineTo(k, 90);
      g.stroke();
    }
  } else if (b === 'sun') {
    g.strokeStyle = 'rgba(255,255,255,0.28)';
    g.lineWidth = 2.4;
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      g.beginPath();
      g.moveTo(30 + Math.cos(a) * 14, 45 + Math.sin(a) * 14);
      g.lineTo(30 + Math.cos(a) * 60, 45 + Math.sin(a) * 60);
      g.stroke();
    }
  } else {
    g.fillStyle = d.fg;
    const stars = [[14, 16, 1.3], [46, 14, 1], [44, 74, 1.2], [16, 70, 1], [50, 40, 0.8], [10, 46, 0.8], [26, 10, 0.7], [36, 82, 0.7]];
    for (const [sx, sy, r] of stars) {
      g.beginPath();
      g.arc(sx, sy, r, 0, Math.PI * 2);
      g.fill();
    }
    g.fill(P('M36 22a12 12 0 1 0 6 21 10 10 0 1 1-6-21z'));
  }
  g.restore();
  g.strokeStyle = d.fg;
  g.globalAlpha = 0.7;
  g.lineWidth = 1.6;
  roundRect(g, 7.5, 7.5, 45, 75, 4);
  g.stroke();
  g.globalAlpha = 1;
  // the "Ku" mark in a medallion
  const mark = b === 'ku' ? d.fg : b === 'night' ? '#1b2b55' : b === 'sun' ? '#c77d00' : '#0e6e6c';
  g.fillStyle = b === 'ku' ? 'rgba(0,0,0,0.25)' : b === 'night' ? '#ffe7a8' : CREAM;
  g.beginPath();
  g.arc(30, b === 'night' ? 58 : 45, 12, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = mark;
  g.font = `900 13px ${FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('Ku', 30, (b === 'night' ? 58 : 45) + 0.8);
  return canvas;
}

// ───────────────────────── table + effects ─────────────────────────

export interface TableStyleDef {
  felt: [string, string];
  rim: string;
  bg: string;
}

export const TABLE_STYLE_DEFS: Record<TableStyle, TableStyleDef> = {
  teal: { felt: ['#178079', '#0c4b47'], rim: '#2a1c12', bg: '#0b1d24' },
  navy: { felt: ['#24497a', '#122641'], rim: '#1a1410', bg: '#0a1220' },
  wine: { felt: ['#7a2b3c', '#3f1520'], rim: '#24130d', bg: '#180b10' },
  charcoal: { felt: ['#3d454c', '#1e2328'], rim: '#141414', bg: '#0e1013' },
  wood: { felt: ['#8a5a32', '#4a2e18'], rim: '#24160b', bg: '#160e08' },
  sand: { felt: ['#d3b07a', '#9c7b48'], rim: '#4a3420', bg: '#2a2014' },
};

/** a soft team glow on the felt (Parejas); u, v in 0..1 over the felt (v down = towards the viewer), r as a fraction of the short side */
export interface FeltTint {
  u: number;
  v: number;
  r: number;
  color: string;
}

/** felt top: rounded table with a rim, the outside painted in the scene background colour */
export function drawFelt(style: TableStyle, aspect: number, longest: number, tints: readonly FeltTint[] = []): HTMLCanvasElement {
  const S = TABLE_STYLE_DEFS[style] ?? TABLE_STYLE_DEFS.teal;
  const w = aspect >= 1 ? longest : Math.round(longest * aspect);
  const h = aspect >= 1 ? Math.round(longest / aspect) : longest;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  g.fillStyle = S.bg;
  g.fillRect(0, 0, w, h);
  const u = Math.min(w, h);
  const rim = u * 0.035;
  const r = u * 0.14;
  g.fillStyle = S.rim;
  roundRect(g, 0, 0, w, h, r);
  g.fill();
  const grad = g.createRadialGradient(w / 2, h * 0.46, u * 0.05, w / 2, h / 2, Math.max(w, h) * 0.62);
  grad.addColorStop(0, S.felt[0]);
  grad.addColorStop(1, S.felt[1]);
  g.fillStyle = grad;
  roundRect(g, rim, rim, w - 2 * rim, h - 2 * rim, r - rim);
  g.fill();
  if (style === 'wood') {
    g.save();
    roundRect(g, rim, rim, w - 2 * rim, h - 2 * rim, r - rim);
    g.clip();
    g.strokeStyle = 'rgba(0,0,0,0.12)';
    g.lineWidth = Math.max(1, u * 0.004);
    for (let y = 0; y < h; y += u * 0.035) {
      g.beginPath();
      g.moveTo(0, y);
      for (let x = 0; x <= w; x += u * 0.1) g.lineTo(x, y + Math.sin(x * 0.02 + y) * u * 0.008);
      g.stroke();
    }
    g.restore();
  } else {
    // felt speckle (fixed seed so redraws match)
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    g.fillStyle = 'rgba(255,255,255,0.035)';
    const n = Math.round((w * h) / 90);
    for (let i = 0; i < n; i++) g.fillRect(rnd() * w, rnd() * h, 1.2, 1.2);
    g.fillStyle = 'rgba(0,0,0,0.05)';
    for (let i = 0; i < n; i++) g.fillRect(rnd() * w, rnd() * h, 1.2, 1.2);
  }
  // team tints behind each seat: soft radial glows, baked in (no extra draw call)
  if (tints.length) {
    g.save();
    roundRect(g, rim, rim, w - 2 * rim, h - 2 * rim, r - rim);
    g.clip();
    g.globalCompositeOperation = 'source-over';
    for (const t of tints) {
      const cx = t.u * w;
      const cy = t.v * h;
      const R = t.r * u;
      const gr = g.createRadialGradient(cx, cy, 0, cx, cy, R);
      gr.addColorStop(0, hexA(t.color, 0.3));
      gr.addColorStop(0.55, hexA(t.color, 0.13));
      gr.addColorStop(1, hexA(t.color, 0));
      g.fillStyle = gr;
      g.fillRect(cx - R, cy - R, 2 * R, 2 * R);
    }
    g.restore();
  }
  // a thin inlaid line
  g.strokeStyle = 'rgba(255,246,230,0.13)';
  g.lineWidth = Math.max(1, u * 0.006);
  roundRect(g, rim * 2.4, rim * 2.4, w - rim * 4.8, h - rim * 4.8, r - rim * 2);
  g.stroke();
  return c;
}

/** soft white ring (alpha) for the active-colour glow; tinted by the material colour */
export function drawGlowRing(size = 128): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(255,255,255,0)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0.05)');
  grad.addColorStop(0.7, 'rgba(255,255,255,0.85)');
  grad.addColorStop(0.8, 'rgba(255,255,255,0.5)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return c;
}

/** direction ring: a thin circle with chevrons pointing clockwise (seen from above) */
export function drawDirRing(size = 512): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const cx = size / 2;
  const R = size * 0.44;
  g.strokeStyle = 'rgba(255,246,230,0.9)';
  g.lineWidth = size * 0.012;
  g.setLineDash([size * 0.05, size * 0.03]);
  g.beginPath();
  g.arc(cx, cx, R, 0, Math.PI * 2);
  g.stroke();
  g.setLineDash([]);
  g.fillStyle = 'rgba(255,246,230,0.95)';
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    g.save();
    g.translate(cx + Math.cos(a) * R, cx + Math.sin(a) * R);
    g.rotate(a + Math.PI / 2); // tangent, clockwise in canvas space
    const k = size * 0.035;
    g.beginPath();
    g.moveTo(k * 1.3, 0);
    g.lineTo(-k, -k);
    g.lineTo(-k * 0.4, 0);
    g.lineTo(-k, k);
    g.closePath();
    g.fill();
    g.restore();
  }
  return c;
}

/** deck / pile edge: ivory with thin grey card lines */
export function drawEdge(size = 64): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  g.fillStyle = '#efe4d0';
  g.fillRect(0, 0, size, size);
  g.fillStyle = 'rgba(60,50,40,0.35)';
  for (let y = 0; y < size; y += 4) g.fillRect(0, y, size, 1);
  return c;
}

export type StampKind = 'skip' | 'shield' | 'caught' | 'out';

/** a round stamp (skip / shield / caught / eliminated) on a transparent canvas */
export function drawStamp(g: G, size: number, kind: StampKind): void {
  g.clearRect(0, 0, size, size);
  const col = kind === 'shield' ? '#5fd0ff' : kind === 'caught' ? '#ffb627' : '#ff4d4d';
  const cx = size / 2;
  g.save();
  g.fillStyle = 'rgba(19,35,46,0.82)';
  g.beginPath();
  g.arc(cx, cx, size * 0.46, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = col;
  g.lineWidth = size * 0.05;
  g.stroke();
  g.translate(cx - size * 0.3, cx - size * 0.3);
  g.scale(size * 0.025, size * 0.025);
  if (kind === 'skip' || kind === 'out') drawGlyph(g, 'skip', col);
  else if (kind === 'shield') drawGlyph(g, 'shield', col);
  else {
    g.fillStyle = col;
    g.font = `900 13px ${FONT}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('¡Ku!', 12, 12.5);
  }
  g.restore();
}

function hexA(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** mirror flash: a bright soft disc crossed by two diagonal glints (alpha, additive) */
export function drawFlash(size = 128): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const m = size / 2;
  const gr = g.createRadialGradient(m, m, 0, m, m, m);
  gr.addColorStop(0, 'rgba(230,250,255,0.95)');
  gr.addColorStop(0.3, 'rgba(150,225,255,0.45)');
  gr.addColorStop(1, 'rgba(150,225,255,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, size, size);
  g.strokeStyle = 'rgba(255,255,255,0.9)';
  g.lineCap = 'round';
  for (const [k, lw] of [[0.18, size * 0.05], [0.42, size * 0.025]] as const) {
    g.lineWidth = lw;
    g.beginPath();
    g.moveTo(size * (0.12 + k), size * 0.88);
    g.lineTo(size * (0.48 + k), size * 0.12);
    g.stroke();
  }
  return c;
}

/** "+N" pill for the stacked penalty */
export function drawBadge(g: G, w: number, h: number, text: string, fill = '#ff4d4d'): void {
  g.clearRect(0, 0, w, h);
  g.fillStyle = fill;
  roundRect(g, 3, 3, w - 6, h - 6, (h - 6) / 2);
  g.fill();
  g.lineWidth = 4;
  g.strokeStyle = CREAM;
  g.stroke();
  g.fillStyle = CREAM;
  g.font = `900 ${Math.round(h * 0.56)}px ${FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, w / 2, h / 2 + 2);
}
