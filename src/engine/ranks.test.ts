import { describe, expect, it } from 'vitest';
import { finalRanks } from './ranks';
import { num, scenario } from './testutil';

describe('finalRanks', () => {
  it('ranks the two lowest hands by card points (fewer cards break a tie)', () => {
    const m = scenario({
      top: num('coral', 1),
      hands: { 0: [num('sol', 9)], 1: [num('sol', 2), num('sol', 3)], 2: [num('sol', 5)], 3: [num('sol', 1), num('sol', 4)] },
    });
    // points: 9, 5, 5, 5 -> seat 2 (one card) first; seats 1 and 3 tie, seat order gives 1 the second badge
    expect(finalRanks(m).sort()).toEqual([[1, 2], [2, 1]]);
  });

  it('2 vs 2: still only the two lowest players, whatever their team', () => {
    const m = scenario({
      seating: 'across',
      top: num('coral', 1),
      hands: { 0: [num('sol', 9)], 1: [num('sol', 1)], 2: [num('sol', 1)], 3: [num('sol', 2)] },
    });
    // seats 1 and 2 hold 1 point each (seat order: 1 first), seat 3 holds 2: partners are not lumped together
    expect(Object.fromEntries(finalRanks(m))).toEqual({ 1: 1, 2: 2 });
  });

  it('is empty without a live round', () => {
    const m = scenario({ top: num('coral', 1), hands: {} });
    expect(finalRanks({ ...m, round: { ...m.round!, over: true } })).toEqual([]);
  });
});
