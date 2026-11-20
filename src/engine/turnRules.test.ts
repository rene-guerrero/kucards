import { describe, expect, it } from 'vitest';
import type { MatchState, Move } from '../contracts';
import { afterAutoDraw, applyMove, closeWindow, legalMoves, timeoutMove } from '.';
import { card, num, scenario } from './testutil';

const play = (m: MatchState, mv: Move) => applyMove(m, mv).match;
const kinds = (m: MatchState) => legalMoves(m).map((x) => x.kind).filter((k) => k !== 'callKu');

describe('mandatory stacking', () => {
  it('a victim holding a stackable card must stack (no accept); without one it accepts', () => {
    const d2 = card('draw2', 'sol');
    const m = scenario({ rules: { stacking: 'any', kuCall: false }, hands: { 0: [d2, num('mar', 1)], 1: [card('draw2', 'mar'), num('mar', 3)], 2: [num('palma', 1)] }, top: num('sol', 5) });
    const a = play(m, { kind: 'play', seat: 0, cardId: d2.id });
    expect(kinds(a)).toEqual(['play']);
    // the response timer never takes the penalty for a victim who can stack
    expect(closeWindow(a).match.round!.pendingDraw).toBe(2);
    const b = play(a, { kind: 'play', seat: 1, cardId: a.round!.hands[1][0].id });
    expect(kinds(b)).toEqual(['acceptPenalty']);
  });

  it('never a lower penalty: no +2 on a +4 (but the +4 may be challenged)', () => {
    const w4 = card('wild4');
    const m = scenario({ rules: { stacking: 'any', kuCall: false }, hands: { 0: [w4, num('mar', 1)], 1: [card('draw2', 'sol'), num('mar', 3)], 2: [num('palma', 1)] }, top: num('sol', 5) });
    const a = play(m, { kind: 'play', seat: 0, cardId: w4.id, color: 'sol' });
    expect(kinds(a)).toEqual(['challenge', 'acceptPenalty']);
  });

  it('on a +4 the victim who can stack must stack or challenge', () => {
    const w4 = card('wild4');
    const m = scenario({ rules: { stacking: 'any', kuCall: false }, hands: { 0: [w4, num('mar', 1)], 1: [card('wild4'), num('mar', 3)], 2: [num('palma', 1)] }, top: num('sol', 5) });
    expect(kinds(play(m, { kind: 'play', seat: 0, cardId: w4.id, color: 'sol' }))).toEqual(['play', 'play', 'play', 'play', 'challenge']);
  });
});

describe('challenge the +4 (always on)', () => {
  const setup = (holdsColor: boolean) => {
    const w4 = card('wild4');
    const m = scenario({ rules: { kuCall: false }, hands: { 0: [w4, holdsColor ? num('sol', 1) : num('mar', 1), num('coral', 4)], 1: [num('mar', 3)] }, top: num('sol', 5) });
    return play(m, { kind: 'play', seat: 0, cardId: w4.id, color: 'palma' });
  };
  it('succeeds when the player held the colour in play: they draw 4, the challenger nothing', () => {
    const r = play(setup(true), { kind: 'challenge', seat: 1 }).round!;
    expect([r.hands[0].length, r.hands[1].length, r.turn]).toEqual([6, 1, 1]);
  });
  it('fails otherwise: the challenger draws 6 and loses the turn', () => {
    const r = play(setup(false), { kind: 'challenge', seat: 1 }).round!;
    expect([r.hands[0].length, r.hands[1].length, r.turn]).toEqual([2, 7, 2]);
  });
});

describe('turn timer', () => {
  it('a timed-out wild is played red', () => {
    const w = card('wild');
    const m = scenario({ rules: { kuCall: false }, hands: { 0: [w, num('mar', 1), num('mar', 2)] }, top: num('sol', 5) });
    expect(timeoutMove(m, 0)).toMatchObject({ kind: 'play', cardId: w.id, color: 'coral' });
  });

  it('after an automatic draw the drawn card is played (red); after a manual draw the timer passes', () => {
    const w = card('wild');
    const m = scenario({ rules: { kuCall: false }, hands: { 0: [num('mar', 1), num('mar', 2)] }, top: num('sol', 5), deck: [w] });
    const mv = timeoutMove(m, 0)!;
    expect(mv.kind).toBe('draw');
    const drawn = play(m, mv);
    expect(afterAutoDraw(drawn, 0)).toMatchObject({ kind: 'play', cardId: w.id, color: 'coral' });
    // the player drew by hand and let the time run out: pass, the card stays in the hand
    expect(timeoutMove(drawn, 0)).toEqual({ kind: 'pass', seat: 0 });
  });
});
