import { describe, expect, it } from 'vitest';
import type { Difficulty, MatchState, Move } from '../contracts';
import { applyMove, chooseMove, closeWindow, createMatch, RULE_PRESETS, startRound } from '.';
import { resetTracker } from './ai';
import { knowledge, MAX_TRACKS, observe, trackerSize } from './aiKnow';

const classic = RULE_PRESETS.find((p) => p.id === 'classic')!.rules;

/** one CPU step (the seat to move, or the window closes); null when the round is over */
function step(m: MatchState, level: Difficulty): { m: MatchState; mv: Move | null } | null {
  const r = m.round!;
  if (r.over) return null;
  const mv = chooseMove(m, r.turn, level);
  if (!mv) return { m: closeWindow(m).match, mv: null };
  return { m: applyMove(m, mv).match, mv };
}

/** the moves a match produces, optionally interleaved step by step with a second one */
function run(a: MatchState, la: Difficulty, b: MatchState | null, lb: Difficulty, steps: number): { a: Move[]; b: Move[] } {
  const out = { a: [] as Move[], b: [] as Move[] };
  let ma: MatchState | null = a;
  let mb: MatchState | null = b;
  for (let i = 0; i < steps; i++) {
    if (ma) {
      const s = step(ma, la);
      ma = s ? s.m : null;
      if (s?.mv) out.a.push(s.mv);
    }
    if (mb) {
      const s = step(mb, lb);
      mb = s ? s.m : null;
      if (s?.mv) out.b.push(s.mv);
    }
  }
  return out;
}

describe('public-history tracker (per match)', () => {
  it('two interleaved matches never share history, even with identical piles', () => {
    // B starts with A's public table (same pile, hands, seats) but is another match (another round seed,
    // another deck order), the worst case for a tracker keyed on the pile lineage alone: both play the
    // same moves until the draws differ.
    const a = startRound(createMatch({ ...classic, target: 0 }, { mode: 'classic', players: 4 }, 11)).match;
    const b: MatchState = { ...a, round: { ...a.round!, seed: (a.round!.seed ?? 0) + 1, deck: a.round!.deck.slice().reverse() } };
    resetTracker();
    const alone = run(a, 'hard', null, 'hard', 400).a;
    resetTracker();
    const aloneB = run(b, 'hard', null, 'hard', 400).a;
    resetTracker();
    const both = run(a, 'hard', b, 'hard', 400);
    expect(both.a).toEqual(alone);
    expect(both.b).toEqual(aloneB);

    // and the inferred voids of A are not polluted by B's history
    resetTracker();
    let m = a;
    for (let i = 0; i < 60 && !m.round!.over; i++) m = step(m, 'hard')!.m;
    const kAlone = knowledge(m, m.round!, 1, observe(m));
    resetTracker();
    let ma = a;
    let mb = b;
    for (let i = 0; i < 60 && !ma.round!.over; i++) {
      ma = step(ma, 'hard')!.m;
      if (!mb.round!.over) {
        mb = step(mb, 'hard')!.m;
        observe(mb);
      }
    }
    const kBoth = knowledge(ma, ma.round!, 1, observe(ma));
    expect(kBoth.voids).toEqual(kAlone.voids);
    expect(kBoth.likes).toEqual(kAlone.likes);
  }, 30_000);

  it('keeps a bounded number of rounds (LRU)', () => {
    resetTracker();
    for (let seed = 1; seed <= MAX_TRACKS + 20; seed++) {
      const m = startRound(createMatch({ ...classic, target: 0 }, { mode: 'classic', players: 3 }, seed)).match;
      chooseMove(m, m.round!.turn, 'hard');
    }
    expect(trackerSize()).toBe(MAX_TRACKS);
  });
});
