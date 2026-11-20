import { describe, expect, it } from 'vitest';
import type { Card, MatchState, Seat } from '../contracts';
import { DEFAULT_CLOCK, FINAL_MS, fitThink, moveMs, sanitizeClock } from './clock';
import { createMatch, startRound, timeUp, timeUpWinner } from './game';
import { DEFAULT_RULES } from './rules';

const num = (id: number, value: number): Card => ({ id, face: { kind: 'number', color: 'mar', value } }) as Card;

/** a live round with the given hands (seat → card values) */
function withHands(mode: 'classic' | 'partners', hands: Partial<Record<Seat, number[]>>, turn: Seat = 0): MatchState {
  let m = createMatch({ ...DEFAULT_RULES, target: 500 }, { mode: 'classic', players: 4, teams: mode === 'partners' }, 3);
  m = startRound(m).match;
  let id = 1000;
  const h = m.round!.hands.map((_, s) => (hands[s as Seat] ?? []).map((v) => num(id++, v)));
  return { ...m, round: { ...m.round!, hands: h, turn } };
}

describe('round clock: settings', () => {
  it('clamps to min / max and snaps to the offered steps', () => {
    expect(sanitizeClock(null)).toEqual(DEFAULT_CLOCK);
    expect(sanitizeClock({ roundMin: 99, moveSec: 1, finalSec: 100 })).toEqual({ roundMin: 10, moveSec: 10, finalSec: 15 });
    expect(sanitizeClock({ roundMin: -4, moveSec: 999, finalSec: 0 })).toEqual({ roundMin: 0, moveSec: 60, finalSec: 4 });
    expect(sanitizeClock({ roundMin: 4, moveSec: 31, finalSec: 7 })).toEqual({ roundMin: 3, moveSec: 30, finalSec: 6 });
    expect(sanitizeClock({ roundMin: '5', moveSec: NaN })).toEqual({ roundMin: 0, moveSec: 30, finalSec: 8 });
  });

  it('switches to the final-minute move time in the last minute only', () => {
    const c = { roundMin: 3, moveSec: 30, finalSec: 8 };
    expect(moveMs(c, null)).toBe(30_000);
    expect(moveMs(c, FINAL_MS + 1)).toBe(30_000);
    expect(moveMs(c, FINAL_MS)).toBe(8_000);
    expect(moveMs(c, 0)).toBe(8_000);
    expect(moveMs({ ...c, roundMin: 0 }, 10)).toBe(30_000); // no round limit: never the final minute
    // CPU think time fits inside even the shortest move time
    expect(fitThink(1500, { ...c, finalSec: 4 }, 1000)).toBeLessThan(4000);
  });
});

describe('round clock: time-up verdict', () => {
  it('the fewest card points in hand wins and scores the others', () => {
    const m = withHands('classic', { 0: [9, 9], 1: [1, 2], 2: [5], 3: [7, 7, 7] });
    const { match, events } = timeUp(m);
    expect(match.round!.over).toBe(true);
    expect(match.round!.endedBy).toBe('time');
    const end = events.find((e) => e.type === 'roundEnd');
    expect(end).toMatchObject({ type: 'roundEnd', winner: 1, byTime: true });
    expect(match.scores[1]).toBe(18 + 5 + 21);
  });

  it('ties: fewer cards, then the seat that would play soonest from the one on turn', () => {
    const fewer = withHands('classic', { 0: [2, 2], 1: [4], 2: [9], 3: [9] });
    expect(timeUpWinner(fewer, fewer.round!)).toBe(1);
    const tie = withHands('classic', { 0: [4], 1: [9], 2: [4], 3: [4] }, 2);
    expect(timeUpWinner(tie, tie.round!)).toBe(2);
    const tie2 = withHands('classic', { 0: [4], 1: [9], 2: [9], 3: [4] }, 1);
    expect(timeUpWinner(tie2, tie2.round!)).toBe(3);
  });

  it('Parejas: the team with the lower combined points wins', () => {
    // teams across: [0,2] vs [1,3]; seat 1 alone is lowest but its team sums higher
    const m = withHands('partners', { 0: [5], 2: [5], 1: [1], 3: [9, 9] });
    const { match, events } = timeUp(m);
    const end = events.find((e) => e.type === 'roundEnd') as { winner: Seat };
    expect([0, 2]).toContain(end.winner);
    expect(match.scores[0]).toBe(19);
    expect(match.scores[2]).toBe(19);
    expect(match.scores[1]).toBe(0);
  });

  it('does nothing once the round is over', () => {
    const m = timeUp(withHands('classic', { 0: [1], 1: [2], 2: [3], 3: [4] })).match;
    expect(timeUp(m).events).toEqual([]);
  });
});
