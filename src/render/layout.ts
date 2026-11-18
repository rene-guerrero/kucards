/**
 * Pure layout math for the card table (no DOM, no WebGL): the human fan in CSS px, opponents' fans in
 * table units, hit testing, hand sorting and plate boxes. Unit-tested in layout.test.ts.
 */
import type { Card, CardKind, Color, Seat, SeatPlate } from '../contracts';

/** card width / height (same 2:3 card as the HTML art in src/ui/cardArt.ts) */
export const CARD_ASPECT = 2 / 3;
/** table-space card size (world units) */
export const CARD_W = 0.667;
export const CARD_H = 1;

// ───────────────────────── human fan (screen px, y down) ─────────────────────────

export interface FanSlot {
  /** centre, CSS px (y down) */
  x: number;
  y: number;
  /** clockwise on screen, radians */
  rot: number;
  /** 0 = back row (raised), rows - 1 = front row */
  row: number;
  /** draw order: higher = nearer the viewer */
  z: number;
}

export interface FanLayout {
  slots: FanSlot[];
  /** card size in px */
  cw: number;
  ch: number;
  /** horizontal step between neighbours in a row */
  spacing: number;
  rows: number;
  /** topmost px of the hand (for plates / the camera fit) */
  top: number;
  /** the minimum visible strip a card keeps (px) */
  minTap: number;
}

export interface FanOpts {
  W: number;
  H: number;
  /** side / bottom gutter in px */
  margin?: number;
  /** safe-area insets */
  safeL?: number;
  safeR?: number;
  safeB?: number;
}

/** card width for a viewport (px) */
export function fanCardWidth(W: number, H: number): number {
  return Math.max(44, Math.min(104, W * 0.2, H * 0.165));
}

/** minimum visible strip per card (px): always a comfortable finger width */
export function fanMinTap(cw: number): number {
  return Math.max(22, Math.round(cw * 0.3));
}

/** fraction of a back-row card that shows above the row in front of it */
export const ROW_REVEAL = 0.4;

/**
 * Fan `n` cards in ONE arc at the bottom of a W×H viewport. Small hands spread out; bigger ones overlap
 * more and more (at least `minTap` px each while that fits, then they just keep compressing). Every card
 * stays fully on screen; hovering / touching peeks a card (see the view).
 */
/** leftmost px of a fan (rotated corners included) */
export function fanLeft(f: FanLayout): number {
  let m = Infinity;
  for (const s of f.slots) m = Math.min(m, s.x - (f.cw / 2) * Math.cos(s.rot) - (f.ch / 2) * Math.abs(Math.sin(s.rot)));
  return m;
}

export function fanLayout(n: number, o: FanOpts): FanLayout {
  const W = Math.max(1, o.W);
  const H = Math.max(1, o.H);
  const m = o.margin ?? 10;
  const left = m + (o.safeL ?? 0);
  const right = W - m - (o.safeR ?? 0);
  const bottom = H - m - (o.safeB ?? 0);
  const avail = Math.max(10, right - left);
  let cw = fanCardWidth(W, H);
  // very narrow views: the card itself never exceeds a third of the row
  cw = Math.min(cw, avail / 3);
  const ch = cw / CARD_ASPECT;
  const minTap = fanMinTap(cw);
  const slots: FanSlot[] = [];
  if (n <= 0) return { slots, cw, ch, spacing: 0, rows: 0, top: bottom - ch, minTap };
  // rotation headroom: a rotated card is wider than cw; keep a small reserve on both sides
  const rotPad = cw * 0.12;
  const usable = Math.max(cw, avail - 2 * rotPad);
  // never wrap: one row that overlaps more and more (the peek is how a squeezed card is read)
  const rows = 1;
  const perRow = n;
  const ideal = cw * 0.62;
  const spacing = perRow > 1 ? Math.min(ideal, (usable - cw) / (perRow - 1)) : 0;
  const step = perRow > 1 ? Math.min(0.075, 0.44 / (perRow - 1)) : 0;
  const R = step > 0 ? spacing / Math.sin(step) : 0;
  const rowRise = ch * ROW_REVEAL;
  let idx = 0;
  let maxBottom = -Infinity;
  for (let r = 0; r < rows; r++) {
    const k = Math.min(perRow, n - idx);
    const mid = (k - 1) / 2;
    for (let j = 0; j < k; j++, idx++) {
      const th = (j - mid) * step;
      const x = (left + right) / 2 + (step > 0 ? R * Math.sin(th) : (j - mid) * spacing);
      const sag = step > 0 ? R * (1 - Math.cos(th)) : 0;
      const y = -(rows - 1 - r) * rowRise + sag;
      slots.push({ x, y, rot: th, row: r, z: idx });
      const ext = (ch / 2) * Math.cos(th) + (cw / 2) * Math.abs(Math.sin(th));
      if (y + ext > maxBottom) maxBottom = y + ext;
    }
  }
  // drop the whole hand so its lowest corner rests on the bottom gutter
  const dy = bottom - maxBottom;
  let top = Infinity;
  for (const s of slots) {
    s.y += dy;
    const ext = (ch / 2) * Math.cos(s.rot) + (cw / 2) * Math.abs(Math.sin(s.rot));
    if (s.y - ext < top) top = s.y - ext;
  }
  return { slots, cw, ch, spacing, rows, top, minTap };
}

/** is (x, y) inside the card at slot `s` (optionally raised by `lift` px)? */
export function inSlot(s: FanSlot, cw: number, ch: number, x: number, y: number, lift = 0): boolean {
  const dx = x - s.x;
  const dy = y - (s.y - lift);
  const c = Math.cos(s.rot);
  const si = Math.sin(s.rot);
  // into the card's frame (screen rotation is clockwise for positive rot)
  const lx = dx * c + dy * si;
  const ly = -dx * si + dy * c;
  return Math.abs(lx) <= cw / 2 && Math.abs(ly) <= ch / 2;
}

/** the topmost card under (x, y), or -1. `lifts` (px per slot) raise cards like the view does. */
export function hitFan(f: FanLayout, x: number, y: number, lifts?: ArrayLike<number>): number {
  let best = -1;
  let bestZ = -Infinity;
  for (let i = 0; i < f.slots.length; i++) {
    const s = f.slots[i];
    if (s.z > bestZ && inSlot(s, f.cw, f.ch, x, y, lifts ? lifts[i] ?? 0 : 0)) {
      best = i;
      bestZ = s.z;
    }
  }
  return best;
}

// ───────────────────────── hand order ─────────────────────────

const COLOR_ORDER: Record<string, number> = { sol: 0, mar: 1, palma: 2, coral: 3 };
const KIND_ORDER: Record<CardKind, number> = {
  number: 0, skip: 1, skipAll: 2, reverse: 3, draw2: 4, draw6: 5, shield: 6, sweep: 7, mirror: 8, flip: 9,
  wild: 10, wildColor: 11, wild4: 12, draw10: 13, swap: 14,
};

export function cardOrder(a: Card, b: Card): number {
  const ca = a.face.color ? COLOR_ORDER[a.face.color] : 9;
  const cb = b.face.color ? COLOR_ORDER[b.face.color] : 9;
  if (ca !== cb) return ca - cb;
  const ka = KIND_ORDER[a.face.kind] ?? 20;
  const kb = KIND_ORDER[b.face.kind] ?? 20;
  if (ka !== kb) return ka - kb;
  const va = (a.face.value ?? 0) * 100 + (a.face.draw ?? 0);
  const vb = (b.face.value ?? 0) * 100 + (b.face.draw ?? 0);
  return va !== vb ? va - vb : a.id - b.id;
}

/** sorted by colour (sol, mar, palma, coral, wilds last) then value / kind */
export function sortHand(cards: readonly Card[]): Card[] {
  return cards.slice().sort(cardOrder);
}

// ───────────────────────── table geometry (world units) ─────────────────────────

/** lowerLeft / lowerRight: the Parejas "Codo a codo" partner, in the lower corner beside the human */
export type SeatSide = 'bottom' | 'right' | 'top' | 'left' | 'lowerLeft' | 'lowerRight';
export const SEAT_SIDE: Record<number, SeatSide> = { 0: 'bottom', 1: 'right', 2: 'top', 3: 'left', 4: 'right', 5: 'left' };

/**
 * Where each seat sits on screen. Default: SEAT_SIDE. Parejas side seating (4 players, the human's
 * partner is a turn-order neighbour): the partner goes to the lower corner on their side (next seat =
 * lower-right, previous seat = lower-left), the opponents to the top and the other side.
 */
export function seatSides(seats: readonly number[], teams: readonly (readonly number[])[] | null | undefined): Record<number, SeatSide> {
  const out: Record<number, SeatSide> = { ...SEAT_SIDE };
  if (!teams || seats.length !== 4 || seats[0] !== 0) return out;
  const mine = teams.find((t) => t.includes(0));
  const partner = mine?.find((s) => s !== 0);
  if (partner === undefined) return out;
  if (partner === seats[1]) {
    out[seats[1]] = 'lowerRight';
    out[seats[2]] = 'top';
    out[seats[3]] = 'left';
  } else if (partner === seats[3]) {
    out[seats[1]] = 'right';
    out[seats[2]] = 'top';
    out[seats[3]] = 'lowerLeft';
  }
  return out;
}

/**
 * Screen rotation of play for direction 1: +1 = clockwise on screen, -1 = counter-clockwise, from the
 * seat points (table x right, z towards the viewer = screen y down) in turn order. 0 when collinear (2p).
 */
export function turnSpin(points: readonly { x: number; z: number }[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a.x * b.z - a.z * b.x;
  }
  return Math.abs(sum) < 1e-6 ? 0 : Math.sign(sum);
}

/** x scale sign of the direction ring (its texture's chevrons run clockwise) for a turn direction */
export function ringSign(spin: number, direction: 1 | -1): number {
  return (spin === 0 ? -1 : spin) * direction;
}

export interface TableDims {
  /** half extents of the felt */
  A: number;
  B: number;
}

export function tableDims(portrait: boolean): TableDims {
  return portrait ? { A: 2.05, B: 2.9 } : { A: 3.9, B: 2.15 };
}

export interface Anchor {
  x: number;
  z: number;
  /** yaw of a card lying there (its top points away from the table centre) */
  yaw: number;
}

/** where a seat's fan lies on the table */
export function seatAnchor(side: SeatSide, d: TableDims): Anchor {
  switch (side) {
    case 'bottom':
      return { x: 0, z: d.B - 0.55, yaw: 0 };
    case 'right':
      return { x: d.A - 0.5, z: -0.15, yaw: -Math.PI / 2 };
    case 'top':
      return { x: 0, z: -d.B + 0.5, yaw: Math.PI };
    case 'left':
      return { x: -d.A + 0.5, z: -0.15, yaw: Math.PI / 2 };
    // rough fallback; the table uses the partner fan's real centre (partnerFan)
    case 'lowerLeft':
      return { x: -d.A + 0.9, z: d.B * 0.45, yaw: Math.PI / 2 };
    case 'lowerRight':
      return { x: d.A - 0.9, z: d.B * 0.45, yaw: -Math.PI / 2 };
  }
}

export const OPP_SCALE = 0.6;

export interface TablePose {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

/** opponent fan: `n` face-down cards spread along the seat's edge (compressing as the hand grows) */
export function oppFan(n: number, side: SeatSide, d: TableDims, out: TablePose[] = [], anchor?: Anchor, maxLenOverride?: number): TablePose[] {
  out.length = 0;
  const a = anchor ?? seatAnchor(side, d);
  const along = side === 'top' || side === 'bottom';
  const maxLen = maxLenOverride ?? (along ? Math.min(2.6, d.A * 1.25) : Math.min(2.6, d.B * 0.95));
  const step = n > 1 ? Math.min(0.24, maxLen / (n - 1)) : 0;
  const mid = (n - 1) / 2;
  for (let i = 0; i < n; i++) {
    const t = (i - mid) * step;
    // a gentle arc, like a spectrum: the cards turn a little across the fan and the ends bow towards the edge
    const u = n > 1 ? (i - mid) / Math.max(1, mid) : 0;
    const fanYaw = u * 0.24;
    const sag = u * u * 0.16;
    let x = a.x;
    let z = a.z;
    if (side === 'top') {
      x -= t;
      z -= sag;
    } else if (side === 'bottom') {
      x += t;
      z += sag;
    } else if (side === 'right') {
      z += t;
      x += sag;
    } else {
      z -= t;
      x -= sag;
    }
    out.push({ x, y: 0.012 + i * 0.0035, z, yaw: a.yaw - fanYaw });
  }
  return out;
}

/** opponent fan length (world units) along its edge, for plate placement */
export function oppFanLen(n: number, side: SeatSide, d: TableDims, maxLenOverride?: number): number {
  const along = side === 'top' || side === 'bottom';
  const maxLen = maxLenOverride ?? (along ? Math.min(2.6, d.A * 1.25) : Math.min(2.6, d.B * 0.95));
  const step = n > 1 ? Math.min(0.24, maxLen / (n - 1)) : 0;
  return (n - 1) * step + CARD_W * OPP_SCALE;
}

// ───────────────────────── open hands (Parejas: the partner's cards face up) ─────────────────────────

/** an open fan is drawn bigger than a face-down one so the faces stay readable on a phone */
export const OPEN_SCALE = 0.95;
/** landscape phones are short: the felt is smaller on screen, so open cards grow a bit more */
export function openScale(portrait: boolean): number {
  return portrait ? OPEN_SCALE : 1.15;
}
/** visible strip a covered card keeps: the corner value (+ the small colour symbol for columns) */
export const OPEN_MIN_STRIP_X = 0.34; // of the card width (rows overlap sideways)
export const OPEN_MIN_STRIP_Z = 0.3; // of the card height (columns overlap downwards)

export interface OpenPose {
  x: number;
  y: number;
  z: number;
  /** flat fans only: yaw of the card (0 = upright for the viewer) */
  yaw?: number;
}

export interface OpenFan {
  poses: OpenPose[];
  /** card scale (OPEN_SCALE) */
  s: number;
  /** tilt towards the camera (radians from lying flat) */
  tilt: number;
  /** lines (rows for top / bottom, columns for the sides) */
  lines: number;
  /** step between neighbours inside a line (world units) */
  step: number;
  /** centre and half extents of the whole fan on the table plane */
  cx: number;
  cz: number;
  hx: number;
  hz: number;
}

/**
 * Face-up fan for an open hand: the cards are upright for the viewer (yaw 0) and tilted `tilt` towards
 * the camera. Top / bottom seats lay rows along x (later rows nearer the centre); side seats stack
 * columns along z (later columns towards the centre). Cards overlap so that each keeps its top-left
 * corner (value + colour symbol) visible; a line that would overlap more than that wraps into another.
 * `n` cards in the given order fill left to right, top to bottom.
 */
export function openFan(n: number, side: SeatSide, d: TableDims, tilt = 0.45, s = OPEN_SCALE): OpenFan {
  const a = seatAnchor(side, d);
  const w = CARD_W * s;
  const h = CARD_H * s;
  const poses: OpenPose[] = [];
  const rows = side === 'top' || side === 'bottom';
  // a tilted card stands up a little: lift it so its near edge stays on the felt
  const lift = (h / 2) * Math.sin(tilt) + 0.012;
  let lines = 1;
  let step = 0;
  if (n > 0) {
    const size = rows ? w : h;
    const span = rows ? Math.max(0, Math.min(3.6, 2 * d.A - 0.5) - w) : Math.max(0, Math.min(2.6, d.B * 0.95));
    const minStep = size * (rows ? OPEN_MIN_STRIP_X : OPEN_MIN_STRIP_Z);
    const ideal = size * (rows ? 0.5 : 0.42);
    void minStep; // one line, compressing past the corner strip when the hand is big
    lines = 1;
    const per = n;
    step = per > 1 ? Math.min(ideal, span / (per - 1)) : 0;
    // rows: next row 40% of a card nearer the centre; columns: next column 56% of a card inwards
    const lineStep = rows ? h * 0.4 : w * 0.56;
    // inward direction for extra lines
    const inX = side === 'right' ? -1 : side === 'left' ? 1 : 0;
    const inZ = side === 'top' ? 1 : side === 'bottom' ? -1 : 0;
    // line order on screen: rows top to bottom (= inwards for top); columns left to right
    const lineOff: number[] = [];
    for (let l = 0; l < lines; l++) lineOff.push(l);
    if (side === 'bottom') lineOff.reverse(); // bottom: inner row is the screen-top one
    if (side === 'right') lineOff.reverse(); // right: inner columns are on the screen left
    let idx = 0;
    for (let li = 0; li < lines; li++) {
      const l = lineOff[li];
      const k = Math.min(per, n - idx);
      const mid = (k - 1) / 2;
      for (let j = 0; j < k; j++, idx++) {
        const t = (j - mid) * step;
        let x = a.x;
        let z = a.z;
        if (rows) {
          x += t;
          z += inZ * l * lineStep;
        } else {
          z += t;
          x += inX * l * lineStep;
        }
        poses.push({ x, y: 0, z });
      }
    }
    // draw order (y layers): the card to the right covers its left neighbour's right side, the nearer
    // card (larger z) covers the bottom of the one behind; so every card keeps its top-left corner
    const order = poses.map((p, i) => i).sort((i, k) => poses[i].z - poses[k].z || poses[i].x - poses[k].x);
    order.forEach((i, r) => (poses[i].y = lift + r * 0.0035));
  }
  let x0 = Infinity;
  let x1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  const hz = (h / 2) * Math.cos(tilt);
  for (const p of poses) {
    x0 = Math.min(x0, p.x - w / 2);
    x1 = Math.max(x1, p.x + w / 2);
    z0 = Math.min(z0, p.z - hz);
    z1 = Math.max(z1, p.z + hz);
  }
  if (!poses.length) {
    x0 = x1 = a.x;
    z0 = z1 = a.z;
  }
  return { poses, s, tilt, lines, step, cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, hx: (x1 - x0) / 2, hz: (z1 - z0) / 2 };
}

// ───────────────────────── side-seating partner (Parejas "Codo a codo") ─────────────────────────

/** the partner's flat fan is about opponent size, clearly smaller than the human's hand */
export function partnerScale(portrait: boolean): number {
  return portrait ? 0.72 : 0.88;
}

/** share of a card's width kept uncovered on its left side (corner value + colour symbol) */
export const PARTNER_STRIP_X = 0.34;

/**
 * The side-seating partner's fan: cards LIE FLAT along their side edge, upright for the viewer, as a
 * staircase from the far corner (`zFar`, below the partner's plate) down to just above the human hand
 * (`zNear`). Each nearer card sits lower AND further right, so every card keeps an uncovered strip down
 * its whole left side: the corner value and colour symbol always show. Left partner: the stairs step
 * inwards; right partner: they step out to the edge (the near card at the edge). Big hands reduce the
 * sideways step (more overlap) so the fan never reaches the centre. Reading order: top to bottom.
 */
export function partnerFan(n: number, side: 'lowerLeft' | 'lowerRight', d: TableDims, zNear: number, s = partnerScale(false), zFarIn?: number): OpenFan {
  const w = CARD_W * s;
  const h = CARD_H * s;
  const left = side === 'lowerLeft';
  const outer = d.A - 0.14 - w / 2; // |x| of a card touching the edge
  const inner = 1.35 + w / 2; // |x| limit: clear of the deck / pile
  const zFar = Math.max(-d.B + 0.15 + h / 2, zFarIn ?? -d.B + 0.3 + h / 2);
  const zBot = Math.max(zFar, Math.min(zNear - h / 2, d.B - 0.1 - h / 2));
  const span = zBot - zFar;
  const stepZ = n > 1 ? Math.min(h * 0.62, span / (n - 1)) : 0;
  const stepX = n > 1 ? Math.min(w * 0.5, Math.max(0, outer - inner) / (n - 1), w * Math.max(PARTNER_STRIP_X, 0.5)) : 0;
  // keep at least the strip while it fits; past that the run just compresses
  const len = (n - 1) * stepZ;
  const poses: OpenPose[] = [];
  for (let i = 0; i < n; i++) {
    const z = zBot - len + i * stepZ;
    // left partner: far card at the edge, stepping in; right partner: far card inside, stepping out
    const x = left ? -(outer - i * stepX) : outer - (n - 1 - i) * stepX;
    const t = n > 1 ? (i / (n - 1)) * 2 - 1 : 0;
    poses.push({ x, y: 0.012 + i * 0.0035, z, yaw: (left ? -1 : 1) * t * 0.06 });
  }
  let x0 = Infinity;
  let x1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  for (const p of poses) {
    x0 = Math.min(x0, p.x - w / 2);
    x1 = Math.max(x1, p.x + w / 2);
    z0 = Math.min(z0, p.z - h / 2);
    z1 = Math.max(z1, p.z + h / 2);
  }
  if (!poses.length) {
    x0 = x1 = left ? -outer : outer;
    z0 = z1 = zBot;
  }
  return { poses, s, tilt: 0, lines: 1, step: Math.max(stepX / w, stepZ / h), cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, hx: (x1 - x0) / 2, hz: (z1 - z0) / 2 };
}

/** an axis-aligned screen box (px) *//** an axis-aligned screen box (px); `seat`: whose fan it is (that seat's own plate may touch it) */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  seat?: number;
}

const overlaps = (a: Box, b: Box, gap: number) =>
  Math.abs(a.x - b.x) * 2 < a.w + b.w + gap && Math.abs(a.y - b.y) * 2 < a.h + b.h + gap;

/**
 * Nudge plate boxes so none overlaps another plate or an `avoid` box (the deck / pile): each later
 * plate moves vertically (then horizontally) to the nearest free spot, staying on screen below the HUD.
 * The human's plate (index order: as given) is never moved.
 */
export function separatePlates(plates: SeatPlate[], avoid: readonly Box[], W: number, H: number, hudTop: number, gap = 6, order?: readonly number[]): void {
  const placed: Box[] = [];
  const rank = (s: number) => {
    const i = order ? order.indexOf(s) : -1;
    return i < 0 ? 99 + s : i;
  };
  const list = plates.slice().sort((a, b) => (a.seat === 0 ? -1 : b.seat === 0 ? 1 : rank(a.seat) - rank(b.seat)));
  for (const p of list) {
    if (!p.visible) continue;
    const fixed = p.seat === 0;
    const clash = (b: Box) => placed.some((q) => overlaps(b, q, gap)) || avoid.some((q) => q.seat !== p.seat && overlaps(b, q, gap));
    if (!fixed && clash(p)) {
      let best: Box | null = null;
      let bestD = Infinity;
      const stepPx = 6;
      for (let k = 1; k <= 60 && !best; k++) {
        for (const [dx, dy] of [[0, -k], [0, k], [k, 0], [-k, 0], [k, -k], [-k, -k], [k, k], [-k, k]]) {
          const b = { x: p.x + dx * stepPx, y: p.y + dy * stepPx, w: p.w, h: p.h };
          if (b.x - b.w / 2 < 4 || b.x + b.w / 2 > W - 4 || b.y - b.h / 2 < hudTop || b.y + b.h / 2 > H - 4) continue;
          const dd = Math.hypot(dx, dy);
          if (!clash(b) && dd < bestD) {
            best = b;
            bestD = dd;
          }
        }
      }
      if (best) {
        const dx = best.x - p.x;
        const dy = best.y - p.y;
        p.x = best.x;
        p.y = best.y;
        if (p.bubble) {
          p.bubble.x += dx;
          p.bubble.y += dy;
        }
      }
    }
    placed.push({ x: p.x, y: p.y, w: p.w, h: p.h });
  }
}

// ───────────────────────── plates (screen px) ─────────────────────────

export interface PlateInput {
  seat: Seat;
  side: SeatSide;
  /** projected fan centre (px, y down) — bottom seat: unused */
  ax: number;
  ay: number;
  /** projected half-extent of the fan along the screen (px) */
  halfX: number;
  halfY: number;
  count: number;
  active: boolean;
  winner: boolean;
  scale: number;
  visible: boolean;
}

export interface PlateEnv {
  W: number;
  H: number;
  /** HUD strip at the top (px) nothing of ours goes into */
  hudTop: number;
  /** top px of the human hand */
  handTop: number;
  /** leftmost px of the human hand (landscape: the human plate sits beside the hand when there is room) */
  handLeft?: number;
  portrait: boolean;
  /** the human's plate goes to the right (the side-seating partner's fan owns the lower-left) */
  humanRight?: boolean;
  /** landscape top seat: force its plate to this side of the fan (side seating: away from the partner) */
  topPlateSide?: 'left' | 'right';
  /** side seats put their plate below their fan (side seating: the top corners belong to the others) */
  sidePlateBelow?: boolean;
}

/** avatar diameter for a viewport */
export function plateDiameter(W: number, H: number): number {
  return Math.round(Math.max(34, Math.min(56, Math.min(W, H) * 0.11)));
}

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

/** lay out one HTML plate box for a seat; boxes are clamped fully on screen below the HUD */
export function plateBox(p: PlateInput, env: PlateEnv): SeatPlate {
  const d = plateDiameter(env.W, env.H);
  // room for the avatar, a 10-character name and the count
  const rowW = Math.round(d * 3.8);

  const rowH = d;
  const stackW = Math.round(Math.max(d + 18, d * 1.45));
  const stackH = Math.round(d * 1.36);
  let layout: 'row' | 'stack' = 'row';
  let x = 0;
  let y = 0;
  let bdir: 'left' | 'right' | 'up' | 'down' = 'up';
  const gap = 6;
  switch (p.side) {
    case 'bottom':
      x = rowW / 2 + 10;
      y = env.handTop - rowH / 2 - gap;
      if (!env.portrait && env.handLeft !== undefined && env.handLeft - 12 >= rowW + 10) {
        x = env.handLeft - 12 - rowW / 2;
        y = env.H - rowH / 2 - 12;
      }
      if (env.humanRight) x = env.W - x;
      bdir = 'up';
      break;
    case 'top':
      if (env.portrait) {
        x = p.ax;
        y = p.ay + p.halfY + rowH / 2 + gap;
      } else {
        x = p.ax - p.halfX - rowW / 2 - gap;
        y = p.ay;
        // a wide fan (an open hand) would push the plate into the left seat's corner: go right instead
        if (env.topPlateSide === 'right' || (!env.topPlateSide && x - rowW / 2 < env.W * 0.24)) x = p.ax + p.halfX + rowW / 2 + gap;
      }
      bdir = 'down';
      break;
    case 'lowerLeft':
    case 'lowerRight': {
      // above the partner fan, aligned to its outer edge; the bubble opens towards the table centre
      // at the far end of the partner fan: above it, or beside it (inner side) when the HUD is in the way
      const left = p.side === 'lowerLeft';
      x = left ? p.ax - p.halfX + rowW / 2 : p.ax + p.halfX - rowW / 2;
      y = p.ay - p.halfY - rowH / 2 - gap;
      if (y - rowH / 2 < env.hudTop - rowH * 0.35) {
        x = left ? p.ax + p.halfX + rowW / 2 + gap : p.ax - p.halfX - rowW / 2 - gap;
        y = p.ay - p.halfY + rowH / 2;
      }
      bdir = left ? 'right' : 'left';
      break;
    }
    case 'right':
    case 'left': {
      layout = env.portrait ? 'stack' : 'row';

      const h = layout === 'stack' ? stackH : rowH;
      x = p.ax;
      y = env.sidePlateBelow ? p.ay + p.halfY + h / 2 + gap : p.ay - p.halfY - h / 2 - gap;
      bdir = p.side === 'right' ? 'left' : 'right';
      break;
    }
  }
  const w = layout === 'row' ? rowW : stackW;
  const h = layout === 'row' ? rowH : stackH;
  x = clamp(x, w / 2 + 4, env.W - w / 2 - 4);
  y = clamp(y, env.hudTop + h / 2, env.H - h / 2 - 4);
  const bx = bdir === 'left' ? x - w / 2 : bdir === 'right' ? x + w / 2 : x;
  const by = bdir === 'up' ? y - h / 2 : bdir === 'down' ? y + h / 2 : y;
  return {
    seat: p.seat, x, y, w, h, d, layout, scale: p.scale, visible: p.visible, active: p.active, winner: p.winner, count: p.count,
    bubble: { x: bx, y: by, dir: bdir },
  };
}

/** project a world point to CSS px (y down) with a column-major view-projection matrix */
export function projectCss(vp: ArrayLike<number>, x: number, y: number, z: number, W: number, H: number, out: { x: number; y: number }): boolean {
  const e = vp;
  const cx = e[0] * x + e[4] * y + e[8] * z + e[12];
  const cy = e[1] * x + e[5] * y + e[9] * z + e[13];
  const cw = e[3] * x + e[7] * y + e[11] * z + e[15];
  if (cw <= 1e-6) {
    out.x = NaN;
    out.y = NaN;
    return false;
  }
  out.x = (cx / cw * 0.5 + 0.5) * W;
  out.y = (1 - (cy / cw * 0.5 + 0.5)) * H;
  return true;
}

export const ALL_COLORS: Color[] = ['sol', 'mar', 'palma', 'coral'];
