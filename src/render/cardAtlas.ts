/**
 * Card faces, backs and table textures, all drawn on canvases with paths (no image assets).
 *
 * Every distinct face lives in ONE atlas texture (13×9 cells; 2048² on high, 1024² otherwise). A card
 * instance only carries its cell offset (see FaceMap / cellUv); the shader adds `uv * CELL_SU/SV`.
 * The mapping part is pure (unit-tested in node); the drawing functions need a DOM canvas.
 *
 * Look (our own): rounded ivory card, colour field, a round centre medallion holding the colour symbol
 * (sol = sun, mar = wave, palma = palm leaf, coral = shell) or the action glyph, and a big corner index. Wild-type cards are black with a four-colour medallion; once
 * played, the pile shows the same design on the chosen colour (a `tint` variant cell). Same design as
 * the HTML art in src/ui/cardArt.ts, drawn in the same 60×90 design space.
 */
import * as THREE from 'three';
import type { CardBack, CardFace, CardKind, Color, TableStyle } from '../contracts';
import { BACK_FIELD, backDesign } from './cardBacks';

/** the four card colours: one hue each and four clearly different lightness steps (sol lightest, mar darkest) */
export const COLOR_HEX: Record<Color, string> = { sol: '#f7b417', mar: '#0c7489', palma: '#4db33d', coral: '#e04a3f' };
/** a deep shade of each colour, for the marks on the ivory capsule (plain yellow would wash out there) */
export const COLOR_DEEP: Record<Color, string> = { sol: '#b86e00', mar: '#0a5d6f', palma: '#2f8a26', coral: '#bf2f2c' };
/** a bright, light-like version of each colour, for glows and arrows on the felt */
export const COLOR_GLOW: Record<Color, string> = { sol: '#ffcb45', mar: '#35c6de', palma: '#74db55', coral: '#ff6b5c' };
export const CREAM = '#fff6e6';
const INK = '#13232e';
const WILD_FIELD = '#0b0b0d';
const COLORS: Color[] = ['sol', 'mar', 'palma', 'coral'];

// ───────────────────────── atlas mapping (pure) ─────────────────────────

export const ATLAS_COLS = 13;
export const ATLAS_ROWS = 9;
export const ATLAS_CELLS = ATLAS_COLS * ATLAS_ROWS;
/** inner card width as a fraction of the cell (the rest is an ivory gutter against mip bleeding) */
const INNER_W = 0.94;
export const CELL_SU = (INNER_W / ATLAS_COLS);
export const CELL_SV = (INNER_W / ATLAS_COLS) * 1.5;

const DEFAULT_DRAW: Partial<Record<CardKind, number>> = { draw2: 2, wild4: 4, draw6: 6, draw10: 10 };

/** an atlas face: a card face, plus the colour chosen for a played wild-type card (its field colour) */
export type AtlasFace = CardFace & { tint?: Color };

/** wild-type kinds whose player picks a colour (the played card takes it as its field) */
export const TINTABLE: readonly CardKind[] = ['wild', 'wild4', 'swap', 'draw10', 'wildColor'];

/** the face to show for a card on the pile: wild-type cards take the chosen colour, others stay as they are */
export function playedFace(f: CardFace, chosen: Color | null | undefined): AtlasFace {
  return chosen && f.color === null && TINTABLE.includes(f.kind) ? { ...f, tint: chosen } : f;
}

/** identity of a face for the atlas (two cards with the same key look the same) */
export function faceKey(f: AtlasFace): string {
  const v = f.kind === 'number' ? String(f.value ?? 0) : '';
  const d = f.draw && f.draw !== DEFAULT_DRAW[f.kind] ? String(f.draw) : '';
  return `${f.kind}:${f.color ?? 'x'}:${v}:${d}${f.tint && f.color === null ? `@${f.tint}` : ''}`;
}

/** every face the decks can hold (classic + power cards + Ciclón + Eclipse) and the played wild-type
 *  variants in the four colours, in atlas order (102 of 117 cells) */
export function baseFaces(): AtlasFace[] {
  const out: AtlasFace[] = [];
  for (const c of COLORS) {
    for (let v = 0; v <= 9; v++) out.push({ kind: 'number', color: c, value: v });
    out.push({ kind: 'skip', color: c }, { kind: 'reverse', color: c }, { kind: 'draw2', color: c, draw: 2 });
    out.push({ kind: 'shield', color: c }, { kind: 'sweep', color: c }, { kind: 'mirror', color: c }, { kind: 'flip', color: c });
  }
  out.push({ kind: 'wild', color: null }, { kind: 'wild4', color: null, draw: 4 }, { kind: 'swap', color: null }, { kind: 'flip', color: null });
  // Ciclón: coloured skipAll / +6, dark +10 and "draw until the colour"
  for (const c of COLORS) out.push({ kind: 'skipAll', color: c }, { kind: 'draw6', color: c, draw: 6 });
  out.push({ kind: 'draw10', color: null, draw: 10 }, { kind: 'wildColor', color: null });
  const wilds = out.filter((f) => f.color === null && TINTABLE.includes(f.kind));
  for (const f of wilds) for (const c of COLORS) out.push({ ...f, tint: c });
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
  readonly faces: AtlasFace[] = [];
  private keys = new Map<string, number>();
  constructor() {
    for (const f of baseFaces()) this.add(f);
  }
  private add(f: AtlasFace): number {
    const i = this.faces.length;
    this.faces.push({ ...f });
    this.keys.set(faceKey(f), i);
    return i;
  }
  get size(): number {
    return this.faces.length;
  }
  lookup(f: AtlasFace): number {
    return this.keys.get(faceKey(f)) ?? -1;
  }
  /** cell for a face, adding it when there is room; falls back to the same kind/colour's base face */
  index(f: AtlasFace): { i: number; added: boolean } {
    const k = this.keys.get(faceKey(f));
    if (k !== undefined) return { i: k, added: false };
    if (this.faces.length < ATLAS_CELLS) return { i: this.add(f), added: true };
    const base = this.keys.get(faceKey({ kind: f.kind, color: f.color, value: f.value, tint: f.tint })) ?? 0;
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
    case 'reverse': {
      // two arrows chasing each other round a ring, like the direction ring on the table
      g.stroke(P('M4.95 9.43A7.5 7.5 0 0 1 18.5 8.25M19.05 14.57A7.5 7.5 0 0 1 5.5 15.75'));
      const heads = P('M20.7 12.06 21.6 6.45 15.4 10.05ZM3.3 11.94 2.4 17.55 8.6 13.95Z');
      g.lineWidth = 1.2;
      g.fill(heads);
      g.stroke(heads);
      return true;
    }
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

/** the gloss on the top of the colour field (turned half a turn it is the shade at the bottom) */
const SHEEN = 'M3.4 9A5.6 5.6 0 0 1 9 3.4H51A5.6 5.6 0 0 1 56.6 9V30Q30 46 3.4 30Z';
/** the four quarters of the wild capsule (the capsule inset by 1.8) */
const QUADS: readonly [Color, string][] = [
  ['coral', 'M30 45H17.3V36.5A12.7 12.7 0 0 1 30 23.8Z'],
  ['sol', 'M30 45V23.8A12.7 12.7 0 0 1 42.7 36.5V45Z'],
  ['mar', 'M30 45H42.7V53.5A12.7 12.7 0 0 1 30 66.2Z'],
  ['palma', 'M30 45V66.2A12.7 12.7 0 0 1 17.3 53.5V45Z'],
];

/**
 * Draw one face into (x, y, w, h); w:h = 2:3 (60×90 design space). Keep cardSvg (src/ui/cardArt.ts) in step.
 *
 * Layout: ivory card, glossy colour field, an upright ivory capsule in the middle holding the value (or
 * the action glyph) over the colour symbol, and in two corners the outlined index on its own. Wild-type cards: black field (the chosen colour once played), the capsule in four colours
 * with a small ivory disc for the mark ("Ku" on the plain wild).
 */
export function drawFace(g: G, f: AtlasFace, x: number, y: number, w: number): void {
  const s = w / 60;
  g.save();
  g.translate(x, y);
  g.scale(s, s);
  const c = f.color;
  const hue = c ?? f.tint ?? null;
  const field = hue ? COLOR_HEX[hue] : WILD_FIELD;
  // ivory card + colour field (the ivory gutter around the cell is filled by the caller)
  g.fillStyle = CREAM;
  roundRect(g, 0, 0, 60, 90, 7);
  g.fill();
  g.fillStyle = field;
  roundRect(g, 3.4, 3.4, 53.2, 83.2, 5.6);
  g.fill();
  // gloss on top, shade at the bottom
  g.fillStyle = 'rgba(255,255,255,0.12)';
  g.fill(P(SHEEN));
  g.save();
  g.translate(60, 90);
  g.rotate(Math.PI);
  g.fillStyle = 'rgba(0,0,0,0.12)';
  g.fill(P(SHEEN));
  g.restore();
  if (!hue) {
    // unplayed wild-type: thin woven lines in the four colours
    g.globalAlpha = 0.3;
    g.lineWidth = 1.2;
    g.lineCap = 'butt';
    for (let i = 0; i < 4; i++) {
      g.strokeStyle = COLOR_HEX[COLORS[i]];
      g.beginPath();
      g.moveTo(3.4, 12 + i * 20);
      g.lineTo(56.6, 30 + i * 20);
      g.stroke();
    }
    g.globalAlpha = 1;
  }
  // the capsule (upright, nothing tilted) with a soft drop shadow
  g.fillStyle = 'rgba(0,0,0,0.24)';
  roundRect(g, 15.5, 23.3, 29, 46, 14.5);
  g.fill();
  g.fillStyle = CREAM;
  roundRect(g, 15.5, 22, 29, 46, 14.5);
  g.fill();
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
  if (!c) {
    for (const [col, d] of QUADS) {
      g.fillStyle = COLOR_HEX[col];
      g.fill(P(d));
    }
    g.strokeStyle = CREAM;
    g.lineWidth = 0.9;
    g.lineCap = 'butt';
    g.stroke(P('M30 23.8V66.2M17.3 45H42.7'));
    if (f.kind === 'draw10') {
      // the +10 carries a dashed storm ring so it never reads as a +4 at a glance
      g.lineWidth = 1.3;
      g.setLineDash([3, 2.2]);
      roundRect(g, 13.4, 19.9, 33.2, 50.2, 16.6);
      g.stroke();
      g.setLineDash([]);
    }
    g.fillStyle = CREAM;
    g.beginPath();
    g.arc(30, 45, 9.8, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = 'rgba(0,0,0,0.22)';
    g.lineWidth = 0.8;
    g.stroke();
    const t = f.kind === 'wild' ? 'Ku' : cornerText(f);
    if (t) {
      g.fillStyle = INK;
      g.font = `900 ${t.length > 2 ? 9 : t === 'Ku' ? 10.5 : 11.5}px ${FONT}`;
      g.fillText(t, 30, t.length > 2 ? 48.2 : 48.9);
    } else {
      g.save();
      g.translate(21.6, 36.6);
      g.scale(0.7, 0.7);
      drawGlyph(g, f.kind, INK);
      g.restore();
    }
  } else {
    const deep = COLOR_DEEP[c];
    g.strokeStyle = deep;
    g.globalAlpha = 0.45;
    g.lineWidth = 0.9;
    roundRect(g, 17.4, 23.9, 25.2, 42.2, 12.6);
    g.stroke();
    g.globalAlpha = 1;
    const t = cornerText(f);
    if (t) {
      g.fillStyle = deep;
      g.font = `900 ${t.length > 2 ? 13 : t.length > 1 ? 17 : 25}px ${FONT}`;
      g.fillText(t, 30, t.length > 1 ? 45.6 : 47.4);
    } else {
      g.save();
      g.translate(18.6, 26.2);
      g.scale(0.95, 0.95);
      drawGlyph(g, f.kind, deep);
      g.restore();
    }
    g.save();
    g.translate(22.8, 50.6);
    g.scale(0.6, 0.6);
    drawSymbol(g, c, deep);
    g.restore();
  }
  // corners: the index (value or glyph) on its own; mirrored bottom-right
  const corner = cornerText(f);
  for (let k = 0; k < 2; k++) {
    g.save();
    if (k === 1) {
      g.translate(60, 90);
      g.rotate(Math.PI);
    }
    if (corner) {
      // single digits keep their size; "+2" … "+10" are fitted to a fixed box (condensed a little, then
      // shrunk) so the label keeps a clear margin from the card border
      const multi = corner.length > 1;
      let px = 18;
      let sx = 1;
      let cx = 12.4;
      if (multi) {
        px = 15;
        const maxW = corner.length > 2 ? 13.2 : 12.2;
        cx = 6.6 + maxW / 2;
        g.font = `900 ${px}px ${FONT}`;
        sx = Math.min(1, maxW / g.measureText(corner).width);
        if (sx < 0.8) {
          px *= sx / 0.8;
          sx = 0.8;
        }
      }
      g.font = `900 ${px}px ${FONT}`;
      g.textAlign = 'center';
      g.textBaseline = 'alphabetic';
      g.lineJoin = 'round';
      g.lineWidth = multi ? 1.8 : 2.2;
      g.strokeStyle = INK;
      g.save();
      g.translate(cx, multi ? 19 : 20.6);
      g.scale(sx, 1);
      g.strokeText(corner, 0, 0);
      g.fillStyle = CREAM;
      g.fillText(corner, 0, 0);
      g.restore();
    } else if (f.kind === 'wild') {
      fourColourDisc(g, 11.5, 13, 5.6);
      g.strokeStyle = CREAM;
      g.lineWidth = 1;
      g.beginPath();
      g.arc(11.5, 13, 5.6, 0, Math.PI * 2);
      g.stroke();
    } else {
      g.save();
      g.translate(4.2, 5);
      g.scale(0.68, 0.68);
      drawGlyph(g, f.kind, CREAM);
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

export function drawCell(g: G, size: number, i: number, f: AtlasFace): void {
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

/**
 * A card back (w × 1.5w px, 60×90 design space), drawn from the shared design data in cardBacks.ts (the
 * SVG back in src/ui/cardArt.ts draws the same data). Ivory edge, lit field, quiet pattern, one "Ku" in
 * the centre.
 */
export function drawBack(b: CardBack, w = 256): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = Math.round(w * 1.5);
  const g = canvas.getContext('2d')!;
  const d = backDesign(b);
  g.fillStyle = CREAM;
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.scale(w / 60, w / 60);
  const field = P(BACK_FIELD);
  const lit = g.createRadialGradient(30, 45, 0, 30, 45, 50);
  lit.addColorStop(0, d.hi);
  lit.addColorStop(1, d.lo);
  g.fillStyle = lit;
  g.fill(field);
  g.save();
  g.clip(field);
  g.lineCap = 'butt';
  g.lineJoin = 'miter';
  for (const l of d.layers) {
    g.globalAlpha = l.alpha;
    if (l.fill) {
      g.fillStyle = l.fill;
      g.fill(P(l.d));
    }
    if (l.stroke) {
      g.strokeStyle = l.stroke;
      g.lineWidth = l.width ?? 1;
      g.stroke(P(l.d));
    }
  }
  g.restore();
  g.fillStyle = d.mark.fill;
  g.font = `900 ${d.mark.size}px ${FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
  g.lineJoin = 'round';
  for (const u of d.mark.under ?? []) {
    g.globalAlpha = u.alpha;
    g.strokeStyle = u.stroke;
    g.lineWidth = u.width;
    g.strokeText('Ku', 30, d.mark.y);
  }
  g.globalAlpha = 1;
  g.fillText('Ku', 30, d.mark.y);
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

/** direction ring: two curved arrows pointing clockwise in canvas space (white + alpha; the table tints it) */
export function drawDirRing(size = 512): HTMLCanvasElement {
  // each arrow is a comet: a hair-thin tail that swells and brightens into a swept-back head,
  // with a soft halo, a body lit towards its outer edge, a crisp rim and a fine bright core line
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const cx = size / 2;
  const R = size * 0.4;
  const w = size * 0.064;
  const span = Math.PI * 0.72;
  const steps = 56;
  const barb = w * 1.12; // how far the head reaches either side of the band
  const tipAng = (w * 2.05) / R; // the head's length along the circle
  const sweep = (w * 0.55) / R; // the barbs trail behind the neck
  const half = (t: number): number => (w / 2) * (0.07 + 0.93 * Math.pow(t, 0.85));
  const pt = (a: number, r: number): void => g.lineTo(cx + Math.cos(a) * r, cx + Math.sin(a) * r);
  const body = g.createRadialGradient(cx, cx, R - barb, cx, cx, R + barb);
  body.addColorStop(0, 'rgba(255,255,255,0.5)');
  body.addColorStop(0.5, 'rgba(255,255,255,0.72)');
  body.addColorStop(1, 'rgba(255,255,255,0.98)');
  g.lineJoin = 'round';
  g.lineCap = 'round';
  for (const start of [0, Math.PI]) {
    const a1 = start + span; // the neck: where the head begins (clockwise in canvas space)
    g.beginPath();
    for (let i = 0; i <= steps; i++) pt(start + (span * i) / steps, R + half(i / steps));
    pt(a1 - sweep, R + barb);
    pt(a1 + tipAng, R);
    pt(a1 - sweep, R - barb);
    for (let i = steps; i >= 0; i--) pt(start + (span * i) / steps, R - half(i / steps));
    g.closePath();
    // the halo and the lit body in one fill
    g.shadowColor = 'rgba(255,255,255,0.6)';
    g.shadowBlur = size * 0.035;
    g.fillStyle = body;
    g.fill();
    g.shadowBlur = 0;
    g.shadowColor = 'transparent';
    // the crisp rim (round joins soften the head's points)
    g.lineWidth = size * 0.0055;
    g.strokeStyle = 'rgba(255,255,255,1)';
    g.stroke();
    // a fine bright core through the wide part of the band, into the head
    g.beginPath();
    g.arc(cx, cx, R, start + span * 0.3, a1 + tipAng * 0.45);
    g.lineWidth = w * 0.13;
    g.strokeStyle = 'rgba(255,255,255,0.65)';
    g.stroke();
  }
  // fade each arrow in along its length (tail -> head): one pass over the pixels, once
  try {
    const img = g.getImageData(0, 0, size, size);
    const d = img.data;
    const full = span * 0.62; // fully opaque from here on
    const cut = Math.PI - (Math.PI - span - tipAng) * 0.45; // past the tip's halo, back to nothing
    for (let y = 0, i = 3; y < size; y++) {
      for (let x = 0; x < size; x++, i += 4) {
        if (d[i] === 0) continue;
        let a = Math.atan2(y + 0.5 - cx, x + 0.5 - cx);
        if (a < 0) a += Math.PI; // the two arrows are alike: fold onto one
        const k = a >= cut ? 0 : a >= full ? 1 : a / full;
        d[i] = Math.round(d[i] * k * k * (3 - 2 * k));
      }
    }
    g.putImageData(img, 0, 0);
  } catch {
    /* no pixel access: the arrows stay un-faded */
  }
  return c;
}

/** the turn marker: a rounded arrowhead with a soft halo, tip up (white + alpha; tinted by the material) */
export function drawTurnMarker(size = 128): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const u = size;
  const path = (): void => {
    g.beginPath();
    g.moveTo(u * 0.5, u * 0.25);
    g.lineTo(u * 0.74, u * 0.7);
    g.quadraticCurveTo(u * 0.5, u * 0.56, u * 0.26, u * 0.7); // a curved notch in the base
    g.closePath();
  };
  g.lineJoin = 'round';
  // a wide soft halo, then the body
  path();
  g.shadowColor = 'rgba(255,255,255,0.75)';
  g.shadowBlur = u * 0.13;
  g.lineWidth = u * 0.07;
  g.strokeStyle = 'rgba(255,255,255,0.55)';
  g.stroke();
  g.shadowBlur = u * 0.05;
  const grad = g.createLinearGradient(0, u * 0.2, 0, u * 0.72);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(1, 'rgba(255,255,255,0.7)');
  g.fillStyle = grad;
  g.strokeStyle = grad;
  g.fill();
  g.stroke(); // rounds the corners
  g.shadowBlur = 0;
  g.shadowColor = 'transparent';
  // a crisp bright edge
  path();
  g.lineWidth = u * 0.07;
  g.strokeStyle = 'rgba(255,255,255,0.35)';
  g.stroke();
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

/**
 * The round table and the room around it, one square texture for a big floor plane: a round felt with
 * no rim, softly lit from the middle, thin rings and faint light rays around it, and stray glints, all
 * fading out to the background colour at the edge (so the plane never shows a seam). `tableR` is the
 * table radius as a fraction of the plane's side; tints are team glows (u, v in 0..1 over the plane).
 */
export function drawArena(style: TableStyle, size: number, tableR: number, tints: readonly FeltTint[] = []): HTMLCanvasElement {
  const S = TABLE_STYLE_DEFS[style] ?? TABLE_STYLE_DEFS.teal;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const m = size / 2;
  const R = tableR * size;
  // the room: lit from the middle, fading to the background at the edge
  const room = g.createRadialGradient(m, m, R * 0.6, m, m, m);
  room.addColorStop(0, S.felt[1]);
  room.addColorStop(0.45, hexA(S.felt[1], 0.55));
  room.addColorStop(1, S.bg);
  g.fillStyle = S.bg;
  g.fillRect(0, 0, size, size);
  g.fillStyle = room;
  g.fillRect(0, 0, size, size);
  // light rays fanning out from the table
  g.save();
  g.translate(m, m);
  const rays = 20;
  for (let i = 0; i < rays; i++) {
    const a0 = (i / rays) * Math.PI * 2;
    const a1 = a0 + (Math.PI * 2) / rays / 2;
    const gr = g.createRadialGradient(0, 0, R, 0, 0, m);
    gr.addColorStop(0, 'rgba(255,255,255,0.05)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr;
    g.beginPath();
    g.moveTo(Math.cos(a0) * R, Math.sin(a0) * R);
    g.arc(0, 0, m, a0, a1);
    g.lineTo(Math.cos(a1) * R, Math.sin(a1) * R);
    g.closePath();
    g.fill();
  }
  g.restore();
  // stray glints round the room (fixed seed so redraws match)
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 70; i++) {
    const a = rnd() * Math.PI * 2;
    const d = R * 1.08 + rnd() * (m - R * 1.08);
    const s = size * (0.004 + rnd() * 0.012);
    g.save();
    g.translate(m + Math.cos(a) * d, m + Math.sin(a) * d);
    g.rotate(rnd() * Math.PI);
    g.fillStyle = `rgba(255,255,255,${(0.04 + rnd() * 0.06) * (1 - d / m)})`;
    g.fillRect(-s, -s * 0.35, s * 2, s * 0.7);
    g.restore();
  }
  // a soft glow just outside the table edge
  const halo = g.createRadialGradient(m, m, R * 0.96, m, m, R * 1.25);
  halo.addColorStop(0, hexA(S.felt[0], 0.45));
  halo.addColorStop(1, hexA(S.felt[0], 0));
  g.fillStyle = halo;
  g.beginPath();
  g.arc(m, m, R * 1.25, 0, Math.PI * 2);
  g.fill();
  // the round felt (no rim)
  const felt = g.createRadialGradient(m, m * 0.97, R * 0.05, m, m, R);
  felt.addColorStop(0, S.felt[0]);
  felt.addColorStop(1, S.felt[1]);
  g.fillStyle = felt;
  g.beginPath();
  g.arc(m, m, R, 0, Math.PI * 2);
  g.fill();
  // felt speckle inside the table
  g.save();
  g.beginPath();
  g.arc(m, m, R, 0, Math.PI * 2);
  g.clip();
  const n = Math.round((R * R * 3.14) / 90);
  g.fillStyle = 'rgba(255,255,255,0.035)';
  for (let i = 0; i < n; i++) g.fillRect(m - R + rnd() * 2 * R, m - R + rnd() * 2 * R, 1.2, 1.2);
  g.fillStyle = 'rgba(0,0,0,0.05)';
  for (let i = 0; i < n; i++) g.fillRect(m - R + rnd() * 2 * R, m - R + rnd() * 2 * R, 1.2, 1.2);
  // team tints behind each seat
  for (const t of tints) {
    const cx = t.u * size;
    const cy = t.v * size;
    const r = t.r * size;
    const gr = g.createRadialGradient(cx, cy, 0, cx, cy, r);
    gr.addColorStop(0, hexA(t.color, 0.3));
    gr.addColorStop(0.55, hexA(t.color, 0.13));
    gr.addColorStop(1, hexA(t.color, 0));
    g.fillStyle = gr;
    g.fillRect(cx - r, cy - r, 2 * r, 2 * r);
  }
  g.restore();
  // thin rings: one on the edge, two in the room
  g.lineWidth = Math.max(1, size * 0.0025);
  for (const [k, a] of [[1, 0.22], [1.22, 0.07], [1.5, 0.045]] as const) {
    g.strokeStyle = `rgba(255,255,255,${a})`;
    g.beginPath();
    g.arc(m, m, R * k, 0, Math.PI * 2);
    g.stroke();
  }
  return c;
}
