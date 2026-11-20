import { describe, expect, it } from 'vitest';
import { buildDeck, cardPoints, createMatch, DEFAULT_RULES, matches, RULE_PRESETS, startRound } from '.';

const preset = (id: string) => RULE_PRESETS.find((p) => p.id === id)!.rules;

describe('deck', () => {
  it('classic deck has 108 cards with stable ids', () => {
    const d = buildDeck(DEFAULT_RULES);
    expect(d).toHaveLength(108);
    expect(d.map((c) => c.id)).toEqual(d.map((_, i) => i));
    expect(d.filter((c) => c.face.kind === 'wild4')).toHaveLength(4);
    expect(d.filter((c) => c.face.kind === 'number' && c.face.value === 0)).toHaveLength(4);
  });

  it('power cards follow their toggles', () => {
    const d = buildDeck({ ...DEFAULT_RULES, 'power.swap': true, 'power.shield': true });
    expect(d.filter((c) => c.face.kind === 'swap')).toHaveLength(2);
    expect(d.filter((c) => c.face.kind === 'shield')).toHaveLength(4);
    expect(d.filter((c) => c.face.kind === 'mirror')).toHaveLength(0);
  });

  it('all-action deck thins numbers and has Sweep and Swap, no Skip All', () => {
    const d = buildDeck(preset('action'));
    expect(d.some((c) => c.face.kind === 'number' && c.face.value === 3)).toBe(false);
    for (const k of ['swap', 'sweep']) expect(d.some((c) => c.face.kind === k)).toBe(true);
  });

  it('deck per mode: sizes, no Escudo / Espejo anywhere, Barrida in Codo a codo', () => {
    const count = (d: ReturnType<typeof buildDeck>, k: string) => d.filter((c) => c.face.kind === k).length;
    const sizes: Record<string, number> = { classic: 108, action: 106, cyclone: 128, sideBySide: 120, dayNight: 112 };
    for (const p of RULE_PRESETS) {
      // the deck a match of that mode really plays with (modeRules applied)
      const d = buildDeck(createMatch(p.rules, { mode: p.id, players: 4 }, 1).rules);
      expect(d, p.id).toHaveLength(sizes[p.id]);
      expect(count(d, 'shield') + count(d, 'mirror'), p.id).toBe(0);
      expect(count(d, 'skipAll'), p.id).toBe(0);
      expect(count(d, 'wildColor') + d.filter((c) => c.other?.kind === 'wildColor').length, p.id).toBe(0);
    }
    expect(count(buildDeck(preset('cyclone')), 'sweep')).toBe(8);
    const side = buildDeck(createMatch({ ...preset('sideBySide'), 'power.sweep': false }, { mode: 'sideBySide', players: 4 }, 1).rules);
    expect(count(side, 'sweep')).toBe(8);
    expect(count(side, 'draw6')).toBe(4);
  });

  it('stacking: off by default only in Clásico, always on elsewhere', () => {
    expect(createMatch(preset('classic'), { mode: 'classic', players: 4 }, 1).rules.stacking).toBe('off');
    expect(createMatch({ ...preset('classic'), stacking: 'any' }, { mode: 'classic', players: 4 }, 1).rules.stacking).toBe('any');
    for (const mode of ['action', 'cyclone', 'sideBySide'] as const) {
      expect(preset(mode).stacking, mode).toBe('any');
      expect(createMatch({ ...preset(mode), stacking: 'off' }, { mode, players: 4 }, 1).rules.stacking, mode).toBe('any');
    }
  });

  it('scores cards', () => {
    expect(cardPoints({ kind: 'number', color: 'sol', value: 7 })).toBe(7);
    expect(cardPoints({ kind: 'skip', color: 'mar' })).toBe(20);
    expect(cardPoints({ kind: 'wild4', color: null })).toBe(50);
  });
});

describe('deal', () => {
  it('is deterministic from the seed and deals every seat', () => {
    const m = createMatch(DEFAULT_RULES, { mode: 'classic', players: 3 }, 42);
    const a = startRound(m);
    const b = startRound(m);
    expect(a.match.round!.hands).toEqual(b.match.round!.hands);
    for (const s of m.seats) expect(a.match.round!.hands[s]).toHaveLength(7);
    expect(a.match.round!.hands[2]).toHaveLength(0); // seat 2 is free with 3 players
    const r = a.match.round!;
    expect(r.deck.length + r.discard.length + 21).toBe(108);
    expect(r.discard[0].face.kind).toBe('number');
    expect(m.round).toBeNull(); // input untouched
  });

  it('seats partners across or side by side', () => {
    expect(createMatch(DEFAULT_RULES, { mode: 'classic', players: 4, teams: true }).teams).toEqual([[0, 2], [1, 3]]);
    expect(createMatch(DEFAULT_RULES, { mode: 'action', players: 4, teams: true }).teams).toEqual([[0, 2], [1, 3]]);
    expect(createMatch(DEFAULT_RULES, { mode: 'classic', players: 3, teams: true }).teams).toBeUndefined();
    expect(createMatch(DEFAULT_RULES, { mode: 'classic', players: 4 }).teams).toBeUndefined();
    expect(createMatch(DEFAULT_RULES, { mode: 'sideBySide', players: 2 }).teams).toEqual([[0, 1], [2, 3]]);
    expect(createMatch(DEFAULT_RULES, { mode: 'sideBySide', players: 4, partnerSide: 'before' }).teams).toEqual([[0, 3], [1, 2]]);
  });

  it('matches colour, number or kind', () => {
    const top = { id: 0, face: { kind: 'number' as const, color: 'sol' as const, value: 5 } };
    expect(matches({ id: 1, face: { kind: 'number', color: 'mar', value: 5 } }, top, 'sol')).toBe(true);
    expect(matches({ id: 2, face: { kind: 'number', color: 'mar', value: 6 } }, top, 'sol')).toBe(false);
    expect(matches({ id: 3, face: { kind: 'skip', color: 'sol' } }, top, 'sol')).toBe(true);
    expect(matches({ id: 4, face: { kind: 'wild', color: null } }, top, 'sol')).toBe(true);
  });
});
