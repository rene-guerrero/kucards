/**
 * Optional rules multiDraw2 ("several +2 at once"), multiReverse ("several Reverses at once") and
 * multiSkip ("several Skips at once"): multi-plays of action cards of one kind.
 */
import { describe, expect, it } from 'vitest';
import type { Card, GameEvent, MatchState, Move, Seat } from '../contracts';
import { applyMove, chooseMove, isLegal, legalMoves, multiPlayOptions } from '.';
import { card, num, scenario } from './testutil';

const D2 = { multiDraw2: true };
const RV = { multiReverse: true };
const SK = { multiSkip: true };
const types = (ev: GameEvent[]) => ev.map((e) => e.type);
const play = (seat: Seat, first: Card, ...extra: Card[]): Move => ({ kind: 'play', seat, cardId: first.id, ...(extra.length ? { extra: extra.map((c) => c.id) } : {}) });
const opts = (m: MatchState, c: Card, seat: Seat = 0) => multiPlayOptions(m, { kind: 'play', seat, cardId: c.id }).sort();
const filler = () => [num('mar', 1), num('mar', 2), num('mar', 3)];

describe('multiDraw2: several +2 at once', () => {
  it('lists the other +2s of any colour (never other kinds); rule off lists none', () => {
    const [a, b, c] = [card('draw2', 'coral'), card('draw2', 'mar'), card('draw2', 'sol')];
    const sk = card('skip', 'coral');
    const hand = [a, b, c, sk, num('coral', 2)];
    const m = scenario({ rules: D2, hands: { 0: hand, 1: filler() }, top: num('coral', 5) });
    expect(opts(m, a)).toEqual([b.id, c.id].sort());
    expect(opts(m, b)).toEqual([]); // the first card must be playable (blue on red 5)
    expect(isLegal(m, play(0, a, sk))).toBe(false); // never mixed
    expect(opts(m, sk)).toEqual([]); // multiSkip is off
    expect(opts(scenario({ rules: { multiPlay: true }, hands: { 0: hand, 1: filler() }, top: num('coral', 5) }), a)).toEqual([]);
  });

  it('stacking off: three +2 make the next player draw 6 at once and lose the turn', () => {
    const [a, b, c] = [card('draw2', 'coral'), card('draw2', 'mar'), card('draw2', 'sol')];
    const m = scenario({ rules: { ...D2, stacking: 'off' }, hands: { 0: [a, b, c, num('mar', 4), num('sol', 4)], 1: filler(), 2: filler(), 3: filler() }, top: num('coral', 5) });
    const { match, events } = applyMove(m, play(0, a, b, c));
    expect(types(events)).toEqual(['play', 'play', 'play', 'draw', 'turn']);
    expect(events.slice(0, 3).map((e) => (e as { more?: boolean }).more)).toEqual([true, true, undefined]);
    expect(events[3]).toMatchObject({ type: 'draw', seat: 1, count: 6, reason: 'penalty' });
    const r = match.round!;
    expect(r.hands[1]).toHaveLength(9);
    expect(r.turn).toBe(2);
    expect(r.pendingDraw).toBe(0);
    expect(r.activeColor).toBe('sol'); // the last one sets the colour
  });

  it('stacking on: the total waits on the next player, who may stack a +2 (or several) on top', () => {
    const [a, b, c] = [card('draw2', 'coral'), card('draw2', 'mar'), card('draw2', 'sol')];
    const [x, y] = [card('draw2', 'palma'), card('draw2', 'coral')];
    const m = scenario({ rules: { ...D2, stacking: 'same' }, hands: { 0: [a, b, c, num('mar', 4)], 1: [x, y, num('mar', 9)], 2: filler(), 3: filler() }, top: num('coral', 5) });
    const first = applyMove(m, play(0, a, b, c));
    expect(first.events.find((e) => e.type === 'stack')).toEqual({ type: 'stack', total: 6 });
    const r = first.match.round!;
    expect(r.pendingDraw).toBe(6);
    expect(r.turn).toBe(1);
    // seat 1 may stack one +2, or both at once (the first one must stack, the second joins)
    expect(isLegal(first.match, play(1, x))).toBe(true);
    expect(opts(first.match, x, 1)).toEqual([y.id]);
    const second = applyMove(first.match, play(1, x, y));
    expect(second.match.round!.pendingDraw).toBe(10);
    expect(second.match.round!.turn).toBe(2);
    // seat 2 cannot stack: draws all 10
    const third = applyMove(second.match, { kind: 'acceptPenalty', seat: 2 });
    expect(third.match.round!.hands[2]).toHaveLength(13);
    expect(third.match.round!.turn).toBe(3);
  });

  it('stacking "any": a +4 may go on top of a multi +2; numbers never join a stack', () => {
    const [a, b] = [card('draw2', 'coral'), card('draw2', 'mar')];
    const w4 = card('wild4');
    const m = scenario({ rules: { ...D2, multiPlay: true, stacking: 'any' }, hands: { 0: [a, b, num('mar', 4)], 1: [w4, num('mar', 9), num('sol', 9)], 2: filler(), 3: filler() }, top: num('coral', 5) });
    const after = applyMove(m, play(0, a, b)).match;
    expect(after.round!.pendingDraw).toBe(4);
    const stacked = applyMove(after, { kind: 'play', seat: 1, cardId: w4.id, color: 'sol' }).match;
    expect(stacked.round!.pendingDraw).toBe(8);
    // a pending penalty: a number card never opens a multi-play
    expect(legalMoves(after, 1).filter((x) => x.kind === 'play').every((p) => p.kind !== 'play' || multiPlayOptions(after, p).length === 0)).toBe(true);
  });

  it('going out on several +2 (numberFinish off): the next player draws the whole total', () => {
    const [a, b] = [card('draw2', 'coral'), card('draw2', 'mar')];
    const m = scenario({ rules: D2, hands: { 0: [a, b], 1: filler() }, top: num('coral', 5) });
    const { match, events } = applyMove(m, play(0, a, b));
    expect(match.round!.over).toBe(true);
    expect(events.find((e) => e.type === 'draw')).toMatchObject({ seat: 1, count: 4 });
  });

  it('CPUs dump all their +2s onto an opponent', () => {
    const [a, b, c] = [card('draw2', 'coral'), card('draw2', 'mar'), card('draw2', 'sol')];
    let seen = 0;
    for (const level of ['easy', 'normal', 'hard', 'master'] as const) {
      for (let i = 0; i < 3; i++) {
        const m = scenario({ rules: { ...D2, stacking: 'off' }, players: 2, hands: { 0: [a, b, c, num('mar', 8), num('sol', 9)], 2: [num('coral', 1), num('coral', 2)] }, top: num('coral', 5) });
        const mv = chooseMove(m, 0, level)!;
        expect(isLegal(m, mv)).toBe(true);
        if (mv.kind !== 'play' || ![a.id, b.id, c.id].includes(mv.cardId)) continue;
        if (level !== 'easy') expect(mv.extra ?? []).toHaveLength(2);
        if (mv.extra?.length) seen++;
      }
    }
    expect(seen).toBeGreaterThan(0);
  });
});

describe('multiReverse: several Reverses at once', () => {
  const four = (n: number, direction: 1 | -1 = 1) => {
    const revs = (['coral', 'mar', 'sol', 'palma'] as const).slice(0, n).map((c) => card('reverse', c));
    return { revs, m: scenario({ rules: RV, direction, hands: { 0: [...revs, num('mar', 4), num('sol', 4)], 1: filler(), 2: filler(), 3: filler() }, top: num('coral', 5) }) };
  };

  it('an even count keeps the direction, an odd count turns it (one reverse event per card)', () => {
    for (const n of [1, 2, 3, 4]) {
      const { revs, m } = four(n);
      const { match, events } = applyMove(m, play(0, revs[0], ...revs.slice(1)));
      expect(types(events).filter((t) => t === 'reverse')).toHaveLength(n);
      expect(match.round!.direction).toBe(n % 2 ? -1 : 1);
      expect(match.round!.turn).toBe(n % 2 ? 3 : 1);
    }
    // starting the other way round
    const { revs, m } = four(2, -1);
    const r = applyMove(m, play(0, revs[0], revs[1])).match.round!;
    expect(r.direction).toBe(-1);
    expect(r.turn).toBe(3);
  });

  it('two players: each reverse is a skip (odd: back to the player, even: the other plays)', () => {
    for (const n of [1, 2, 3]) {
      const revs = (['coral', 'mar', 'sol'] as const).slice(0, n).map((c) => card('reverse', c));
      const m = scenario({ rules: RV, players: 2, hands: { 0: [...revs, num('mar', 4)], 2: filler() }, top: num('coral', 5) });
      const { match, events } = applyMove(m, play(0, revs[0], ...revs.slice(1)));
      expect(events.filter((e) => e.type === 'skip').map((e) => (e as { seat: Seat }).seat)).toEqual([2, 0, 2].slice(0, n));
      expect(match.round!.turn).toBe(n % 2 ? 0 : 2);
      expect(types(events)).not.toContain('reverse');
    }
  });

  it('CPUs between two players keep an odd count (the turn comes back to them)', () => {
    const revs = (['coral', 'mar'] as const).map((c) => card('reverse', c));
    for (const level of ['normal', 'hard'] as const) {
      const m = scenario({ rules: RV, players: 2, hands: { 0: [...revs, num('mar', 8), num('sol', 9)], 2: [num('palma', 1), num('palma', 2)] }, top: num('coral', 5) });
      const mv = chooseMove(m, 0, level)!;
      expect(isLegal(m, mv)).toBe(true);
      if (mv.kind === 'play' && revs.some((r) => r.id === mv.cardId)) expect(mv.extra ?? []).toHaveLength(0);
    }
  });
});

describe('multiSkip: several Skips at once', () => {
  const skips = (n: number) => (['coral', 'mar', 'sol', 'palma'] as const).slice(0, n).map((c) => card('skip', c));
  const run = (n: number, opts: { players?: 2 | 4; direction?: 1 | -1 } = {}) => {
    const ss = skips(n);
    const players = opts.players ?? 4;
    const hands = players === 2 ? { 0: [...ss, num('mar', 4)], 2: filler() } : { 0: [...ss, num('mar', 4)], 1: filler(), 2: filler(), 3: filler() };
    const m = scenario({ rules: SK, players, direction: opts.direction, hands, top: num('coral', 5) });
    const { match, events } = applyMove(m, play(0, ss[0], ...ss.slice(1)));
    return { turn: match.round!.turn, skipped: events.filter((e) => e.type === 'skip').map((e) => (e as { seat: Seat }).seat) };
  };

  it('n skips skip n players, round the table and back to the player', () => {
    expect(run(1)).toEqual({ turn: 2, skipped: [1] });
    expect(run(2)).toEqual({ turn: 3, skipped: [1, 2] });
    expect(run(3)).toEqual({ turn: 0, skipped: [1, 2, 3] });
    expect(run(4)).toEqual({ turn: 1, skipped: [1, 2, 3, 0] });
    expect(run(2, { direction: -1 })).toEqual({ turn: 1, skipped: [3, 2] });
  });

  it('two players: odd counts come back to the player, even counts pass the turn', () => {
    expect(run(1, { players: 2 })).toEqual({ turn: 0, skipped: [2] });
    expect(run(2, { players: 2 })).toEqual({ turn: 2, skipped: [2, 0] });
    expect(run(3, { players: 2 })).toEqual({ turn: 0, skipped: [2, 0, 2] });
  });

  it('skips the eliminated seats when counting', () => {
    const ss = skips(2);
    const m = scenario({ rules: SK, hands: { 0: [...ss, num('mar', 4)], 1: filler(), 2: filler(), 3: filler() }, top: num('coral', 5) });
    m.round!.eliminated[1] = true;
    m.round!.hands[1] = [];
    const r = applyMove(m, play(0, ss[0], ss[1]));
    expect(r.events.filter((e) => e.type === 'skip').map((e) => (e as { seat: Seat }).seat)).toEqual([2, 3]);
    expect(r.match.round!.turn).toBe(0);
  });

  it('numberFinish: skips cannot be the last cards out (one fewer is offered)', () => {
    const [a, b] = skips(2);
    const m = scenario({ rules: { ...SK, numberFinish: true }, hands: { 0: [a, b], 1: filler() }, top: num('coral', 5) });
    expect(opts(m, a)).toEqual([]);
    expect(isLegal(m, play(0, a, b))).toBe(false);
    const [c, d, e] = skips(3);
    const m3 = scenario({ rules: { ...SK, numberFinish: true }, hands: { 0: [c, d, e], 1: filler() }, top: num('coral', 5) });
    expect(opts(m3, c)).toHaveLength(1);
    expect(isLegal(m3, play(0, c, d))).toBe(true);
    expect(isLegal(m3, play(0, c, d, e))).toBe(false);
  });

  it('¡Ku!: offered for the final hand size; called with the play, no catch window', () => {
    const [a, b, c] = skips(3);
    const base = () => scenario({ rules: { ...SK, kuCall: true }, hands: { 0: [a, b, c, num('mar', 4)], 1: filler(), 2: filler(), 3: filler() }, top: num('coral', 5) });
    expect(legalMoves(base()).some((x) => x.kind === 'callKu')).toBe(true);
    const called = applyMove(base(), { ...play(0, a, b, c), ku: true } as Move);
    expect(types(called.events)[0]).toBe('ku');
    expect(called.match.round!.window).toBeNull();
    const missed = applyMove(base(), play(0, a, b, c)).match;
    expect(missed.round!.window).toMatchObject({ reason: 'ku', victim: 0 });
  });

  it('the rules never mix kinds: skips and reverses stay apart even with both rules on', () => {
    const [s1, s2] = skips(2);
    const rv = card('reverse', 'mar');
    const m = scenario({ rules: { ...SK, ...RV, ...D2, multiPlay: true }, hands: { 0: [s1, s2, rv, num('coral', 3)], 1: filler() }, top: num('coral', 5) });
    expect(opts(m, s1)).toEqual([s2.id]);
    expect(isLegal(m, play(0, s1, rv))).toBe(false);
    expect(isLegal(m, play(0, s1, s2))).toBe(true);
  });
});
