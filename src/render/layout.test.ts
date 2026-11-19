import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  fanLayout, hitFan, inSlot, separatePlates, seatSides, turnSpin, ringSign, seatAnchor, plateBox, projectCss, sortHand, tableDims,
  cameraTilt, cameraFov, fitTable, seatHand, fanSpread, seatHoldYaw, handCardCorners, handCardNormal, handFitPoints, layoutPlates,
  CARD_W, SEAT_SIDE, HUD_TOP, HAND_HIDDEN, tableTune, tableCamera, openHandScale, type FanLayout, type PlateSeat, type Box,
} from './layout';
import type { Card, Seat } from '../contracts';

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
    it(`keeps 1..30 cards in one straight row, 20% below the edge, at ${v.W}x${v.H}`, () => {
      for (let n = 1; n <= 30; n++) {
        const f = fanLayout(n, v);
        expect(f.slots.length).toBe(n);
        expect(f.rows).toBe(1);
        for (let i = 0; i < n; i++) {
          for (const [x, y] of corners(f, i)) {
            expect(x).toBeGreaterThanOrEqual(-0.5);
            expect(x).toBeLessThanOrEqual(v.W + 0.5);
            expect(y).toBeGreaterThanOrEqual(0);
            // the bottom HAND_HIDDEN of each card hides below the screen edge
            expect(y).toBeLessThanOrEqual(v.H + f.ch * HAND_HIDDEN + 0.5);
          }
          expect(f.slots[i].rot).toBeCloseTo(0, 9); // a straight row
          expect(f.slots[i].y + f.ch / 2).toBeCloseTo(v.H + f.ch * HAND_HIDDEN, 6);
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

// ───────── the other seats' hands: the human's fan, held at each seat (3D) ─────────

const DEG = Math.PI / 180;
const DIMS = [tableDims(false), tableDims(true), { A: 4.6, B: 2.6 }, { A: 2.05, B: 4.2 }];

describe('hands of the other seats (tuned in fan-demo.html)', () => {
  const sides = ['top', 'left', 'right', 'lowerLeft', 'lowerRight'] as const;
  const tune = (portrait: boolean, side: (typeof sides)[number]) => {
    const T = tableTune(portrait);
    return side === 'top' ? T.top : side === 'left' || side === 'lowerLeft' ? T.left : T.right;
  };

  it('stand where the demo put them, at the tuned size, above the felt', () => {
    for (const portrait of [false, true])
      for (const side of sides)
        for (const open of [false, true])
          for (const n of [1, 2, 7, 12, 25]) {
            const F = tune(portrait, side);
            const f = seatHand(n, side, open, tableDims(portrait), portrait);
            const tag = `${side} open=${open} n=${n} portrait=${portrait}`;
            expect(f.poses.length, tag).toBe(n);
            expect(f.s, tag).toBeCloseTo(F.scale, 9);
            expect(f.ax, tag).toBeCloseTo(F.posX, 9);
            expect(f.az, tag).toBeCloseTo(F.posZ, 9);
            expect(f.holdYaw).toBeCloseTo(seatHoldYaw(side), 9);
            for (const p of f.poses) {
              expect(p.q, tag).toBeDefined();
              const cs = handCardCorners(p, f.s);
              for (let k = 1; k < 12; k += 3) expect(cs[k], tag).toBeGreaterThanOrEqual(0);
            }
          }
  });

  it('show their backs to the table centre, an open hand its faces', () => {
    for (const portrait of [false, true])
      for (const side of sides)
        for (const open of [false, true]) {
          const f = seatHand(7, side, open, tableDims(portrait), portrait);
          const p = f.poses[3];
          const nrm = handCardNormal(p);
          // the face normal points at the holder (away from the centre) unless the hand is open
          const toCentre = -(nrm[0] * p.x + nrm[2] * p.z);
          if (open) expect(toCentre, `${side} portrait=${portrait}`).toBeGreaterThan(0);
          else expect(toCentre, `${side} portrait=${portrait}`).toBeLessThan(0);
        }
  });

  it('squeeze big hands into the length of fullCards, never a second row', () => {
    for (const portrait of [false, true])
      for (const side of sides) {
        const F = tune(portrait, side);
        const full = seatHand(F.fullCards, side, false, tableDims(portrait), portrait);
        const big = seatHand(25, side, false, tableDims(portrait), portrait);
        expect(big.spacing).toBeLessThan(full.spacing);
        const span = (h: typeof big) => Math.hypot(h.poses[h.poses.length - 1].x - h.poses[0].x, h.poses[h.poses.length - 1].z - h.poses[0].z);
        expect(span(big)).toBeLessThan(span(full) * 1.1 + 0.05);
      }
  });

  it("the partner's open hand is the size of the opponents' hands across the table", () => {
    for (const portrait of [false, true]) {
      expect(openHandScale(portrait, 'top')).toBeCloseTo(tableTune(portrait).top.scale, 9);
      expect(openHandScale(portrait, 'lowerLeft')).toBeCloseTo(tableTune(portrait).left.scale, 9);
      expect(openHandScale(portrait, 'lowerRight')).toBeCloseTo(tableTune(portrait).right.scale, 9);
    }
  });
});

void DEG;

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

describe('open hands', () => {
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

// ───────── the whole table: rows, plates, pile and the human hand never collide ─────────

describe('the whole table at phone and desktop sizes', () => {
  interface Mode { name: string; W: number; H: number; seats: Seat[]; teams: Seat[][] | null; open?: Seat }
  const MODES: Mode[] = [
    { name: 'Clásico 4p portrait', W: 375, H: 812, seats: [0, 1, 2, 3], teams: null },
    { name: 'Clásico 4p landscape', W: 915, H: 412, seats: [0, 1, 2, 3], teams: null },
    { name: 'Clásico 4p small landscape', W: 844, H: 390, seats: [0, 1, 2, 3], teams: null },
    { name: 'Clásico 4p desktop', W: 1280, H: 720, seats: [0, 1, 2, 3], teams: null },
    { name: '2p landscape', W: 915, H: 412, seats: [0, 2], teams: null },
    { name: 'Enfrente landscape', W: 915, H: 412, seats: [0, 1, 2, 3], teams: [[0, 2], [1, 3]], open: 2 },
    { name: 'Codo a codo R landscape', W: 915, H: 412, seats: [0, 1, 2, 3], teams: [[0, 1], [2, 3]], open: 1 },
    { name: 'Codo a codo L portrait', W: 375, H: 812, seats: [0, 1, 2, 3], teams: [[0, 3], [1, 2]], open: 3 },
  ];

  /** the view's camera (tableCamera): the tuned tilt, fov and distance */
  function table(m: Mode) {
    const { W, H } = m;
    const portrait = H > W * 1.05;
    const tc = tableCamera(W, H, portrait);
    const cam = new THREE.PerspectiveCamera(tc.fov, W / H, 0.1, 100);
    cam.position.set(0, Math.cos(tc.tilt) * tc.dist, Math.sin(tc.tilt) * tc.dist);
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld(true);
    const vp = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    const project = (x: number, y: number, z: number, out: { x: number; y: number }) => projectCss(vp.elements, x, y, z, W, H, out);
    return { portrait, sides: seatSides(m.seats, m.teams), project, dims: tableDims(portrait) };
  }

  for (const m of MODES)
    it(`${m.name} ${m.W}x${m.H}: every hand on screen, every plate on screen`, () => {
      const t = table(m);
      for (const n of [7, 15, 25]) {
        const list: PlateSeat[] = m.seats.map((s) => {
          const side = t.sides[s];
          return { seat: s, side, count: n, hand: s === 0 ? null : seatHand(n, side, s === m.open, t.dims, t.portrait), active: false, winner: false, scale: 1, visible: true };
        });
        const pt = { x: 0, y: 0 };
        for (const ps of list) {
          if (!ps.hand) continue;
          for (const c of ps.hand.poses) {
            const cs = handCardCorners(c, ps.hand.s);
            for (let k = 0; k < 12; k += 3) {
              t.project(cs[k], cs[k + 1], cs[k + 2], pt);
              const tag = `${m.name} n=${n} seat ${ps.seat}`;
              expect(pt.x, tag).toBeGreaterThan(-m.W * 0.05);
              expect(pt.x, tag).toBeLessThan(m.W * 1.05);
              expect(pt.y, tag).toBeGreaterThan(-m.H * 0.05);
              expect(pt.y, tag).toBeLessThan(m.H * 1.05);
            }
          }
        }
        const { plates } = layoutPlates(m.W, m.H, t.portrait, t.project, list, n, { x: m.W / 2, y: m.H / 2, w: 10, h: 10 });
        for (const p of plates) {
          expect(p.x - p.w / 2).toBeGreaterThanOrEqual(0);
          expect(p.x + p.w / 2).toBeLessThanOrEqual(m.W);
          expect(p.y - p.h / 2).toBeGreaterThanOrEqual(0);
          expect(p.y + p.h / 2).toBeLessThanOrEqual(m.H);
        }
      }
    });
});
