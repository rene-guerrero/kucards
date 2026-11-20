import { describe, expect, it } from 'vitest';
import type { GameEvent, MatchState, Move } from '../contracts';
import { applyMove, cardCount, closeWindow, createMatch, DEFAULT_RULES, legalMoves, RULE_PRESETS, startRound } from '.';
import { card, num, scenario } from './testutil';

const types = (ev: GameEvent[]) => ev.map((e) => e.type);
const play = (m: MatchState, move: Move) => applyMove(m, move);

describe('basic turns', () => {
  it('plays a matching number and advances the turn', () => {
    const c = num('sol', 3);
    const m = scenario({ hands: { 0: [c, num('mar', 8), num('mar', 7)], 1: [num('sol', 1)] }, top: num('sol', 5) });
    expect(legalMoves(m).filter((x) => x.kind === 'play').map((x) => (x as { cardId: number }).cardId)).toEqual([c.id]);
    const { match, events } = play(m, { kind: 'play', seat: 0, cardId: c.id });
    expect(types(events)).toEqual(['play', 'turn']);
    expect(match.round!.turn).toBe(1);
    expect(match.round!.discard.at(-1)).toBe(c);
    expect(m.round!.hands[0]).toHaveLength(3); // input untouched
  });

  it('matches by number across colours, rejects illegal moves', () => {
    const ok = num('mar', 5);
    const bad = num('mar', 6);
    const m = scenario({ hands: { 0: [ok, bad, num('sol', 1)] }, top: num('sol', 5) });
    expect(() => play(m, { kind: 'play', seat: 0, cardId: bad.id })).toThrow(/illegal/);
    expect(() => play(m, { kind: 'play', seat: 1, cardId: ok.id })).toThrow(/illegal/);
    expect(play(m, { kind: 'play', seat: 0, cardId: ok.id }).match.round!.activeColor).toBe('mar');
  });

  it('skip jumps the next seat', () => {
    const s = card('skip', 'sol');
    const m = scenario({ hands: { 0: [s, num('mar', 1)] }, top: num('sol', 5) });
    const { match, events } = play(m, { kind: 'play', seat: 0, cardId: s.id });
    expect(events).toContainEqual({ type: 'skip', seat: 1 });
    expect(match.round!.turn).toBe(2);
  });

  it('reverse flips direction with 3+ players and acts as skip with 2', () => {
    const rv = card('reverse', 'sol');
    const m3 = scenario({ players: 3, hands: { 0: [rv, num('mar', 1)] }, top: num('sol', 5) });
    const a = play(m3, { kind: 'play', seat: 0, cardId: rv.id });
    expect(a.match.round!.direction).toBe(-1);
    expect(a.match.round!.turn).toBe(3); // seats [0,1,3]: backwards from 0 is 3
    const rv2 = card('reverse', 'sol');
    const m2 = scenario({ players: 2, hands: { 0: [rv2, num('mar', 1)], 2: [num('mar', 2)] }, top: num('sol', 5) });
    const b = play(m2, { kind: 'play', seat: 0, cardId: rv2.id });
    expect(b.match.round!.turn).toBe(0);
    expect(b.events).toContainEqual({ type: 'skip', seat: 2 });
  });

  it('wilds need a colour and set the active colour', () => {
    const w = card('wild');
    const m = scenario({ hands: { 0: [w, num('mar', 1)] }, top: num('sol', 5) });
    const plays = legalMoves(m).filter((x) => x.kind === 'play');
    expect(plays).toHaveLength(4);
    expect(() => play(m, { kind: 'play', seat: 0, cardId: w.id })).toThrow(/illegal/);
    const { match, events } = play(m, { kind: 'play', seat: 0, cardId: w.id, color: 'palma' });
    expect(match.round!.activeColor).toBe('palma');
    expect(events[0]).toMatchObject({ type: 'play', color: 'palma' });
  });

  it('draw2 and wild4 make the next seat draw and lose the turn (no stacking)', () => {
    const d2 = card('draw2', 'sol');
    const m = scenario({ hands: { 0: [d2, num('mar', 1)], 1: [num('mar', 3)] }, top: num('sol', 5) });
    const { match, events } = play(m, { kind: 'play', seat: 0, cardId: d2.id });
    expect(match.round!.hands[1]).toHaveLength(3);
    expect(events).toContainEqual(expect.objectContaining({ type: 'draw', seat: 1, count: 2, reason: 'penalty' }));
    expect(match.round!.turn).toBe(2);
    const w4 = card('wild4');
    const m2 = scenario({ hands: { 0: [w4, num('mar', 1)], 1: [num('mar', 3)] }, top: num('sol', 5) });
    const r2 = play(m2, { kind: 'play', seat: 0, cardId: w4.id, color: 'mar' }).match.round!;
    // a +4 always waits for the victim's challenge-or-accept
    expect(r2.pendingDraw).toBe(4);
    const r3 = play(play(m2, { kind: 'play', seat: 0, cardId: w4.id, color: 'mar' }).match, { kind: 'acceptPenalty', seat: 1 }).match.round!;
    expect(r3.hands[1]).toHaveLength(5);
    expect(r3.activeColor).toBe('mar');
    expect(r3.turn).toBe(2);
  });

  it('shield and mirror are playable as plain cards on colour; swap is a wild', () => {
    const sh = card('shield', 'sol');
    const mi = card('mirror', 'sol');
    const sw = card('swap');
    const m = scenario({ hands: { 0: [sh, mi, sw, num('mar', 1)] }, top: num('sol', 5) });
    const ids = legalMoves(m).filter((x) => x.kind === 'play').map((x) => (x as { cardId: number }).cardId);
    expect(ids).toContain(sh.id);
    expect(ids).toContain(mi.id);
    expect(ids).toContain(sw.id);
    expect(types(play(m, { kind: 'play', seat: 0, cardId: sh.id }).events)).toEqual(['play', 'turn']);
    expect(play(m, { kind: 'play', seat: 0, cardId: mi.id }).match.round!.turn).toBe(1);
    expect(play(m, { kind: 'play', seat: 0, cardId: sw.id, color: 'mar', target: 1 }).match.round!.activeColor).toBe('mar');
  });
});

describe('drawing', () => {
  it('draw one: a playable card may be played or kept', () => {
    const drawn = num('sol', 2);
    const m = scenario({ hands: { 0: [num('mar', 1)] }, top: num('sol', 5), deck: [num('coral', 1), drawn] });
    const { match } = play(m, { kind: 'draw', seat: 0 });
    expect(match.round!.turn).toBe(0);
    expect(match.round!.drewThisTurn).toBe(true);
    const moves = legalMoves(match);
    expect(moves).toContainEqual({ kind: 'play', seat: 0, cardId: drawn.id });
    expect(moves).toContainEqual({ kind: 'pass', seat: 0 });
    expect(moves.some((x) => x.kind === 'draw')).toBe(false);
    const passed = play(match, { kind: 'pass', seat: 0 }).match.round!;
    expect(passed.turn).toBe(1);
    expect(passed.drewThisTurn).toBe(false);
  });

  it('forcePlay removes the pass option', () => {
    const drawn = num('sol', 2);
    const m = scenario({ rules: { forcePlay: true }, hands: { 0: [num('mar', 1)] }, top: num('sol', 5), deck: [drawn] });
    const moves = legalMoves(play(m, { kind: 'draw', seat: 0 }).match);
    expect(moves.filter((x) => x.kind !== 'callKu')).toEqual([{ kind: 'play', seat: 0, cardId: drawn.id }]);
  });

  it('an unplayable drawn card ends the turn', () => {
    const m = scenario({ hands: { 0: [num('mar', 1)] }, top: num('sol', 5), deck: [num('coral', 2), num('coral', 1)] });
    const { match, events } = play(m, { kind: 'draw', seat: 0 });
    expect(types(events)).toEqual(['draw', 'turn']);
    expect(match.round!.turn).toBe(1);
  });

  it('draw until playable', () => {
    const good = num('sol', 2);
    const m = scenario({ rules: { drawMode: 'untilPlayable' }, hands: { 0: [num('mar', 1)] }, top: num('sol', 5), deck: [num('coral', 9), good, num('coral', 1), num('mar', 2)] });
    const { match, events } = play(m, { kind: 'draw', seat: 0 });
    expect(events[0]).toMatchObject({ type: 'draw', count: 3 });
    expect(match.round!.hands[0].at(-1)).toBe(good);
    expect(match.round!.turn).toBe(0);
  });

  it('reshuffles the pile into the deck keeping the top card', () => {
    const top = num('sol', 5);
    const under = [num('mar', 1), num('mar', 2), num('mar', 3)];
    const m = scenario({ hands: { 0: [num('coral', 1)], 1: [num('coral', 2)], 2: [num('coral', 3)], 3: [num('coral', 4)] }, top, deck: [], discardUnder: under });
    const before = cardCount(m.round!);
    const { match, events } = play(m, { kind: 'draw', seat: 0 });
    expect(types(events)).toEqual(['reshuffle', 'draw', 'turn']);
    expect(events[0]).toEqual({ type: 'reshuffle', count: 3 });
    expect(match.round!.discard).toEqual([top]);
    expect(match.round!.deck).toHaveLength(2);
    expect(cardCount(match.round!)).toBe(before);
  });

  it('a round where nobody can play or draw ends blocked (lowest hand wins)', () => {
    const m = scenario({ players: 2, rules: { target: 0 }, hands: { 0: [num('mar', 9)], 2: [num('mar', 1), num('coral', 1)] }, top: num('sol', 5), deck: [] });
    const { match, events } = play(m, { kind: 'draw', seat: 0 });
    expect(match.round!.over).toBe(true);
    expect(events).toContainEqual({ type: 'roundEnd', winner: 2, points: [9, 0, 0, 0, 0, 0].map((_, i) => (i === 2 ? 9 : 0)) });
  });
});

describe('stacking', () => {
  const d2 = () => card('draw2', 'sol');
  it("'same': +2 on +2, then accept takes the whole stack", () => {
    const a = d2();
    const b = card('draw2', 'mar');
    const w4 = card('wild4');
    const m = scenario({ rules: { stacking: 'same' }, hands: { 0: [a, num('mar', 1)], 1: [b, w4, num('coral', 1)], 2: [num('palma', 1), num('palma', 2)] }, top: num('sol', 5) });
    const r1 = play(m, { kind: 'play', seat: 0, cardId: a.id });
    expect(r1.match.round!.pendingDraw).toBe(2);
    expect(r1.match.round!.turn).toBe(1);
    const l = legalMoves(r1.match);
    expect(l).toContainEqual({ kind: 'play', seat: 1, cardId: b.id });
    expect(l.some((x) => x.kind === 'play' && x.cardId === w4.id)).toBe(false);
    expect(l.some((x) => x.kind === 'draw')).toBe(false);
    const r2 = play(r1.match, { kind: 'play', seat: 1, cardId: b.id });
    expect(r2.events).toContainEqual({ type: 'stack', total: 4 });
    expect(r2.match.round!.turn).toBe(2);
    const r3 = play(r2.match, { kind: 'acceptPenalty', seat: 2 });
    expect(r3.match.round!.hands[2]).toHaveLength(6);
    expect(r3.match.round!.pendingDraw).toBe(0);
    expect(r3.match.round!.turn).toBe(3);
  });

  it("'any': +4 on +2, but no +2 on a +4 (never lower)", () => {
    const a = d2();
    const w4 = card('wild4');
    const m = scenario({ rules: { stacking: 'any' }, hands: { 0: [a, num('mar', 1)], 1: [w4, num('coral', 1)], 2: [card('draw2', 'mar'), card('draw2', 'coral'), num('sol', 1)] }, top: num('sol', 5) });
    const r1 = play(m, { kind: 'play', seat: 0, cardId: a.id }).match;
    const r2 = play(r1, { kind: 'play', seat: 1, cardId: w4.id, color: 'mar' }).match;
    expect(r2.round!.pendingDraw).toBe(6);
    const stackIds = legalMoves(r2).filter((x) => x.kind === 'play').map((x) => (x as { cardId: number }).cardId);
    expect(stackIds).toEqual([]); // a +2 never goes on a +4
    expect(legalMoves(r2).some((x) => x.kind === 'acceptPenalty')).toBe(true);
  });

  it('after a penalty is drawn, the next player draws just 1 from the deck (regression)', () => {
    const a = d2();
    const deck = Array.from({ length: 20 }, () => num('coral', 9));
    for (const stacking of ['off', 'any'] as const) {
      const m = scenario({ rules: { stacking, drawMode: 'one' }, deck, hands: { 0: [a, num('mar', 1)], 1: [num('palma', 1)], 2: [num('palma', 3), num('palma', 4)] }, top: num('sol', 5) });
      let x = play(m, { kind: 'play', seat: 0, cardId: a.id }).match;
      if (stacking === 'any') x = play(x, { kind: 'acceptPenalty', seat: 1 }).match;
      expect(x.round!.hands[1]).toHaveLength(3);
      expect(x.round!.turn).toBe(2);
      expect(x.round!.pendingDraw).toBe(0);
      expect(legalMoves(x).some((l) => l.kind === 'acceptPenalty')).toBe(false);
      const r = play(x, { kind: 'draw', seat: 2 });
      expect(r.events.filter((e) => e.type === 'draw').map((e) => (e as { count: number }).count)).toEqual([1]);
      expect(r.match.round!.hands[2]).toHaveLength(3);
    }
  });

  it('stacking off: no pending penalty', () => {
    const a = d2();
    const m = scenario({ hands: { 0: [a, num('mar', 1)], 1: [card('draw2', 'mar')] }, top: num('sol', 5) });
    expect(play(m, { kind: 'play', seat: 0, cardId: a.id }).match.round!.pendingDraw).toBe(0);
  });
});

describe('jump-in', () => {
  it('an off-turn seat with an identical card may jump in; play continues from it', () => {
    const top = num('sol', 5);
    const twin = num('sol', 5);
    const m = scenario({ rules: { jumpIn: true }, hands: { 0: [num('mar', 1)], 1: [num('mar', 2)], 2: [twin, num('coral', 3)], 3: [num('mar', 4)] }, top });
    expect(legalMoves(m, 2)).toContainEqual({ kind: 'jumpIn', seat: 2, cardId: twin.id });
    expect(legalMoves(m, 1).some((x) => x.kind === 'jumpIn')).toBe(false);
    const { match, events } = play(m, { kind: 'jumpIn', seat: 2, cardId: twin.id });
    expect(events[0]).toMatchObject({ type: 'play', seat: 2 });
    expect(match.round!.turn).toBe(3);
  });

  it('is off by default and never for wilds or different colours', () => {
    const top = num('sol', 5);
    const m = scenario({ hands: { 2: [num('sol', 5), num('mar', 5)] }, top });
    expect(legalMoves(m, 2).some((x) => x.kind === 'jumpIn')).toBe(false);
    const m2 = scenario({ rules: { jumpIn: true }, hands: { 2: [num('mar', 5), card('wild')] }, top: card('wild'), activeColor: 'sol' });
    expect(legalMoves(m2, 2).some((x) => x.kind === 'jumpIn')).toBe(false);
  });

  it('a jumped-in skip skips the seat after the jumper', () => {
    const top = card('skip', 'mar');
    const twin = card('skip', 'mar');
    const m = scenario({ rules: { jumpIn: true }, hands: { 0: [num('sol', 1)], 1: [twin, num('sol', 2)] }, top, turn: 2 });
    expect(play(m, { kind: 'jumpIn', seat: 1, cardId: twin.id }).match.round!.turn).toBe(3);
  });
});

describe('7-0', () => {
  it('a 7 swaps hands with the chosen seat', () => {
    const seven = num('sol', 7);
    const theirs = [num('mar', 1)];
    const m = scenario({ rules: { sevenZero: true }, hands: { 0: [seven, num('mar', 2), num('mar', 3)], 2: theirs }, top: num('sol', 5) });
    const plays = legalMoves(m).filter((x) => x.kind === 'play' && x.cardId === seven.id);
    expect(plays).toHaveLength(3); // one per other seat
    const { match, events } = play(m, { kind: 'play', seat: 0, cardId: seven.id, target: 2 });
    expect(events).toContainEqual(expect.objectContaining({ type: 'swapHands', a: 0, b: 2, cards: expect.any(Array) }));
    expect(match.round!.hands[0]).toEqual(theirs);
    expect(match.round!.hands[2]).toHaveLength(2);
  });

  it('a 0 passes every hand along in play direction', () => {
    const zero = num('sol', 0);
    const h1 = [num('mar', 1)];
    const h3 = [num('mar', 3), num('mar', 4)];
    const m = scenario({ players: 3, rules: { sevenZero: true }, hands: { 0: [zero, num('coral', 1), num('coral', 2)], 1: h1, 3: h3 }, top: num('sol', 5) });
    const { match, events } = play(m, { kind: 'play', seat: 0, cardId: zero.id });
    expect(events).toContainEqual(expect.objectContaining({ type: 'rotateHands', direction: 1, cards: expect.any(Array) }));
    const r = match.round!;
    expect(r.hands[1]).toHaveLength(2); // seat 0's remaining two cards
    expect(r.hands[3]).toEqual(h1);
    expect(r.hands[0]).toEqual(h3);
  });

  it('without the rule a 7 needs no target', () => {
    const seven = num('sol', 7);
    const m = scenario({ hands: { 0: [seven, num('mar', 2)] }, top: num('sol', 5) });
    expect(legalMoves(m)).toContainEqual({ kind: 'play', seat: 0, cardId: seven.id });
  });
});

describe('¡Ku!', () => {
  const twoCards = () => {
    const a = num('sol', 1);
    const m = scenario({ hands: { 0: [a, num('mar', 9)], 1: [num('coral', 3), num('coral', 4)], 2: [num('palma', 1), num('palma', 2)] }, top: num('sol', 5) });
    return { m, a };
  };

  it('calling with the play: no window', () => {
    const { m, a } = twoCards();
    const { match, events } = play(m, { kind: 'play', seat: 0, cardId: a.id, ku: true });
    expect(events[0]).toEqual({ type: 'ku', seat: 0 });
    expect(match.round!.window).toBeNull();
    expect(match.round!.kuCalled[0]).toBe(true);
  });

  it('calling before the play (callKu) also counts', () => {
    const { m, a } = twoCards();
    expect(legalMoves(m)).toContainEqual({ kind: 'callKu', seat: 0 });
    const m1 = play(m, { kind: 'callKu', seat: 0 }).match;
    expect(play(m1, { kind: 'play', seat: 0, cardId: a.id }).match.round!.window).toBeNull();
  });

  it('forgetting opens a catch window; catching makes the offender draw 2', () => {
    const { m, a } = twoCards();
    const { match, events } = play(m, { kind: 'play', seat: 0, cardId: a.id });
    expect(match.round!.window).toEqual({ reason: 'ku', seats: [1, 2, 3], victim: 0 });
    expect(events).toContainEqual({ type: 'window', window: match.round!.window });
    expect(legalMoves(match, 2)).toContainEqual({ kind: 'catchKu', seat: 2, target: 0 });
    const c = play(match, { kind: 'catchKu', seat: 2, target: 0 });
    expect(c.match.round!.hands[0]).toHaveLength(3);
    expect(c.match.round!.window).toBeNull();
    expect(c.events).toContainEqual({ type: 'kuCaught', by: 2, target: 0 });
    expect(c.events).toContainEqual(expect.objectContaining({ type: 'draw', seat: 0, count: 2, reason: 'catch' }));
    expect(c.match.round!.turn).toBe(1); // turn unchanged
  });

  it('the offender may still call; the next move or the timer closes the window', () => {
    const { m, a } = twoCards();
    const w = play(m, { kind: 'play', seat: 0, cardId: a.id }).match;
    expect(play(w, { kind: 'callKu', seat: 0 }).match.round!.window).toBeNull();
    const moved = play(w, { kind: 'draw', seat: 1 }).match;
    expect(moved.round!.window).toBeNull();
    expect(legalMoves(moved, 2).some((x) => x.kind === 'catchKu')).toBe(false);
    const closed = closeWindow(w);
    expect(closed.match.round!.window).toBeNull();
    expect(closed.events).toEqual([{ type: 'window', window: null }]);
    expect(closeWindow(closed.match).events).toEqual([]);
  });

  it('off: no windows and no ku moves', () => {
    const a = num('sol', 1);
    const m = scenario({ rules: { kuCall: false }, hands: { 0: [a, num('mar', 9)] }, top: num('sol', 5) });
    expect(legalMoves(m).some((x) => x.kind === 'callKu')).toBe(false);
    expect(play(m, { kind: 'play', seat: 0, cardId: a.id }).match.round!.window).toBeNull();
  });

  it('the ¡Ku! flag travels with a swapped hand', () => {
    const seven = num('sol', 7);
    const m = scenario({ rules: { sevenZero: true }, hands: { 0: [seven, num('mar', 2)], 1: [num('coral', 1), num('coral', 2), num('coral', 3)] }, top: num('sol', 5) });
    const r = play(m, { kind: 'play', seat: 0, cardId: seven.id, target: 1 }).match.round!;
    expect(r.window).toEqual({ reason: 'ku', seats: [0, 2, 3], victim: 1 });
  });
});

describe('elimination', () => {
  it('a seat reaching the limit is out, its cards go under the deck, last one standing wins', () => {
    const d2 = card('draw2', 'sol');
    const big = Array.from({ length: 23 }, (_, i) => num('mar', i % 10));
    const m = scenario({ players: 2, rules: { eliminateAt: 25, target: 0 }, hands: { 0: [d2, num('coral', 1), num('coral', 2)], 2: big }, top: num('sol', 5) });
    const before = cardCount(m.round!);
    const { match, events } = play(m, { kind: 'play', seat: 0, cardId: d2.id });
    const r = match.round!;
    expect(events).toContainEqual({ type: 'eliminated', seat: 2 });
    expect(r.eliminated[2]).toBe(true);
    expect(r.hands[2]).toHaveLength(0);
    expect(r.deck[0]).toBe(big[0]);
    expect(cardCount(r)).toBe(before);
    expect(r.over).toBe(true);
    // the survivor scores what the eliminated seat held: 23 cards (93) + the 2 drawn coral 9s
    expect(events).toContainEqual({ type: 'roundEnd', winner: 0, points: [111, 0, 0, 0, 0, 0] });
    expect(match.over).toBe(true);
  });

  it('with 3 players the round goes on and turns skip the eliminated seat', () => {
    const d2 = card('draw2', 'sol');
    const big = Array.from({ length: 24 }, () => num('mar', 1));
    const m = scenario({ players: 3, rules: { eliminateAt: 25 }, hands: { 0: [d2, num('coral', 1)], 1: big, 3: [num('palma', 1)] }, top: num('sol', 5) });
    const r = play(m, { kind: 'play', seat: 0, cardId: d2.id, ku: true }).match.round!;
    expect(r.eliminated[1]).toBe(true);
    expect(r.over).toBe(false);
    expect(r.turn).toBe(3);
  });
});

describe('round and match end', () => {
  it('going out scores the other hands; single-round target ends the match', () => {
    const last = num('sol', 1);
    const m = scenario({ players: 3, rules: { target: 0 }, hands: { 0: [last], 1: [card('wild'), num('mar', 3)], 3: [card('skip', 'mar')] }, top: num('sol', 5) });
    const { match, events } = play(m, { kind: 'play', seat: 0, cardId: last.id });
    expect(types(events)).toEqual(['play', 'roundEnd', 'matchEnd']);
    expect(events[1]).toEqual({ type: 'roundEnd', winner: 0, points: [73, 0, 0, 0, 0, 0] });
    expect(match.scores[0]).toBe(73);
    expect(match.over).toBe(true);
    expect(match.winner).toBe(0);
  });

  it('a last penalty card still makes the victim draw before scoring', () => {
    const last = card('draw2', 'sol');
    const m = scenario({ players: 2, rules: { target: 0 }, hands: { 0: [last], 2: [num('mar', 3)] }, top: num('sol', 5), deck: [num('coral', 1), num('coral', 2)] });
    const { events } = play(m, { kind: 'play', seat: 0, cardId: last.id });
    expect(events.find((e) => e.type === 'roundEnd')).toEqual({ type: 'roundEnd', winner: 0, points: [6, 0, 0, 0, 0, 0] });
  });

  it('with a points target the match continues until someone reaches it', () => {
    const last = num('sol', 1);
    const m = scenario({ players: 2, rules: { target: 200 }, hands: { 0: [last], 2: [num('mar', 3)] }, top: num('sol', 5) });
    const a = play(m, { kind: 'play', seat: 0, cardId: last.id });
    expect(a.match.over).toBe(false);
    expect(types(a.events)).toEqual(['play', 'roundEnd']);
    const next = startRound(a.match).match;
    expect(next.round!.roundNo).toBe(2);
    expect(next.scores[0]).toBe(3);
    const near = { ...m, scores: [198, 0, 0, 0, 0, 0] };
    const b = play(near, { kind: 'play', seat: 0, cardId: last.id });
    expect(b.match.over).toBe(true);
    expect(b.events.at(-1)).toEqual({ type: 'matchEnd', winner: 0 });
  });

  it('applyMove refuses once the round is over', () => {
    const last = num('sol', 1);
    const m = scenario({ players: 2, hands: { 0: [last], 2: [num('mar', 3)] }, top: num('sol', 5) });
    const over = play(m, { kind: 'play', seat: 0, cardId: last.id }).match;
    expect(legalMoves(over)).toEqual([]);
    expect(() => play(over, { kind: 'draw', seat: 2 })).toThrow();
  });
});

describe('2 vs 2 in every mode, Codo a codo', () => {
  it('Clásico 2 vs 2: partners across, team score and team win with Clásico rules', () => {
    const m0 = createMatch(RULE_PRESETS.find((p) => p.id === 'classic')!.rules, { mode: 'classic', players: 4, teams: true }, 1);
    expect(m0.mode).toBe('classic');
    expect(m0.teams).toEqual([[0, 2], [1, 3]]);
    expect(m0.rules.stacking).toBe('off');
    const last = num('sol', 1);
    const m = scenario({ seating: 'across', rules: { target: 500, kuCall: false }, hands: { 0: [last], 1: [num('mar', 9)], 2: [num('mar', 4)], 3: [num('mar', 7)] }, top: num('sol', 5) });
    expect(m.mode).toBe('classic');
    const { match } = applyMove(m, { kind: 'play', seat: 0, cardId: last.id });
    expect(match.round!.over).toBe(true);
    expect(match.scores[0]).toBe(16);
    expect(match.scores[2]).toBe(16);
    expect(match.scores[1]).toBe(0);
  });

  it('Codo a codo: always 4 players side by side, stacking forced on', () => {
    const m = createMatch({ ...DEFAULT_RULES, stacking: 'off' }, { mode: 'sideBySide', players: 2 }, 1);
    expect(m.seats).toEqual([0, 1, 2, 3]);
    expect(m.teams).toEqual([[0, 1], [2, 3]]);
    expect(m.rules.stacking).toBe('any');
    expect(createMatch({ ...DEFAULT_RULES, stacking: 'same' }, { mode: 'sideBySide', players: 4 }, 1).rules.stacking).toBe('any');
    expect(RULE_PRESETS.find((p) => p.id === 'sideBySide')!.rules.stacking).toBe('any');
  });
});

describe('partners', () => {
  for (const seating of ['across', 'side'] as const) {
    it(`${seating}: the team scores both opponents' cards, both partners carry it`, () => {
      const m0 = scenario({ seating, rules: { target: 200 }, hands: {}, top: num('sol', 5) });
      const [mine, theirs] = m0.teams!;
      const partner = mine[1];
      const last = num('sol', 1);
      const m = scenario({
        seating, rules: { target: 200 }, top: num('sol', 5),
        hands: { 0: [last], [partner]: [num('mar', 9)], [theirs[0]]: [num('mar', 4)], [theirs[1]]: [card('skip', 'coral')] },
      });
      const { match, events } = play(m, { kind: 'play', seat: 0, cardId: last.id });
      const expected = [0, 0, 0, 0, 0, 0];
      expected[0] = 24;
      expected[partner] = 24;
      expect(events.find((e) => e.type === 'roundEnd')).toEqual({ type: 'roundEnd', winner: 0, points: expected });
      expect(match.scores[0]).toBe(24);
      expect(match.scores[partner]).toBe(24);
      expect(match.scores[theirs[0]]).toBe(0);
    });
  }

  it('the team wins the match when its score reaches the target', () => {
    const last = num('sol', 1);
    const m = scenario({ seating: 'side', rules: { target: 200 }, hands: { 1: [last], 0: [num('mar', 1)], 2: [num('mar', 9)], 3: [num('mar', 9)] }, top: num('sol', 5), turn: 1 });
    const near = { ...m, scores: [190, 190, 0, 0, 0, 0] };
    const { match, events } = play(near, { kind: 'play', seat: 1, cardId: last.id });
    expect(match.over).toBe(true);
    expect(match.winnerTeam).toBe(0);
    expect(events.at(-1)).toEqual({ type: 'matchEnd', winner: 1, winnerTeam: 0 });
  });

  it('with elimination, the round ends when one team is left', () => {
    const d2 = card('draw2', 'sol');
    const big = Array.from({ length: 24 }, () => num('mar', 1));
    const m = scenario({ seating: 'across', rules: { eliminateAt: 25 }, hands: { 0: [d2, num('coral', 1)], 1: big, 2: [num('palma', 1)], 3: [] }, top: num('sol', 5) });
    const elim = { ...m, round: { ...m.round!, eliminated: [false, false, false, true, false, false] } };
    const { match } = play(elim, { kind: 'play', seat: 0, cardId: d2.id, ku: true });
    expect(match.round!.over).toBe(true);
  });
});

describe('deal options', () => {
  it('handSize sets the deal', () => {
    for (const n of [5, 10]) {
      const { match } = startRound(createMatch({ ...DEFAULT_RULES, handSize: n }, { mode: 'classic', players: 4 }, 3));
      for (const s of match.seats) expect(match.round!.hands[s]).toHaveLength(n);
    }
  });

  it('every preset deals a consistent round', () => {
    for (const p of RULE_PRESETS) {
      const { match } = startRound(createMatch(p.rules, { mode: p.id, players: 4 }, 11));
      expect(legalMoves(match).length).toBeGreaterThan(0);
    }
  });
});
