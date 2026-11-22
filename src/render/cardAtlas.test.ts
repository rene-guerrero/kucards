import { describe, it, expect } from 'vitest';
import { ATLAS_CELLS, ATLAS_COLS, ATLAS_ROWS, CELL_SU, CELL_SV, COLOR_DEEP, COLOR_GLOW, COLOR_HEX, FaceMap, NIGHT_COLORS, baseFaces, cellPx, cellUv, faceKey, isNightFace, nightFace, playedFace } from './cardAtlas';
import { buildDeck, dayFaces, nightFaces } from '../engine/cards';
import { DEFAULT_RULES } from '../engine/rules';

describe('card atlas mapping', () => {
  it('gives every distinct face its own cell inside the atlas', () => {
    const map = new FaceMap();
    const faces = baseFaces();
    expect(faces.length).toBeLessThanOrEqual(ATLAS_CELLS);
    const keys = new Set(faces.map(faceKey));
    expect(keys.size).toBe(faces.length);
    const cells = new Set<number>();
    for (const f of faces) {
      const i = map.lookup(f);
      expect(i).toBeGreaterThanOrEqual(0);
      cells.add(i);
      const { u0, v0 } = cellUv(i);
      expect(u0).toBeGreaterThanOrEqual(0);
      expect(v0).toBeGreaterThanOrEqual(0);
      expect(u0 + CELL_SU).toBeLessThanOrEqual(1 + 1e-9);
      expect(v0 + CELL_SV).toBeLessThanOrEqual(1 + 1e-9);
    }
    expect(cells.size).toBe(faces.length);
  });

  it('covers every card of every deck the engine builds', () => {
    const map = new FaceMap();
    const all = { ...DEFAULT_RULES, 'power.swap': true, 'power.shield': true, 'power.sweep': true, 'power.mirror': true };
    for (const rules of [DEFAULT_RULES, all, { ...all, deck: 'action' }]) {
      for (const c of buildDeck(rules)) {
        const r = map.index(c.face);
        expect(r.added).toBe(false);
        expect(faceKey(map.faces[r.i])).toBe(faceKey(c.face));
      }
    }
  });

  it('cells do not overlap and keep the 2:3 card shape', () => {
    for (const size of [1024, 2048]) {
      const cw = size / ATLAS_COLS;
      const ch = size / ATLAS_ROWS;
      for (let i = 0; i < ATLAS_CELLS; i++) {
        const r = cellPx(i, size);
        expect(r.h / r.w).toBeCloseTo(1.5, 6);
        const col = i % ATLAS_COLS;
        const row = Math.floor(i / ATLAS_COLS);
        expect(r.x).toBeGreaterThanOrEqual(col * cw);
        expect(r.x + r.w).toBeLessThanOrEqual((col + 1) * cw + 1e-6);
        expect(r.y).toBeGreaterThanOrEqual(row * ch);
        expect(r.y + r.h).toBeLessThanOrEqual((row + 1) * ch + 1e-6);
      }
    }
  });

  it('adds unknown faces once, then falls back when full', () => {
    const map = new FaceMap();
    const n0 = map.size;
    const a = map.index({ kind: 'draw2', color: 'sol', draw: 6 });
    expect(a.added).toBe(true);
    expect(map.index({ kind: 'draw2', color: 'sol', draw: 6 })).toEqual({ i: a.i, added: false });
    expect(map.size).toBe(n0 + 1);
    for (let k = 0; map.size < ATLAS_CELLS; k++) map.index({ kind: 'wild4', color: null, draw: 10 + k });
    const full = map.index({ kind: 'draw2', color: 'mar', draw: 99 });
    expect(full.added).toBe(false);
    expect(full.i).toBe(map.lookup({ kind: 'draw2', color: 'mar', draw: 2 }));
  });
});

describe('atlas: Ciclón faces', () => {
  it('has a base cell for every card kind incl. skipAll, draw6, draw10 and wildColor', () => {
    const map = new FaceMap();
    const kinds = new Set(baseFaces().map((f) => f.kind));
    for (const k of ['number', 'skip', 'reverse', 'draw2', 'wild', 'wild4', 'swap', 'shield', 'sweep', 'mirror', 'flip', 'skipAll', 'draw6', 'draw10', 'wildColor'] as const)
      expect(kinds.has(k), k).toBe(true);
    for (const c of ['sol', 'mar', 'palma', 'coral'] as const) {
      expect(map.lookup({ kind: 'skipAll', color: c })).toBeGreaterThanOrEqual(0);
      expect(map.lookup({ kind: 'draw6', color: c, draw: 6 })).toBeGreaterThanOrEqual(0);
      // the engine may leave out the default draw: same face
      expect(map.lookup({ kind: 'draw6', color: c })).toBe(map.lookup({ kind: 'draw6', color: c, draw: 6 }));
    }
    expect(map.lookup({ kind: 'draw10', color: null, draw: 10 })).toBeGreaterThanOrEqual(0);
    expect(map.lookup({ kind: 'wildColor', color: null })).toBeGreaterThanOrEqual(0);
    // still one texture with room for a few odd faces
    expect(map.size).toBeLessThanOrEqual(ATLAS_CELLS - 8);
  });

  it('covers the cyclone deck when the engine builds one', () => {
    const map = new FaceMap();
    const rules = { ...DEFAULT_RULES, deck: 'cyclone', 'power.swap': true, 'power.shield': true, 'power.sweep': true, 'power.mirror': true };
    const deck = buildDeck(rules);
    expect(deck.length).toBeGreaterThan(0);
    for (const c of deck) expect(map.index(c.face).added, faceKey(c.face)).toBe(false);
  });
});

describe('played wild-type faces', () => {
  it('take the chosen colour on the pile and keep their own cell per colour', () => {
    const map = new FaceMap();
    const wild = { kind: 'wild', color: null } as const;
    expect(playedFace(wild, undefined)).toBe(wild);
    const sol = playedFace(wild, 'sol');
    const mar = playedFace({ kind: 'draw10', color: null, draw: 10 }, 'mar');
    expect(map.index(sol).added).toBe(false);
    expect(map.index(mar).added).toBe(false);
    expect(map.lookup(sol)).not.toBe(map.lookup(wild));
    expect(map.lookup(sol)).not.toBe(map.lookup(playedFace(wild, 'coral')));
    // coloured cards and the colourless flip stay as they are
    const red = { kind: 'skip', color: 'coral' } as const;
    expect(playedFace(red, 'sol')).toBe(red);
    expect(playedFace({ kind: 'flip', color: null }, 'sol')).not.toHaveProperty('tint');
  });
});

describe('atlas: night side (Día y Noche)', () => {
  it('has the four night colours, each with its own hex, deep and glow', () => {
    expect([...NIGHT_COLORS]).toEqual(['naranja', 'celeste', 'rosa', 'morado']);
    for (const map of [COLOR_HEX, COLOR_DEEP, COLOR_GLOW]) {
      const all = Object.values(map);
      expect(all.length).toBe(8);
      expect(new Set(all).size).toBe(8);
    }
  });

  it('keeps the day cells where they were and gives every night face its own cell', () => {
    const map = new FaceMap();
    const faces = baseFaces();
    const firstNight = faces.findIndex((f) => isNightFace(f));
    expect(firstNight).toBe(102);
    expect(faces.slice(firstNight).every((f) => isNightFace(f))).toBe(true);
    for (const c of NIGHT_COLORS) {
      for (let v = 0; v <= 9; v++) expect(map.lookup({ kind: 'number', color: c, value: v })).toBeGreaterThanOrEqual(firstNight);
      for (const f of [{ kind: 'draw6', color: c, draw: 5 }, { kind: 'skip', color: c }, { kind: 'reverse', color: c }, { kind: 'flip', color: c }] as const)
        expect(map.lookup(f), faceKey(f)).toBeGreaterThanOrEqual(firstNight);
    }
    // room left for odd night faces (a +1, a +6 …), which get a cell on first use
    expect(map.size).toBeLessThanOrEqual(ATLAS_CELLS - 24);
    expect(map.index({ kind: 'draw2', color: 'rosa', draw: 1 }).added).toBe(true);
  });

  it('tells the night wilds from the day ones, in hand and played', () => {
    const map = new FaceMap();
    const day = { kind: 'wild', color: null } as const;
    const night = nightFace(day);
    expect(isNightFace(day)).toBe(false);
    expect(isNightFace(night)).toBe(true);
    expect(map.lookup(night)).toBeGreaterThanOrEqual(0);
    expect(map.lookup(night)).not.toBe(map.lookup(day));
    const cells = new Set<number>([map.lookup(day), map.lookup(night)]);
    for (const c of NIGHT_COLORS) {
      const played = playedFace(night, c);
      expect(map.index(played).added).toBe(false);
      // the night colour alone says it is a night face
      expect(map.lookup(playedFace(day, c))).toBe(map.lookup(played));
      cells.add(map.lookup(played));
      expect(map.index(playedFace(nightFace({ kind: 'wild4', color: null, draw: 6 }), c)).added).toBe(false);
    }
    expect(cells.size).toBe(6);
  });

  it('covers both sides of the Día y Noche deck', () => {
    const map = new FaceMap();
    const day = dayFaces();
    const night = nightFaces();
    expect(day.length).toBeGreaterThan(0);
    expect(night.length).toBeGreaterThan(0);
    for (const f of day) expect(map.index(f).added, faceKey(f)).toBe(false);
    for (const f of night) expect(map.index(nightFace(f)).added, faceKey(f)).toBe(false);
  });
});
