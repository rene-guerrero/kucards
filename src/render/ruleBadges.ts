/**
 * Rule badges: a tag stuck on a card's top-left corner, overhanging the card's edge, that says what a
 * rule makes the card do.
 *   'swap' = a red rounded square with a white two-way arrow (sevenSwap: a 7 swaps hands)
 *   'pass' = a yellow rounded square with two arrows chasing round (zeroPass: a 0 passes every hand on;
 *            the Comodín Rueda always carries it)
 *
 * The badge sits OUTSIDE the card face, so it is not part of the atlas cell:
 *  - 3D table (cardTable.ts): the card geometry has a small extra quad ("tab") at this spot, drawn by the
 *    same instanced mesh and shader from a tiny two-tile texture (`drawBadgeTiles`); a per-instance flag
 *    turns it on, so badges cost no draw call and follow every card move for free.
 *  - SVG (ui/cardArt.ts): `badgeSvg` drawn at negative coordinates of the 60×90 card with
 *    `overflow="visible"`, so the card keeps its layout box.
 * Both draw from the shapes below (no three.js here, so the DOM art can import it).
 */

export type FaceBadge = 'swap' | 'pass';

/** the rules that put a badge on a face (a RuleSettings has these keys; absent = off) */
export interface BadgeRules {
  sevenSwap?: unknown;
  zeroPass?: unknown;
  /** the older combined 7-0 rule: both badges */
  sevenZero?: unknown;
}

/** the badge a face shows under these rules (the Comodín Rueda always shows 'pass') */
export function faceBadge(f: { kind: string; value?: number }, rules?: BadgeRules | null): FaceBadge | undefined {
  if (f.kind === 'wheelWild') return 'pass';
  if (f.kind !== 'number' || !rules) return undefined;
  if (f.value === 7 && (rules.sevenSwap || rules.sevenZero)) return 'swap';
  if ((f.value ?? 0) === 0 && (rules.zeroPass || rules.sevenZero)) return 'pass';
  return undefined;
}

/**
 * where the badge sits, in the card's 60×90 design space (y down, the card spans 0..60 × 0..90): the
 * BOX×BOX square whose top-left corner is (X, Y). Its rounded square straddles the card's top-left corner
 * and stays clear of the corner index.
 */
export const BADGE_BOX = 20;
/** the square's left edge lines up with the card's left edge (SQ.x inside the box) */
export const BADGE_X = -2.5;
export const BADGE_Y = -13.2;

export const BADGE_RED = '#d7262e';
export const BADGE_YELLOW = '#ffd23a';
const INK = '#13232e';
/** the rounded square inside the box (2.5 margin: room for the drop shadow) */
const SQ = { x: 2.5, y: 2.5, s: 15, r: 3.6 };
/** white ↔ centred on (10, 10) */
const SWAP_ARROW = 'M5.3 10H14.7M7.7 7.5 5.2 10 7.7 12.5M12.3 7.5 14.8 10 12.3 12.5';
/** two arrows chasing round a ring (24×24 box; the reverse glyph), drawn at WHEEL_SCALE centred on (10, 10) */
export const WHEEL_ARCS = 'M4.95 9.43A7.5 7.5 0 0 1 18.5 8.25M19.05 14.57A7.5 7.5 0 0 1 5.5 15.75';
export const WHEEL_HEADS = 'M20.7 12.06 21.6 6.45 15.4 10.05ZM3.3 11.94 2.4 17.55 8.6 13.95Z';
const WHEEL_SCALE = 0.5;
const WHEEL_AT = 10 - 12 * WHEEL_SCALE;

/** the badge as SVG markup in its BADGE_BOX box (origin at the box's top-left) */
export function badgeSvg(b: FaceBadge): string {
  const sq = (dy: number, fill: string, extra = '') => `<rect x="${SQ.x}" y="${SQ.y + dy}" width="${SQ.s}" height="${SQ.s}" rx="${SQ.r}" fill="${fill}"${extra}/>`;
  // no rim: a plain square with a simple drop shadow
  const base = sq(1.4, '#000', ' fill-opacity=".4"') + sq(0, b === 'swap' ? BADGE_RED : BADGE_YELLOW);
  if (b === 'swap') return base + `<path d="${SWAP_ARROW}" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>`;
  return (
    base +
    `<g transform="translate(${WHEEL_AT} ${WHEEL_AT}) scale(${WHEEL_SCALE})"><path d="${WHEEL_ARCS}" fill="none" stroke="${INK}" stroke-width="2.8" stroke-linecap="round"/>` +
    `<path d="${WHEEL_HEADS}" fill="${INK}" stroke="${INK}" stroke-width="1.2" stroke-linejoin="round"/></g>`
  );
}

type G = CanvasRenderingContext2D;

function rr(g: G, x: number, y: number, s: number, r: number): void {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + s, y, x + s, y + s, r);
  g.arcTo(x + s, y + s, x, y + s, r);
  g.arcTo(x, y + s, x, y, r);
  g.arcTo(x, y, x + s, y, r);
  g.closePath();
}

/** the badge on a canvas, in its BADGE_BOX box at the current transform (the same shapes as badgeSvg) */
export function drawBadgeShape(g: G, b: FaceBadge): void {
  g.save();
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.fillStyle = 'rgba(0,0,0,0.4)';
  rr(g, SQ.x, SQ.y + 1.4, SQ.s, SQ.r);
  g.fill();
  g.fillStyle = b === 'swap' ? BADGE_RED : BADGE_YELLOW;
  rr(g, SQ.x, SQ.y, SQ.s, SQ.r);
  g.fill();
  if (b === 'swap') {
    g.strokeStyle = '#fff';
    g.lineWidth = 1.7;
    g.stroke(new Path2D(SWAP_ARROW));
  } else {
    g.translate(WHEEL_AT, WHEEL_AT);
    g.scale(WHEEL_SCALE, WHEEL_SCALE);
    g.strokeStyle = INK;
    g.fillStyle = INK;
    g.lineWidth = 2.8;
    g.stroke(new Path2D(WHEEL_ARCS));
    g.lineWidth = 1.2;
    const heads = new Path2D(WHEEL_HEADS);
    g.fill(heads);
    g.stroke(heads);
  }
  g.restore();
}

/** tile order in the badge texture (the shader picks tile `index - 1`) */
export const BADGE_TILES: readonly FaceBadge[] = ['swap', 'pass'];
/** 1-based tile index of a badge (0 = none): the per-instance value the card shader reads */
export const badgeIndex = (b: FaceBadge | undefined): number => (b ? BADGE_TILES.indexOf(b) + 1 : 0);

/** the badge texture: the tiles side by side, `px` square each, transparent around the rounded squares */
export function drawBadgeTiles(px = 96): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = px * BADGE_TILES.length;
  c.height = px;
  const g = c.getContext('2d')!;
  BADGE_TILES.forEach((b, i) => {
    g.save();
    g.translate(i * px, 0);
    g.scale(px / BADGE_BOX, px / BADGE_BOX);
    drawBadgeShape(g, b);
    g.restore();
  });
  return c;
}

/** corner glyphs drawn with a dark rim (as the number index) and the 8 nudges that make it; same in cardArt.ts */
export const OUTLINED_CORNER: ReadonlySet<string> = new Set(['reverse', 'skip']);
export const OUTLINE_STEPS: readonly (readonly [number, number])[] = [[-1.4, 0], [1.4, 0], [0, -1.4], [0, 1.4], [-1, -1], [1, -1], [-1, 1], [1, 1]];
