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

  it('all-action deck thins numbers and has every power card', () => {
    const d = buildDeck(preset('action'));
    expect(d.some((c) => c.face.kind === 'number' && c.face.value === 3)).toBe(false);
    for (const k of ['swap', 'shield', 'sweep', 'mirror']) expect(d.some((c) => c.face.kind === k)).toBe(true);
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
    expect(createMatch(DEFAULT_RULES, { mode: 'partners', players: 4 }).teams).toEqual([[0, 2], [1, 3]]);
    expect(createMatch(DEFAULT_RULES, { mode: 'partners', players: 4, seating: 'side' }).teams).toEqual([[0, 1], [2, 3]]);
    expect(createMatch(DEFAULT_RULES, { mode: 'partners', players: 4, seating: 'side', partnerSide: 'before' }).teams).toEqual([[0, 3], [1, 2]]);
  });

  it('matches colour, number or kind', () => {
    const top = { id: 0, face: { kind: 'number' as const, color: 'sol' as const, value: 5 } };
    expect(matches({ id: 1, face: { kind: 'number', color: 'mar', value: 5 } }, top, 'sol')).toBe(true);
    expect(matches({ id: 2, face: { kind: 'number', color: 'mar', value: 6 } }, top, 'sol')).toBe(false);
    expect(matches({ id: 3, face: { kind: 'skip', color: 'sol' } }, top, 'sol')).toBe(true);
    expect(matches({ id: 4, face: { kind: 'wild', color: null } }, top, 'sol')).toBe(true);
  });
});
