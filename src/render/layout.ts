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
  // scales with the screen (a fifth of the height in hand on a phone and on a desktop alike)
  return Math.max(44, Math.min(176, W * 0.2, 14 + H * 0.13));
}

/** minimum visible strip per card (px): always a comfortable finger width */
export function fanMinTap(cw: number): number {
  return Math.max(22, Math.round(cw * 0.3));
}

/** the human's row is at most this many card widths, and this fraction of the screen, wide */
export const HAND_MAX_CARDS = 9;
export const HAND_MAX_FRAC = 0.6;

/** fraction of the human's cards hidden below the bottom of the screen */
export const HAND_HIDDEN = 0.2;

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
  // the row never grows past ~9 cards wide or 60% of a wide screen (phones keep their full width): a big
  // hand overlaps more instead
  const usable = Math.max(cw, Math.min(avail - 2 * rotPad, cw * HAND_MAX_CARDS, Math.max(W * HAND_MAX_FRAC, 560)));
  // never wrap: one row that overlaps more and more (the peek is how a squeezed card is read)
  const rows = 1;
  const perRow = n;
  const ideal = cw * 0.62;
  const spacing = perRow > 1 ? Math.min(ideal, (usable - cw) / (perRow - 1)) : 0;
  // a straight row: no turn, no arc
  const step = 0;
  const R = 0;
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
  // drop the whole hand so the bottom 20% of the cards hides below the screen edge
  const dy = H - (o.safeB ?? 0) + ch * HAND_HIDDEN - maxBottom;
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
  /** how the tuned table adapts to this screen (tableFit); none = as tuned */
  fit?: TableFit;
}

/**
 * The tuned table on a screen narrower than the one it was tuned on: instead of pulling the camera back
 * until the whole tuned width fits (everything tiny in a big empty middle), the camera pulls back only
 * part of the way (`c`), the table's spots close in sideways (`sx`) and spread in depth (`sz`, filling the
 * taller screen) and the cards grow (`s`), so the fans, deck and pile stay big and near the edges.
 */
export interface TableFit {
  c: number;
  sx: number;
  sz: number;
  s: number;
}

export function tableFit(W: number, H: number, portrait: boolean): TableFit {
  const T = portrait ? TABLE_LAYOUT.port : TABLE_LAYOUT.land;
  const k = Math.min(1, W / Math.max(1, H) / T.aspect);
  const c = 1 / Math.sqrt(k);
  return { c, sx: c * k, sz: c, s: Math.sqrt(c) };
}

/** the felt; with a screen size, the table adapted to it (tableFit) */
export function tableDims(portrait: boolean, W?: number, H?: number): TableDims {
  const d: TableDims = portrait ? { A: 2.05, B: 2.9 } : { A: 3.9, B: 2.15 };
  if (W && H) d.fit = tableFit(W, H, portrait);
  return d;
}

/**
 * The table camera's tilt from looking straight down (radians) and its vertical fov (degrees): a little
 * lower than top-down so the standing hands read as standing; Codo a codo (landscape) lower still.
 */
export function cameraTilt(portrait: boolean, sideMode: boolean): number {
  return portrait ? 0.46 : sideMode ? 0.68 : 36.5 * (Math.PI / 180);
}
export function cameraFov(portrait: boolean): number {
  return portrait ? 42 : 38;
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

/** an axis-aligned screen box (px); `seat`: whose fan it is (that seat's own plate may touch it, never cover it) */
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
 * The human's plate is moved only off another seat's hand.
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
    // the human's plate stays put unless another seat's hand is under it
    const fixed = p.seat === 0 && !avoid.some((q) => q.seat !== undefined && q.seat !== 0 && overlaps(p, q, 0));
    const clash = (b: Box) => placed.some((q) => overlaps(b, q, gap)) || avoid.some((q) => overlaps(b, q, q.seat === p.seat ? -1 : gap));
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
  /** landscape: side seats put their plate beside their row on the inner side, level with its near end */
  sidePlateInner?: boolean;
  /** x range (px) the top seat's plate keeps inside (clear of the side rows) */
  topClear?: [number, number];
}

/** avatar diameter for a viewport (portrait phones: a little bigger, there is room beside the fans) */
export function plateDiameter(W: number, H: number): number {
  const m = Math.min(W, H);
  // bigger faces everywhere, and they keep growing on wide screens
  return Math.round(H > W * 1.05 ? Math.max(48, Math.min(80, m * 0.15)) : Math.max(44, Math.min(88, m * 0.12)));
}

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

/** lay out one HTML plate box for a seat; boxes are clamped fully on screen below the HUD */
export function plateBox(p: PlateInput, env: PlateEnv): SeatPlate {
  const d = plateDiameter(env.W, env.H);
  // room for the avatar, a 10-character name and the count
  const rowW = Math.round(d * 3.8);

  const rowH = d;
  // every compact plate the same width, wide enough for a full name and the card count at its end
  const stackW = Math.round(Math.min(d * 2.4, Math.max(100, d * 2.1)));
  const stackH = Math.round(d * 1.36);
  // every seat uses the compact plate (the wide row plate is no longer used)
  let layout = 'stack' as 'row' | 'stack';
  let x = 0;
  let y = 0;
  let bdir: 'left' | 'right' | 'up' | 'down' = 'up';
  const gap = 6;
  switch (p.side) {
    case 'bottom':
      // the compact plate, like everyone's, just left of the hand (above it when there is no room)
      layout = 'stack';
      x = stackW / 2 + 10;
      y = env.handTop - stackH / 2 - gap;
      if (env.handLeft !== undefined && env.handLeft - 10 >= stackW + 4) {
        x = env.handLeft - 10 - stackW / 2;
        y = env.H - stackH / 2 - 8;
      }
      // always on the left of the hand (the ¡Ku! button takes the right), whatever the seating
      bdir = 'up';
      break;
    case 'top':
      if (env.portrait) {
        // the compact plate, like every seat's, just under the hand
        layout = 'stack';
        x = p.ax;
        y = p.ay + p.halfY + stackH / 2 + gap;
      } else {
        // beside the row, clear of the top corners when the side seats' plates live there; when neither
        // side has room (a long row), below it
        const corner = env.sidePlateInner ? 4 : env.W * 0.24;
        const cl = Math.max(corner, (env.topClear?.[0] ?? 0) + gap);
        const cr = Math.min(env.W - corner, (env.topClear?.[1] ?? env.W) - gap);
        // the compact plate, like every seat's
        layout = 'stack';
        const pw = layout === 'stack' ? stackW : rowW;
        const lx = p.ax - p.halfX - pw / 2 - gap;
        const rx = p.ax + p.halfX + pw / 2 + gap;
        const lOk = lx - pw / 2 >= cl;
        const rOk = rx + pw / 2 <= cr;
        const pref = env.topPlateSide === 'right' ? [rOk, lOk] : [lOk, rOk];
        const first = env.topPlateSide === 'right' ? rx : lx;
        const second = env.topPlateSide === 'right' ? lx : rx;
        y = p.ay;
        if (pref[0]) x = first;
        else if (pref[1]) x = second;
        else {
          x = p.ax;
          y = p.ay + p.halfY + rowH / 2 + gap;
        }
      }
      bdir = 'down';
      break;
    case 'lowerLeft':
    case 'lowerRight': {
      // above the partner fan, aligned to its outer edge; the bubble opens towards the table centre
      // at the far end of the partner fan: above it, or beside it (inner side) when the HUD is in the way
      const left = p.side === 'lowerLeft';
      x = left ? p.ax - p.halfX + stackW / 2 : p.ax + p.halfX - stackW / 2;
      y = p.ay - p.halfY - stackH / 2 - gap;
      if (y - stackH / 2 < env.hudTop - stackH * 0.35) {
        x = left ? p.ax + p.halfX + stackW / 2 + gap : p.ax - p.halfX - stackW / 2 - gap;
        y = p.ay - p.halfY + stackH / 2;
      }
      bdir = left ? 'right' : 'left';
      break;
    }
    case 'right':
    case 'left': {
      layout = 'stack';

      const h = layout === 'stack' ? stackH : rowH;
      const w = layout === 'stack' ? stackW : rowW;
      if (env.sidePlateInner) {
        // landscape: outside the fan (towards the screen edge), level with its far end, clear of the human hand
        x = p.side === 'left' ? p.ax - p.halfX - w / 2 - gap : p.ax + p.halfX + w / 2 + gap;
        y = p.ay - p.halfY + h / 2;
      } else {
        x = p.ax;
        y = p.ay - p.halfY - h / 2 - gap;
      }
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

// ───────────────────────── the other seats' hands: the human's fan, held at each seat (3D) ─────────────────────────

/** HUD strip at the top of the screen (px): plates and hands stay below it */
export const HUD_TOP = 56;

/** card scale of a face-down hand at a seat (the human's cards are about 1 on screen) */
export const OPP_SCALE = 0.6;
export function oppScale(portrait: boolean): number {
  return portrait ? 0.7 : 0.54;
}
/**
 * An open (face-up) partner hand is the same size as the hand across the table from it: the top partner
 * like a face-down top hand, a side partner (Codo a codo) like the side opponents' fans (SIDE_FAN).
 */
export function openHandScale(portrait: boolean, side: SeatSide = 'top'): number {
  return tunedHand(1, side === 'bottom' ? 'top' : side, true, portrait).s;
}
/** portrait: how much bigger the top partner's open hand is than a face-down top hand */
export const OPEN_TOP_GROW = 1.25;
/** a held hand leans back from vertical, its top towards the holder (radians) */
export const HAND_LEAN = 0.35;
/** an open hand leans back further, so its faces tilt up towards the camera */
export const OPEN_LEAN = 0.6;

/**
 * One card of a seat's hand: its centre, and its orientation = rotY(yaw) * rotX(lean) * rotZ(-roll): the
 * card's face looks along that frame's +Z (towards the holder for a hidden hand, towards the table centre
 * for an open one), leaning `lean` back about the card's own X axis, turned `roll` in its plane like the
 * human's fan (clockwise seen from the face side).
 */
export interface HandPose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  lean: number;
  roll: number;
  /** the full card rotation (x, y, z, w); when present it wins over yaw / lean / roll */
  q?: [number, number, number, number];
}

export interface SeatHand {
  poses: HandPose[];
  s: number;
  /** the fan: distance between neighbours and angle between them (the human fan's rule) */
  spacing: number;
  step: number;
  /** the seat's facing: the yaw that turns the holder's frame to the seat (+Z towards the holder) */
  holdYaw: number;
  /** where the hand is held (table plane) */
  ax: number;
  az: number;
  /** world box of all the cards */
  x0: number;
  x1: number;
  y1: number;
  z0: number;
  z1: number;
  cx: number;
  cz: number;
}

/** the human fan's rule: neighbour distance (from the widest the fan may get) and angle */
export function fanSpread(n: number, cw: number, maxW: number): { spacing: number; step: number } {
  const spacing = n > 1 ? Math.min(cw * 0.62, Math.max(0, maxW - cw) / (n - 1)) : 0;
  const step = n > 1 ? Math.min(0.075, 0.44 / (n - 1)) : 0;
  return { spacing, step };
}

/** rotate a local point by rotY(yaw) * rotX(lean) (in place into out) */
function toWorld(x: number, y: number, z: number, yaw: number, lean: number, out: number[], o: number): void {
  const cl = Math.cos(lean);
  const sl = Math.sin(lean);
  const y1 = y * cl - z * sl;
  const z1 = y * sl + z * cl;
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  out[o] = x * cy + z1 * sy;
  out[o + 1] = y1;
  out[o + 2] = -x * sy + z1 * cy;
}

const cornerTmp: number[] = new Array(12).fill(0);
/** world corners (x, y, z triplets) of a hand card: bottom-left, bottom-right, top-right, top-left seen from its face */
export function handCardCorners(p: HandPose, s: number, out: number[] = new Array(12).fill(0)): number[] {
  const w = CARD_W * s;
  const h = CARD_H * s;
  const c = Math.cos(p.roll);
  const si = Math.sin(p.roll);
  const SG = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  for (let k = 0; k < 4; k++) {
    const lx = (SG[k][0] * w) / 2;
    const ly = (SG[k][1] * h) / 2;
    if (p.q) {
      qRotate(p.q, lx, ly, 0, out, k * 3);
      out[k * 3] += p.x;
      out[k * 3 + 1] += p.y;
      out[k * 3 + 2] += p.z;
      continue;
    }
    // rotZ(-roll): clockwise seen from the face
    toWorld(lx * c + ly * si, -lx * si + ly * c, 0, p.yaw, p.lean, out, k * 3);
    out[k * 3] += p.x;
    out[k * 3 + 1] += p.y;
    out[k * 3 + 2] += p.z;
  }
  return out;
}

/** the face direction of a hand card (unit, world) */
export function handCardNormal(p: HandPose): [number, number, number] {
  const o = [0, 0, 0];
  if (p.q) qRotate(p.q, 0, 0, 1, o, 0);
  else toWorld(0, 0, 1, p.yaw, p.lean, o, 0);
  return [o[0], o[1], o[2]];
}

/** the yaw that turns a holder's frame (+Z towards the holder) to a seat */
export function seatHoldYaw(side: SeatSide): number {
  return side === 'top' ? Math.PI : side === 'left' || side === 'lowerLeft' ? -Math.PI / 2 : side === 'right' || side === 'lowerRight' ? Math.PI / 2 : 0;
}

/**
 * A seat's hand: the human's fan (same arc, spread and overlap rule) built in the holder's frame, leaning
 * back about the cards' own X axis, held near that seat's edge and turned about the world vertical so it
 * opens towards the table centre (top seat 180 degrees, left -90, right +90). A hidden hand shows us its
 * backs; an open hand (the partner showing their cards) is turned around so its faces look towards the
 * table centre, tilted up towards the camera, read left to right. Big hands squeeze the spread like the
 * human's; never a second row.
 */
export function seatHand(n: number, side: SeatSide, open: boolean, d: TableDims, portrait: boolean): SeatHand {
  // the bottom seat is the human (screen-space fan); anyone else holds the hand tuned in the fan demo
  return tunedHand(n, side === 'bottom' ? 'top' : side, open, portrait, d);
}

// ───────────────────────── the table as tuned in fan-demo.html ─────────────────────────

/** One player's hand as tuned in the fan demo (table units; angles in degrees). */
export interface FanTune {
  rotX: number;
  rotY: number;
  rotZ: number;
  posX: number;
  posY: number;
  posZ: number;
  scale: number;
  spacing: number;
  angle: number;
  arc: number;
  curve: number;
  /** cards that fit at full spacing; more squeeze into the same length */
  fullCards: number;
}
export interface TableTune {
  /** camera tilt from straight down (deg), distance from the table centre, vertical fov (deg) */
  camera: { tilt: number; dist: number; fov: number };
  /** the whole table's turn about X (deg); the view folds it into the camera tilt */
  tableRotX: number;
  top: FanTune;
  left: FanTune;
  right: FanTune;
  /** the deck's centre and turn about the vertical (deg) */
  deck: { x: number; z: number; yaw: number };
  pile: { x: number; z: number };
  /** avatar plate centres, in % of the screen */
  avatars: Record<'me' | 'top' | 'left' | 'right', [number, number]>;
  /** the screen shape the layout was tuned on (W / H) */
  aspect: number;
}

/** The user's layout from the fan demo (landscape and portrait). */
export const TABLE_LAYOUT: { land: TableTune; port: TableTune } = {
  land: {
    camera: { tilt: 36.5, dist: 9.1, fov: 38 },
    tableRotX: -5,
    top: { rotX: 20, rotY: 180, rotZ: 0, posX: 0.05, posY: 0.2, posZ: -2, scale: 1, spacing: 0.42, angle: 4.3, arc: 0.01, curve: 0.01, fullCards: 7 },
    right: { rotX: -5, rotY: 110, rotZ: 0, posX: 3.2, posY: 0.28, posZ: 0.6, scale: 1.14, spacing: 0.36, angle: 3, arc: 0, curve: 0.02, fullCards: 7 },
    left: { rotX: -5, rotY: -110, rotZ: 0, posX: -3.2, posY: 0.28, posZ: 0.6, scale: 1.14, spacing: 0.36, angle: 3, arc: 0, curve: 0.02, fullCards: 7 },
    deck: { x: -2.1, z: -1.55, yaw: 45 },
    pile: { x: 0, z: -0.05 },
    avatars: { me: [12, 88], top: [28, 15.5], left: [8, 22], right: [92, 22] },
    aspect: 915 / 412,
  },
  port: {
    camera: { tilt: 26, dist: 11, fov: 42 },
    tableRotX: -15,
    top: { rotX: 20, rotY: 180, rotZ: 0, posX: 0, posY: 0.05, posZ: -2.45, scale: 0.7, spacing: 0.32, angle: 4.3, arc: 0.01, curve: 0, fullCards: 7 },
    right: { rotX: 0, rotY: 105, rotZ: 0, posX: 1.2, posY: 0.32, posZ: 0.25, scale: 0.84, spacing: 0.38, angle: 5.5, arc: 0.01, curve: 0.01, fullCards: 7 },
    left: { rotX: 0, rotY: -105, rotZ: 0, posX: -1.2, posY: 0.32, posZ: 0.25, scale: 0.84, spacing: 0.38, angle: 5.5, arc: 0.01, curve: 0.01, fullCards: 7 },
    deck: { x: -1.4, z: -2.35, yaw: 30 },
    pile: { x: 0, z: 0 },
    avatars: { me: [10, 65], top: [83.5, 16.5], left: [8.5, 35.5], right: [90.5, 35] },
    aspect: 412 / 915,
  },
};

/** the tuned table; with `d.fit`, adapted to the screen (see TableFit) */
export function tableTune(portrait: boolean, d?: TableDims): TableTune {
  const T = portrait ? TABLE_LAYOUT.port : TABLE_LAYOUT.land;
  const f = d?.fit;
  if (!f || (f.sx === 1 && f.sz === 1 && f.s === 1)) return T;
  // the top row keeps its share of the screen width (its cards just overlap more)
  const fan = (F: FanTune, top: boolean): FanTune => ({
    ...F, posX: F.posX * f.sx, posZ: F.posZ * f.sz, scale: F.scale * f.s, spacing: top ? (F.spacing * f.sx) / f.s : F.spacing,
  });
  return {
    ...T, top: fan(T.top, true), left: fan(T.left, false), right: fan(T.right, false),
    // the deck spreads less in depth, clear of the (bigger) top row
    deck: { ...T.deck, x: T.deck.x * f.sx, z: T.deck.z * (1 + (f.sz - 1) * 0.5) }, pile: { x: T.pile.x * f.sx, z: T.pile.z * f.sz },
  };
}

const D2R = Math.PI / 180;

/**
 * The camera for a screen: the tuned tilt (plus the table's own tilt) and fov, the tuned distance pulled
 * back part of the way when the screen is narrower than the one it was tuned on (tableFit: the table's
 * spots close in the rest of the way).
 */
export function tableCamera(W: number, H: number, portrait: boolean): { tilt: number; fov: number; dist: number } {
  const T = tableTune(portrait);
  return {
    tilt: (T.camera.tilt - T.tableRotX) * D2R,
    fov: T.camera.fov,
    dist: T.camera.dist * tableFit(W, H, portrait).c,
  };
}

type Q = [number, number, number, number];
function qMul(a: Q, b: Q): Q {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}
const qX = (a: number): Q => [Math.sin(a / 2), 0, 0, Math.cos(a / 2)];
const qY = (a: number): Q => [0, Math.sin(a / 2), 0, Math.cos(a / 2)];
const qZ = (a: number): Q => [0, 0, Math.sin(a / 2), Math.cos(a / 2)];
/** rotate (x, y, z) by a unit quaternion into out[o..o+2] */
function qRotate(q: Q, x: number, y: number, z: number, out: number[], o: number): void {
  const [qx, qy, qz, qw] = q;
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  out[o] = x + qw * tx + (qy * tz - qz * ty);
  out[o + 1] = y + qw * ty + (qz * tx - qx * tz);
  out[o + 2] = z + qw * tz + (qx * ty - qy * tx);
}

/**
 * A seat's hand built exactly like the fan demo: cards stand in the holder's frame (faces towards the
 * holder, +Z), fan out `spacing` apart and `angle` degrees each, sag by `arc`, bow by `curve`, and squeeze
 * past `fullCards`; then the whole fan is turned (Euler YXZ) and placed. An open hand (the partner
 * showing their cards) is turned around so its faces show on the far side, as the demo's face-up flag.
 */
function tunedHand(n: number, side: SeatSide, open: boolean, portrait: boolean, d?: TableDims): SeatHand {
  const T = tableTune(portrait, d);
  let F = side === 'top' ? T.top : side === 'left' || side === 'lowerLeft' ? T.left : T.right;
  // portrait: the partner's open hand across the table is a little bigger so its faces can be read (same
  // row length, a touch nearer the middle, clear of the HUD)
  if (portrait && open && side === 'top') F = { ...F, scale: F.scale * OPEN_TOP_GROW, spacing: F.spacing / OPEN_TOP_GROW, posZ: F.posZ + 0.18 };
  const full = Math.max(2, F.fullCards);
  const sq = n > full ? (full - 1) / (n - 1) : 1;
  const sp0 = F.spacing;
  const sp = sp0 * sq;
  const ang = F.angle * D2R * sq;
  const s = F.scale;
  const g = qMul(qMul(qY(F.rotY * D2R), qX(F.rotX * D2R)), qZ(F.rotZ * D2R));
  // the Codo a codo partner (beside the human) bows the other way: a negative curve
  const curve = side === 'lowerLeft' || side === 'lowerRight' ? -Math.abs(F.curve) : F.curve;
  const mid = (n - 1) / 2;
  const poses: HandPose[] = [];
  const pt = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const di = i - mid;
    const layer = (open ? -i : i) * 0.01;
    let x = di * sp;
    const y = CARD_H / 2 - di * sq * di * sq * F.arc;
    let z = layer;
    const rz = (open ? di : -di) * ang;
    if (open) x = -x;
    let yawC = 0;
    if (curve !== 0 && sp0 > 0) {
      const k = (2 * curve) / (sp0 * sp0);
      const th = x * k;
      const gap = Math.max(0, CARD_W - sp) * Math.abs(Math.sin(sp * k)) + 0.004;
      const lz = (open ? -1 : 1) * (i * gap - ((n - 1) * gap) / 2);
      x = Math.sin(th) / k - Math.sin(th) * lz;
      z += (1 - Math.cos(th)) / k + Math.cos(th) * lz - layer;
      yawC = -th;
    }
    let qc = qMul(qY(yawC), qZ(rz));
    if (open) qc = qMul(qc, qY(Math.PI));
    qRotate(g, x * s, y * s, z * s, pt, 0);
    poses.push({ x: F.posX + pt[0], y: F.posY + pt[1], z: F.posZ + pt[2], yaw: F.rotY * D2R, lean: F.rotX * D2R, roll: di * ang, q: qMul(g, qc) });
  }
  // never into the felt: a hand whose lowest corner would dip below it is lifted just clear
  let minY = Infinity;
  for (const p of poses) {
    handCardCorners(p, s, cornerTmp);
    for (let c = 1; c < 12; c += 3) minY = Math.min(minY, cornerTmp[c]);
  }
  if (minY < 0.004) for (const p of poses) p.y += 0.004 - minY;
  let x0 = Infinity;
  let x1 = -Infinity;
  let y1 = 0;
  let z0 = Infinity;
  let z1 = -Infinity;
  for (const p of poses) {
    handCardCorners(p, s, cornerTmp);
    for (let c = 0; c < 12; c += 3) {
      x0 = Math.min(x0, cornerTmp[c]);
      x1 = Math.max(x1, cornerTmp[c]);
      y1 = Math.max(y1, cornerTmp[c + 1]);
      z0 = Math.min(z0, cornerTmp[c + 2]);
      z1 = Math.max(z1, cornerTmp[c + 2]);
    }
  }
  if (!poses.length) {
    x0 = x1 = F.posX;
    z0 = z1 = F.posZ;
  }
  return { poses, s, spacing: sp * s, step: ang, holdYaw: seatHoldYaw(side), ax: F.posX, az: F.posZ, x0, x1, y1, z0, z1, cx: (x0 + x1) / 2, cz: (z0 + z1) / 2 };
}

/** the screen box (px) of a hand's world box, through a projector */
export function handScreenBox(f: SeatHand, project: (x: number, y: number, z: number, out: { x: number; y: number }) => boolean, out: Box, tmp = { x: 0, y: 0 }): Box {
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (let k = 0; k < 8; k++) {
    project(k & 1 ? f.x1 : f.x0, k & 2 ? f.y1 : 0, k & 4 ? f.z1 : f.z0, tmp);
    x0 = Math.min(x0, tmp.x);
    x1 = Math.max(x1, tmp.x);
    y0 = Math.min(y0, tmp.y);
    y1 = Math.max(y1, tmp.y);
  }
  out.x = (x0 + x1) / 2;
  out.y = (y0 + y1) / 2;
  out.w = x1 - x0;
  out.h = y1 - y0;
  return out;
}

/** top corners (x, y, z triplets) of each seat's widest hand: the camera framing keeps them below the HUD */
export function handFitPoints(seats: readonly number[], sides: Record<number, SeatSide>, openable: (seat: number) => boolean, d: TableDims, portrait: boolean, out: number[]): number[] {
  out.length = 0;
  for (const st of seats) {
    const side = sides[st] ?? SEAT_SIDE[st];
    if (st === 0 || side === 'bottom') continue;
    const hands = [seatHand(30, side, false, d, portrait)];
    if (openable(st)) hands.push(seatHand(30, side, true, d, portrait));
    for (const f of hands) for (const x of [f.x0, f.x1]) for (const z of [f.z0, f.z1]) out.push(x, f.y1, z);
  }
  return out;
}

export interface PlateSeat {
  seat: Seat;
  side: SeatSide;
  count: number;
  /** that seat's hand (null for the human) */
  hand: SeatHand | null;
  active: boolean;
  winner: boolean;
  scale: number;
  visible: boolean;
}

/**
 * Every seat's plate box (px) next to its hand (plateBox: beside / above / below the hand's screen box),
 * then nudged so none covers another plate, the deck / pile (`pile`), the human hand or any hand.
 */
export function layoutPlates(
  W: number, H: number, portrait: boolean, project: (x: number, y: number, z: number, out: { x: number; y: number }) => boolean,
  list: readonly PlateSeat[], n0: number, pile: Box,
): { plates: SeatPlate[]; handBoxes: Box[]; avoid: Box[] } {
  const hf = fanLayout(Math.max(7, n0), { W, H });
  const ps = list.find((p) => p.side === 'lowerLeft' || p.side === 'lowerRight');
  const env: PlateEnv = {
    W, H, hudTop: HUD_TOP, handTop: hf.top, handLeft: fanLeft(hf), portrait,
    humanRight: ps?.side === 'lowerLeft',
    // landscape: the side seats' plates (the partner's too) go beside their hands on the inner side, level
    // with the near end (the top band is short); the top seat's plate beside its hand
    sidePlateInner: !portrait,
  };
  const handBoxes: Box[] = [];
  const boxes = list.map((p) => {
    if (p.side === 'bottom' || !p.hand) return null;
    const b = handScreenBox(p.hand, project, { x: 0, y: 0, w: 0, h: 0 });
    b.h += 6;
    b.seat = p.seat;
    if (p.count > 0) handBoxes.push(b);
    return b;
  });
  // the top seat's plate stays between the side hands that reach up beside the top hand
  const topBox = boxes.find((b, i) => b && list[i].side === 'top');
  if (topBox) {
    let l = 0;
    let r = W;
    boxes.forEach((b, i) => {
      if (!b || list[i].side === 'top' || b.y - b.h / 2 > topBox.y + topBox.h / 2 + 30) return;
      if (b.x < W / 2) l = Math.max(l, b.x + b.w / 2);
      else r = Math.min(r, b.x - b.w / 2);
    });
    env.topClear = [l, r];
  }
  const plates = list.map((p, i) => {
    const b = boxes[i];
    const side = !portrait && p.side === 'lowerLeft' ? 'left' : !portrait && p.side === 'lowerRight' ? 'right' : p.side;
    return plateBox({
      seat: p.seat, side, ax: b?.x ?? 0, ay: b?.y ?? 0, halfX: (b?.w ?? 0) / 2, halfY: (b?.h ?? 0) / 2,
      count: p.count, active: p.active, winner: p.winner, scale: p.scale, visible: p.visible,
    }, env);
  });
  // a side plate beside a wide hand reaching the deck / pile goes up level with the hand's far end instead
  plates.forEach((pl, i) => {
    const b = boxes[i];
    if (portrait || !b || list[i].side === 'top' || !overlaps(pl, pile, 6)) return;
    const y = Math.max(HUD_TOP + pl.h / 2, b.y - b.h / 2 + pl.h / 2);
    if (pl.bubble) pl.bubble.y += y - pl.y;
    pl.y = y;
  });
  const hl = Math.max(0, fanLeft(hf));
  const avoid: Box[] = [pile, { x: W / 2, y: (hf.top + H) / 2, w: W - 2 * hl, h: H - hf.top, seat: 0 }, ...handBoxes];
  // side seating: the partner's slot first, then the side opponent, the top seat last
  const order = ps
    ? [0, ps.seat, ...list.filter((p) => p.seat !== 0 && p !== ps && p.side !== 'top').map((p) => p.seat), ...list.filter((p) => p.side === 'top').map((p) => p.seat)]
    : undefined;
  void order;
  // every plate starts where the fan demo put that seat's avatar (% of the screen), then is drawn in
  // towards its own cards until it sits just beside them (on big screens the % spot drifts away)
  const av = tableTune(portrait).avatars;
  const pt = { x: 0, y: 0 };
  plates.forEach((pl, i) => {
    const ps = list[i];
    const side = ps.side;
    const key = side === 'bottom' ? 'me' : side === 'top' ? 'top' : side === 'left' || side === 'lowerLeft' ? 'left' : 'right';
    let x = (av[key][0] / 100) * W;
    let y = (av[key][1] / 100) * H;
    if (side === 'bottom') {
      // the human's own spot is beside the hand (plateBox), not the % one
      x = pl.x;
      y = pl.y;
    } else if (ps.hand && ps.hand.poses.length) {
      // the nearest card corner on screen
      let bx = x;
      let by = y;
      let best = Infinity;
      for (const c of ps.hand.poses) {
        handCardCorners(c, ps.hand.s, cornerTmp);
        for (let k = 0; k < 12; k += 3) {
          project(cornerTmp[k], cornerTmp[k + 1], cornerTmp[k + 2], pt);
          const d = (pt.x - x) ** 2 + (pt.y - y) ** 2;
          if (d < best) {
            best = d;
            bx = pt.x;
            by = pt.y;
          }
        }
      }
      const d = Math.sqrt(best);
      const gap = Math.max(pl.w, pl.h) / 2 + 8;
      if (d > gap) {
        x = bx + ((x - bx) / d) * gap;
        y = by + ((y - by) / d) * gap;
      }
    }
    x = clamp(x, pl.w / 2 + 4, W - pl.w / 2 - 4);
    y = clamp(y, pl.h / 2 + 4, H - pl.h / 2 - 4);
    if (pl.bubble) {
      pl.bubble.x += x - pl.x;
      pl.bubble.y += y - pl.y;
    }
    pl.x = x;
    pl.y = y;
  });
  // no plate over the deck or the pile: step it just clear (the shortest way that stays on screen and
  // off the other seats' hands)
  const tt = tableTune(portrait, tableDims(portrait, W, H));
  const spot = (cx: number, cz: number, r: number): Box => {
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (let k = 0; k < 8; k++) {
      project(cx + (k & 1 ? r : -r), k & 4 ? 0.2 : 0, cz + (k & 2 ? r : -r), pt);
      x0 = Math.min(x0, pt.x);
      x1 = Math.max(x1, pt.x);
      y0 = Math.min(y0, pt.y);
      y1 = Math.max(y1, pt.y);
    }
    return { x: (x0 + x1) / 2, y: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0 };
  };
  const blockers = [spot(tt.deck.x, tt.deck.z, 0.6), spot(tt.pile.x, tt.pile.z, 0.55)];
  avoid.push(...blockers);
  const g = 6;
  for (const pl of plates) {
    if (pl.seat === 0 || !pl.visible) continue;
    const free = (b: Box) =>
      b.x - b.w / 2 >= 4 && b.x + b.w / 2 <= W - 4 && b.y - b.h / 2 >= 4 && b.y + b.h / 2 <= H - 4 &&
      !blockers.some((q) => overlaps(b, q, g)) && !handBoxes.some((q) => q.seat !== pl.seat && overlaps(b, q, 0));
    const hit = blockers.find((q) => overlaps(pl, q, g));
    if (!hit) continue;
    const cands = [
      { x: pl.x, y: hit.y - hit.h / 2 - g - pl.h / 2 },
      { x: pl.x, y: hit.y + hit.h / 2 + g + pl.h / 2 },
      { x: hit.x - hit.w / 2 - g - pl.w / 2, y: pl.y },
      { x: hit.x + hit.w / 2 + g + pl.w / 2, y: pl.y },
    ]
      .map((c) => ({ ...c, w: pl.w, h: pl.h, d: Math.hypot(c.x - pl.x, c.y - pl.y) }))
      .filter(free)
      .sort((a, b) => a.d - b.d);
    const b = cands[0];
    if (!b) continue;
    if (pl.bubble) {
      pl.bubble.x += b.x - pl.x;
      pl.bubble.y += b.y - pl.y;
    }
    pl.x = b.x;
    pl.y = b.y;
  }
  return { plates, handBoxes, avoid };
}

/** what the camera framing needs (see fitTable) */
export interface FitOpts {
  W: number;
  H: number;
  portrait: boolean;
  /** the felt; stretched in place along the free direction so it fills the screen */
  dims: TableDims;
  /** put the camera `dist` from its look point (0, 0, tz) along its fixed tilt (refreshing `project`) */
  place: (dist: number, tz: number) => void;
  project: (x: number, y: number, z: number, out: { x: number; y: number }) => boolean;
  /** optional points (x, y, z triplets) above the felt whose screen tops must stay below the HUD (handFitPoints) */
  rows?: (d: TableDims, out: number[]) => number[];
}

/**
 * Frame the table: the camera distance and look point so the felt fits between the HUD and the bottom
 * edge (the human hand covers the near edge), anything given in `rows` below the HUD, then stretch the
 * felt along the free direction (tall phones: a deeper table). Leaves the camera placed; returns it.
 */
export function fitTable(o: FitOpts): { dist: number; tz: number } {
  const { W, H, dims } = o;
  const fan7 = fanLayout(7, { W, H });
  const top = HUD_TOP * 0.55;
  const bottom = H + (H - fan7.top) * (o.portrait ? 0.35 : -0.3);
  const lift = HUD_TOP - 4 - top;
  const px = { x: 0, y: 0 };
  const rows: number[] = [];
  const bb = { x0: 0, x1: 0, y0: 0, y1: 0 };
  let tz = 0.35;
  let dist = 10;
  const measure = (ex: number, ez: number) => {
    bb.x0 = bb.y0 = Infinity;
    bb.x1 = bb.y1 = -Infinity;
    for (let k = 0; k < 4; k++) {
      o.project(k & 1 ? ex : -ex, 0, k & 2 ? ez : -ez, px);
      bb.x0 = Math.min(bb.x0, px.x);
      bb.x1 = Math.max(bb.x1, px.x);
      bb.y0 = Math.min(bb.y0, px.y);
      bb.y1 = Math.max(bb.y1, px.y);
    }
    // the standing hands rise above the felt: their tops stay below the HUD (the felt may reach into it)
    for (let k = 0; k < rows.length; k += 3) {
      o.project(rows[k], rows[k + 1], rows[k + 2], px);
      bb.y0 = Math.min(bb.y0, px.y - lift);
    }
  };
  const fit = () => {
    const ex = dims.A + 0.15;
    const ez = dims.B + 0.15;
    if (o.rows) o.rows(dims, rows);
    tz = 0.35;
    for (let it = 0; it < 4; it++) {
      let lo = 2;
      let hi = 80;
      for (let k = 0; k < 26; k++) {
        const mid = (lo + hi) / 2;
        o.place(mid, tz);
        measure(ex, ez);
        if (bb.x1 - bb.x0 <= W - 8 && bb.y1 - bb.y0 <= bottom - top) hi = mid;
        else lo = mid;
      }
      dist = hi;
      o.place(dist, tz);
      measure(ex, ez);
      tz += ((bb.y0 + bb.y1) / 2 - (top + bottom) / 2) * ((2 * ez) / Math.max(1, bb.y1 - bb.y0)) * 0.9;
    }
    o.place(dist, tz);
    measure(ex, ez);
    return { sx: W - 8 - (bb.x1 - bb.x0), sy: bottom - top - (bb.y1 - bb.y0) };
  };
  for (let k = 0; k < 30; k++) {
    const f = fit();
    if (f.sy > 24 && dims.B < 5) dims.B += 0.12;
    else if (f.sx > 24 && dims.A < 6.5) dims.A += 0.12;
    else break;
  }
  o.place(dist, tz);
  return { dist, tz };
}
