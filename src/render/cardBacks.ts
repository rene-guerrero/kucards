/**
 * The card-back designs as pure data (no DOM, no three.js), in the 60×90 card design space. The canvas
 * back (drawBack in cardAtlas.ts) and the SVG back (cardBackSvg in src/ui/cardArt.ts) both draw from
 * this, so they cannot drift apart.
 *
 * Every back: ivory card edge (the one border), a softly lit field, a quiet pattern clipped to the field,
 * and one "Ku" mark upright in the centre (the pattern and ornaments stay point-symmetric).
 */
import type { CardBack } from '../contracts';

const CREAM = '#fff6e6';

export interface BackLayer {
  d: string;
  fill?: string;
  stroke?: string;
  width?: number;
  alpha: number;
}

export interface BackDesign {
  /** field gradient: centre → edge (radial, centre 30 45, radius 50) */
  hi: string;
  lo: string;
  /** pattern, gloss and mark ornaments, in order, clipped to the field */
  layers: BackLayer[];
  /** the "Ku" mark: drawn once, upright, centred on x = 30 with its alphabetic baseline at y */
  mark: { size: number; y: number; fill: string; under?: MarkStroke[] };
}

/** a stroke of the mark's letters, painted under their fill (round joins): a glow or an outline */
export interface MarkStroke {
  stroke: string;
  width: number;
  alpha: number;
}

const n = (v: number): string => String(Math.round(v * 100) / 100);

function rr(x: number, y: number, w: number, h: number, r: number): string {
  return (
    `M${n(x + r)} ${n(y)}H${n(x + w - r)}A${r} ${r} 0 0 1 ${n(x + w)} ${n(y + r)}V${n(y + h - r)}A${r} ${r} 0 0 1 ${n(x + w - r)} ${n(y + h)}` +
    `H${n(x + r)}A${r} ${r} 0 0 1 ${n(x)} ${n(y + h - r)}V${n(y + r)}A${r} ${r} 0 0 1 ${n(x + r)} ${n(y)}Z`
  );
}

/** the colour field of a card (same rect as the faces) */
export const BACK_FIELD = rr(3.4, 3.4, 53.2, 83.2, 5.6);

/** diagonal trellis through the card centre (both directions), point-symmetric for off = 0 or step / 2 */
function lattice(step: number, off = 0): string {
  let d = '';
  const N = Math.ceil(80 / step) + 1;
  for (let k = -N; k <= N; k++) {
    const v = k * step + off;
    d += `M${n(v - 20)} -5L${n(v + 80)} 95M${n(80 - v)} -5L${n(-20 - v)} 95`;
  }
  return d;
}

/** `count` wedges fanning out from the card centre, each half a slot wide */
function rays(count: number): string {
  let d = '';
  const half = Math.PI / count / 2;
  for (let i = 0; i < count; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / count;
    d += `M30 45L${n(30 + Math.cos(a - half) * 70)} ${n(45 + Math.sin(a - half) * 70)}L${n(30 + Math.cos(a + half) * 70)} ${n(45 + Math.sin(a + half) * 70)}Z`;
  }
  return d;
}

const dot = (x: number, y: number, r: number): string => `M${n(x - r)} ${n(y)}a${r} ${r} 0 1 0 ${n(2 * r)} 0a${r} ${r} 0 1 0 ${n(-2 * r)} 0Z`;
const sparkle = (x: number, y: number, r: number): string =>
  `M${n(x)} ${n(y - r)}Q${n(x)} ${n(y)} ${n(x + r)} ${n(y)}Q${n(x)} ${n(y)} ${n(x)} ${n(y + r)}Q${n(x)} ${n(y)} ${n(x - r)} ${n(y)}Q${n(x)} ${n(y)} ${n(x)} ${n(y - r)}Z`;
/** a shape list and its copy half a turn round the centre */
const both = (pts: readonly (readonly [number, number, number])[], f: (x: number, y: number, r: number) => string): string =>
  pts.map(([x, y, r]) => f(x, y, r) + f(60 - x, 90 - y, r)).join('');

const SHEEN_TOP = 'M3.4 9A5.6 5.6 0 0 1 9 3.4H51A5.6 5.6 0 0 1 56.6 9V30Q30 46 3.4 30Z';
const SHEEN_BOTTOM = 'M56.6 81A5.6 5.6 0 0 1 51 86.6H9A5.6 5.6 0 0 1 3.4 81V60Q30 44 56.6 60Z';
const gloss = (a: number): BackLayer[] => [
  { d: SHEEN_TOP, fill: '#fff', alpha: a },
  { d: SHEEN_BOTTOM, fill: '#000', alpha: a },
];

/** the ivory capsule of the card faces, smaller, holding the "Ku" mark in the back's deep colour */
function capsule(ink: string): BackLayer[] {
  return [
    { d: rr(17, 30, 26, 32, 13), fill: '#000', alpha: 0.24 },
    { d: rr(17, 29, 26, 32, 13), fill: CREAM, alpha: 1 },
    { d: rr(18.6, 30.6, 22.8, 28.8, 11.4), stroke: ink, width: 0.8, alpha: 0.45 },
  ];
}

/** the mark inside the capsule */
const capsuleMark = (ink: string): BackDesign['mark'] => ({ size: 14, y: 50.1, fill: ink });

const DESIGNS: Record<CardBack, () => BackDesign> = {
  // the default: near-black field, ivory edge, a whisper of trellis and one large sun-yellow monogram
  // (soft glow, thin amber outline) that reads at a glance when the card is small or turned
  ku: () => ({
    hi: '#24252c',
    lo: '#050506',
    layers: [
      { d: lattice(6), stroke: '#fff', width: 0.7, alpha: 0.06 },
      ...gloss(0.05),
      { d: 'M13 24.5H26M34 24.5H47M13 65.5H26M34 65.5H47', stroke: '#f7b417', width: 1.1, alpha: 0.9 },
      { d: 'M30 22 32 24.5 30 27 28 24.5ZM30 63 32 65.5 30 68 28 65.5Z', fill: '#ffcb45', alpha: 1 },
    ],
    mark: {
      size: 34,
      y: 57,
      fill: '#f7b417',
      under: [
        { stroke: '#ffcb45', width: 4.8, alpha: 0.2 },
        { stroke: '#8a4b00', width: 1.4, alpha: 1 },
      ],
    },
  }),
  // woven: a broad trellis crossed by a fine one, on the sea colour
  weave: () => ({
    hi: '#1390a8',
    lo: '#084e5d',
    layers: [
      { d: lattice(10), stroke: '#fff', width: 2.6, alpha: 0.11 },
      { d: lattice(10, 5), stroke: '#04303a', width: 0.8, alpha: 0.4 },
      ...gloss(0.1),
      ...capsule('#0a5d6f'),
    ],
    mark: capsuleMark('#0a5d6f'),
  }),
  // sun: soft rays from the centre, on the sun colour
  sun: () => ({
    hi: '#ffcf4a',
    lo: '#e79800',
    layers: [{ d: rays(12), fill: '#fff', alpha: 0.2 }, ...gloss(0.08), ...capsule('#b86e00')],
    mark: capsuleMark('#b86e00'),
  }),
  // night: a deep blue sky with stars
  night: () => ({
    hi: '#214268',
    lo: '#070f1c',
    layers: [
      { d: both([[12, 14, 1.1], [24, 9.5, 0.7], [47, 19, 0.9], [9, 36, 0.7], [50, 34, 1.1], [41, 9.5, 0.6], [14, 26, 0.6], [49, 50, 0.7]], dot), fill: CREAM, alpha: 0.85 },
      { d: both([[30, 18, 5.4], [44, 27, 2.6], [16, 20, 2]], sparkle), fill: '#ffcb45', alpha: 1 },
      ...gloss(0.07),
      ...capsule('#12294a'),
    ],
    mark: capsuleMark('#12294a'),
  }),
};

const cache = new Map<CardBack, BackDesign>();

/** the design of a back; an unknown id gets the default */
export function backDesign(b: CardBack): BackDesign {
  const id = DESIGNS[b] ? b : 'ku';
  let d = cache.get(id);
  if (!d) {
    d = DESIGNS[id]();
    cache.set(id, d);
  }
  return d;
}
