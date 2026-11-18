import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  fanLayout, hitFan, inSlot, oppFan, openFan, openScale, partnerFan, partnerScale, separatePlates, seatSides, turnSpin, ringSign, seatAnchor,
  plateBox, projectCss, sortHand, tableDims, CARD_W, CARD_H, SEAT_SIDE, OPEN_MIN_STRIP_X, OPEN_MIN_STRIP_Z, type FanLayout,
} from './layout';
import type { Card } from '../contracts';

const VIEWS = [
  { W: 390, H: 844 }, // phone portrait
  { W: 844, H: 390 }, // phone landscape
  { W: 320, H: 568 }, // small old phone
  { W: 1280, H: 720 },
];

/** the four corners of a slot's rotated card */
function corners(f: FanLayout, i: number): [number, number][] {
  const s = f.slots[i];
  const c = Math.cos(s.rot);
  const si = Math.sin(s.rot);
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => {
    const lx = (a * f.cw) / 2;
    const ly = (b * f.ch) / 2;
    return [s.x + lx * c - ly * si, s.y + lx * si + ly * c] as [number, number];
  });
}

/** px length of the card's visible strip along a horizontal line through its exposed part */
function visibleWidth(f: FanLayout, i: number): number {
  const s = f.slots[i];
  // back-row cards only show their top part; probe there
  const ly = s.row < f.rows - 1 ? -f.ch / 2 + f.ch * 0.15 : 0;
  let run = 0;
  let best = 0;
  for (let lx = -f.cw / 2; lx <= f.cw / 2; lx += 0.5) {
    const x = s.x + lx * Math.cos(s.rot) - ly * Math.sin(s.rot);
    const y = s.y + lx * Math.sin(s.rot) + ly * Math.cos(s.rot);
    if (hitFan(f, x, y) === i) {
      run += 0.5;
      best = Math.max(best, run);
    } else run = 0;
  }
  return best;
}

describe('fanLayout', () => {
  for (const v of VIEWS)
    it(`keeps 1..30 cards in one row on screen at ${v.W}x${v.H}`, () => {
      for (let n = 1; n <= 30; n++) {
        const f = fanLayout(n, v);
        expect(f.slots.length).toBe(n);
        expect(f.rows).toBe(1);
        for (let i = 0; i < n; i++) {
          for (const [x, y] of corners(f, i)) {
            expect(x).toBeGreaterThanOrEqual(-0.5);
            expect(x).toBeLessThanOrEqual(v.W + 0.5);
            expect(y).toBeGreaterThanOrEqual(0);
            expect(y).toBeLessThanOrEqual(v.H + 0.5);
          }
          // a comfortable strip while it fits, then evenly compressed (the peek reads squeezed cards)
          if (i < n - 1) expect(visibleWidth(f, i)).toBeGreaterThanOrEqual(Math.min(f.minTap, f.spacing * 0.9) - 1.5);
        }
        // the hand stays in the lower part of the screen
        expect(f.top).toBeGreaterThan(v.H * 0.35);
      }
    });

  it('spreads small hands and compresses large ones', () => {
    const a = fanLayout(5, { W: 390, H: 844 });
    const b = fanLayout(12, { W: 390, H: 844 });
    expect(a.rows).toBe(1);
    expect(b.rows).toBe(1);
    expect(b.spacing).toBeLessThan(a.spacing);
    const c = fanLayout(30, { W: 390, H: 844 });
    expect(c.rows).toBe(1);
    expect(c.spacing).toBeLessThan(b.spacing);
    expect(a.minTap).toBeGreaterThanOrEqual(22);
  });

  it('hit testing picks the topmost card and honours lifts', () => {
    const f = fanLayout(7, { W: 390, H: 844 });
    const s = f.slots[3];
    expect(hitFan(f, s.x, s.y)).toBeGreaterThanOrEqual(3);
    expect(hitFan(f, 2, 2)).toBe(-1);
    const lifts = new Array(7).fill(0);
    lifts[3] = 30;
    expect(inSlot(s, f.cw, f.ch, s.x, s.y - f.ch / 2 - 20, 30)).toBe(true);
    expect(hitFan(f, s.x, s.y - f.ch / 2 - 20, lifts)).toBe(3);
  });
});

describe('sortHand', () => {
  it('sorts by colour then value, wilds last', () => {
    const c = (id: number, face: Card['face']): Card => ({ id, face });
    const out = sortHand([
      c(1, { kind: 'wild', color: null }),
      c(2, { kind: 'number', color: 'coral', value: 3 }),
      c(3, { kind: 'number', color: 'sol', value: 9 }),
      c(4, { kind: 'skip', color: 'sol' }),
      c(5, { kind: 'number', color: 'sol', value: 1 }),
    ]);
    expect(out.map((x) => x.id)).toEqual([5, 3, 4, 2, 1]);
  });
});

describe('opponent fans', () => {
  it('stay on the felt and compress', () => {
    for (const portrait of [true, false]) {
      const d = tableDims(portrait);
      for (const seat of [1, 2, 3]) {
        for (const n of [1, 7, 25]) {
          const poses = oppFan(n, SEAT_SIDE[seat], d);
          expect(poses.length).toBe(n);
          for (const p of poses) {
            expect(Math.abs(p.x)).toBeLessThanOrEqual(d.A);
            expect(Math.abs(p.z)).toBeLessThanOrEqual(d.B);
          }
        }
      }
    }
  });
});

describe('plates', () => {
  it('projects world points to CSS px like three.js does', () => {
    const cam = new THREE.PerspectiveCamera(40, 390 / 844, 0.1, 100);
    cam.position.set(0, 9, 4);
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld(true);
    const vp = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    const out = { x: 0, y: 0 };
    projectCss(vp.elements, 0, 0, 0, 390, 844, out);
    expect(out.x).toBeCloseTo(195, 3);
    expect(out.y).toBeCloseTo(422, 3);
    const v = new THREE.Vector3(1.2, 0, -2).project(cam);
    projectCss(vp.elements, 1.2, 0, -2, 390, 844, out);
    expect(out.x).toBeCloseTo((v.x * 0.5 + 0.5) * 390, 3);
    expect(out.y).toBeCloseTo((1 - (v.y * 0.5 + 0.5)) * 844, 3);
    // the near side of the table is lower on screen
    const near = { x: 0, y: 0 };
    projectCss(vp.elements, 0, 0, 2, 390, 844, near);
    expect(near.y).toBeGreaterThan(out.y);
  });

  it('boxes stay on screen below the HUD and carry the count', () => {
    const env = { W: 390, H: 844, hudTop: 56, handTop: 700, portrait: true };
    for (const side of ['bottom', 'right', 'top', 'left'] as const) {
      for (const [ax, ay] of [[0, 0], [195, 400], [390, 844], [-50, 60]]) {
        const b = plateBox({ seat: 1, side, ax, ay, halfX: 40, halfY: 60, count: 9, active: true, winner: false, scale: 1, visible: true }, env);
        expect(b.x - b.w / 2).toBeGreaterThanOrEqual(0);
        expect(b.x + b.w / 2).toBeLessThanOrEqual(390);
        expect(b.y - b.h / 2).toBeGreaterThanOrEqual(56);
        expect(b.y + b.h / 2).toBeLessThanOrEqual(844);
        expect(b.count).toBe(9);
      }
    }
    const human = plateBox({ seat: 0, side: 'bottom', ax: 0, ay: 0, halfX: 0, halfY: 0, count: 7, active: false, winner: false, scale: 1, visible: true }, env);
    expect(human.y + human.h / 2).toBeLessThanOrEqual(700);
  });
});

describe('open hand fan (Parejas partner face up)', () => {
  const VIEWS_OPEN = [
    { W: 390, H: 844, portrait: true, dims: [tableDims(true), { A: 2.05, B: 4.2 }] },
    { W: 844, H: 390, portrait: false, dims: [tableDims(false), { A: 4.6, B: 2.15 }] },
  ];
  const sides = ['top', 'right', 'left'] as const;

  it('keeps every card on the felt, in order, for 1..30 cards', () => {
    for (const v of VIEWS_OPEN)
      for (const d of v.dims)
        for (const side of sides)
          for (let n = 1; n <= 30; n++) {
            const tilt = v.portrait ? 0.42 : 0.5;
            const f = openFan(n, side, d, tilt, openScale(v.portrait));
            expect(f.poses.length).toBe(n);
            const w = CARD_W * f.s;
            const hz = (CARD_H * f.s * Math.cos(tilt)) / 2;
            for (const p of f.poses) {
              expect(Math.abs(p.x) + w / 2).toBeLessThanOrEqual(d.A + 0.1);
              expect(Math.abs(p.z) + hz).toBeLessThanOrEqual(d.B + 0.1);
              expect(p.y).toBeGreaterThan(0);
            }
            // extents cover the cards
            for (const p of f.poses) {
              expect(p.x - w / 2).toBeGreaterThanOrEqual(f.cx - f.hx - 1e-9);
              expect(p.x + w / 2).toBeLessThanOrEqual(f.cx + f.hx + 1e-9);
            }
          }
  });

  it('every card keeps its top-left corner (value + colour symbol) uncovered', () => {
    for (const v of VIEWS_OPEN)
      for (const d of v.dims)
        for (const side of sides)
          for (const n of [2, 7, 12, 18, 25]) {
            const tilt = v.portrait ? 0.42 : 0.5;
            const f = openFan(n, side, d, tilt, openScale(v.portrait));
            const w = CARD_W * f.s;
            const hz = (CARD_H * f.s * Math.cos(tilt)) / 2;
            // one line: past the corner strip the hand just compresses (the peek reads it)
            const minStrip = side === 'top' ? OPEN_MIN_STRIP_X * w : OPEN_MIN_STRIP_Z * CARD_H * f.s;
            if (n > 1 && f.step < minStrip) return;
            expect(f.lines).toBe(1);
            f.poses.forEach((p, i) => {
              // probe the corner value: ~19% across, ~15% down the card
              const px = p.x - w / 2 + 0.19 * w;
              const pz = p.z - hz + 0.15 * 2 * hz;
              const coveredBy = f.poses.findIndex(
                (q, j) => j !== i && q.y > p.y && Math.abs(px - q.x) < w / 2 && Math.abs(pz - q.z) < hz,
              );
              expect(coveredBy, `${side} n=${n} card ${i}`).toBe(-1);
            });
          }
  });

  it('stays readable on a phone (card and visible strip size in px)', () => {
    for (const v of VIEWS_OPEN) {
      const d = v.dims[0];
      // the felt fits the screen (camera fit); the far side shrinks with perspective (~0.7)
      const pxPerUnit = Math.min((v.W - 8) / (2 * (d.A + 0.15)), (v.H - 90) / (2 * (d.B + 0.15))) * 0.7;
      for (const side of sides)
        for (const n of [5, 8]) {
          const f = openFan(n, side, d, v.portrait ? 0.42 : 0.5, openScale(v.portrait));
          const wPx = CARD_W * f.s * pxPerUnit;
          expect(wPx, `${v.W}x${v.H} ${side}`).toBeGreaterThanOrEqual(30);
          if (n > 1) expect(f.step * pxPerUnit, `${v.W}x${v.H} ${side} n=${n}`).toBeGreaterThanOrEqual(10);
        }
    }
  });

  it('sorts open hands by colour then value with the cyclone kinds placed', () => {
    const cs: Card[] = [
      { id: 1, face: { kind: 'draw10', color: null, draw: 10 } },
      { id: 2, face: { kind: 'skipAll', color: 'mar' } },
      { id: 3, face: { kind: 'number', color: 'mar', value: 3 } },
      { id: 4, face: { kind: 'draw6', color: 'sol', draw: 6 } },
      { id: 5, face: { kind: 'wildColor', color: null } },
      { id: 6, face: { kind: 'wild', color: null } },
    ];
    expect(sortHand(cs).map((c) => c.id)).toEqual([4, 3, 2, 6, 5, 1]);
  });
});

describe('Codo a codo (side-seating partners)', () => {
  const CASES = [
    { teams: [[0, 1], [2, 3]], partner: 1, side: 'lowerRight' as const, other: 3, otherSide: 'left' },
    { teams: [[0, 3], [1, 2]], partner: 3, side: 'lowerLeft' as const, other: 1, otherSide: 'right' },
  ];
  // landscape tables the camera fit produces (844x390 .. 1280x720): A ~ 3.9-4.6, B ~ 2.15-2.6
  const DIMS = [tableDims(false), { A: 4.3, B: 2.4 }, { A: 4.6, B: 2.6 }];

  it('puts the partner on their side edge, opponents top and the other side', () => {
    for (const c of CASES) {
      const s = seatSides([0, 1, 2, 3], c.teams);
      expect(s[0]).toBe('bottom');
      expect(s[c.partner]).toBe(c.side);
      expect(s[2]).toBe('top');
      expect(s[c.other]).toBe(c.otherSide);
    }
    expect(seatSides([0, 1, 2, 3], [[0, 2], [1, 3]])).toMatchObject({ 0: 'bottom', 1: 'right', 2: 'top', 3: 'left' });
    expect(seatSides([0, 1, 2, 3], null)).toMatchObject({ 1: 'right', 3: 'left' });
  });

  it('keeps the direction ring matching turn order (0 -> 1 -> 2 -> 3) on screen', () => {
    const d = tableDims(false);
    const classic = [0, 1, 2, 3].map((s) => seatAnchor(SEAT_SIDE[s], d));
    expect(turnSpin(classic)).toBe(-1); // counter-clockwise on screen
    expect(ringSign(turnSpin(classic), 1)).toBe(-1); // the historic sign
    expect(ringSign(turnSpin(classic), -1)).toBe(1);
    for (const c of CASES) {
      const sides = seatSides([0, 1, 2, 3], c.teams);
      const pts = [0, 1, 2, 3].map((s) => seatAnchor(sides[s], d));
      expect(turnSpin(pts)).toBe(-1);
    }
    expect(turnSpin([{ x: 0, z: 2 }, { x: 0, z: -2 }])).toBe(0); // 2 players: collinear
  });

  it('the partner arc lies along their edge, inside the felt, clear of the centre, top to bottom', () => {
    for (const c of CASES)
      for (const d of DIMS)
        for (const zNear of [1.0, 1.6, 2.2])
          for (let n = 1; n <= 30; n++) {
            const f = partnerFan(n, c.side, d, zNear, partnerScale(false));
            expect(f.poses.length).toBe(n);
            const w = L_W * f.s;
            const h = L_H * f.s;
            f.poses.forEach((p, i) => {
              expect(Math.abs(p.x) + w / 2).toBeLessThanOrEqual(d.A);
              expect(Math.abs(p.z) + h / 2).toBeLessThanOrEqual(d.B);
              // on the partner's side and well away from the deck / pile (|x| <= ~1.1)
              expect(Math.sign(p.x)).toBe(c.side === 'lowerRight' ? 1 : -1);
              expect(Math.abs(p.x) - w / 2).toBeGreaterThan(1.3);
              expect(Math.abs(p.yaw ?? 0)).toBeLessThanOrEqual(0.2); // a gentle arc, still upright
              if (i > 0) expect(p.z).toBeGreaterThan(f.poses[i - 1].z);
            });
            // smaller than the human's cards: opponent-ish scale
            expect(f.s).toBeLessThan(0.9);
          }
  });

  it('keeps every partner corner value visible for 7-14 cards on a landscape table', () => {
    for (const c of CASES)
      for (const d of DIMS)
        for (const n of [7, 10, 14]) {
          const f = partnerFan(n, c.side, d, 1.9, partnerScale(false), -1.4);
          const w = L_W * f.s;
          // each nearer card sits lower and to the right: the one behind keeps a full-height left strip
          for (let i = 1; i < n; i++) {
            const dx = f.poses[i].x - f.poses[i - 1].x;
            const dz = f.poses[i].z - f.poses[i - 1].z;
            expect(dz).toBeGreaterThan(0);
            // value + colour symbol at 7 cards on a phone table; graceful (value only) at 14
            expect(dx, `${c.side} A=${d.A} n=${n}`).toBeGreaterThanOrEqual(w * (n <= 7 ? 0.34 : n <= 10 ? 0.27 : 0.18) - 1e-9);
          }
          // the far end stays below the reserved plate slot
          expect(f.poses[0].z - (L_H * f.s) / 2).toBeGreaterThanOrEqual(-1.4 - (L_H * f.s) / 2 - 1e-9);
        }
  });

  it('separates overlapping plates and keeps them off the pile', () => {
    const mk = (seat: 0 | 1 | 2 | 3, x: number, y: number) => ({
      seat, x, y, w: 120, h: 40, d: 40, layout: 'row' as const, scale: 1, visible: true, active: false, winner: false, count: 7,
    });
    const plates = [mk(0, 100, 350), mk(1, 400, 120), mk(2, 420, 125), mk(3, 422, 200)];
    const pile = { x: 422, y: 200, w: 160, h: 90 };
    separatePlates(plates, [pile], 844, 390, 56);
    expect(plates[0]).toMatchObject({ x: 100, y: 350 });
    const boxes = [...plates, { ...pile, visible: true }];
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        const hit = Math.abs(a.x - b.x) * 2 < a.w + b.w && Math.abs(a.y - b.y) * 2 < a.h + b.h;
        expect(hit, `${i} vs ${j}`).toBe(false);
      }
    for (const p of plates) expect(p.y - p.h / 2).toBeGreaterThanOrEqual(56);
  });
});

const L_W = CARD_W;
const L_H = CARD_H;
