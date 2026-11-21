import { describe, expect, it } from 'vitest';
import type { MatchState } from '../../src/contracts';
import { createMatch, legalMoves, startRound } from '../../src/engine/game';
import { RULE_PRESETS } from '../../src/engine/rules';
import { card, num, scenario } from '../../src/engine/testutil';
import { tunables } from '../src/config';
import { cpuTurnMove, isTurnMove, reactDelay, thinkDelay, validMove } from '../../src/net/room/game';
import { clearGameTimer, emptySchedule, nextAlarm, setGameTimer, setTimer, takeDue } from '../../src/net/room/schedule';

describe('schedule', () => {
  it('alarm = earliest of game, window, grace and idle', () => {
    const s = emptySchedule();
    expect(nextAlarm(s)).toBeNull();
    setGameTimer(s, 'turn', 500, '1:0:human');
    setTimer(s, 'win', 'window', 400, 'w');
    s.grace.a = 300;
    s.idle = 10_000;
    expect(nextAlarm(s)).toBe(300);
    delete s.grace.a;
    expect(nextAlarm(s)).toBe(400);
    s.win = null;
    expect(nextAlarm(s)).toBe(500);
    clearGameTimer(s);
    expect(nextAlarm(s)).toBe(10_000);
  });

  it('takeDue removes only what is due', () => {
    const s = emptySchedule();
    setGameTimer(s, 'cpu', 100, '3:1:cpu');
    setTimer(s, 'win', 'react', 130, 'x:react');
    s.grace.a = 50;
    s.grace.b = 200;
    const d = takeDue(s, 120);
    expect(d.game?.kind).toBe('cpu');
    expect(d.win).toBeNull();
    expect(d.grace).toEqual(['a']);
    expect(s.win?.kind).toBe('react');
    expect(nextAlarm(s)).toBe(130);
  });

  it('the same situation keeps its running clock; a new one replaces it', () => {
    const s = emptySchedule();
    expect(setGameTimer(s, 'turn', 30_000, '4:2:human').changed).toBe(true);
    const again = setGameTimer(s, 'turn', 45_000, '4:2:human');
    expect(again.changed).toBe(false);
    expect(again.timer.at).toBe(30_000);
    expect(setGameTimer(s, 'cpu', 31_000, '4:2:cover').changed).toBe(true);
  });
});

describe('tunables', () => {
  it('defaults from the protocol, test overrides via vars', () => {
    const d = tunables({});
    expect(d.turnTimeoutMs).toBe(30_000);
    expect(d.windowMs).toBe(2_500);
    const t = tunables({ KUCA_TURN_TIMEOUT_MS: '1500', KUCA_WINDOW_MS: '300', KUCA_CPU_SPEED: '0.05', KUCA_GRACE_MS: 'x' });
    expect(t.turnTimeoutMs).toBe(1500);
    expect(t.windowMs).toBe(300);
    expect(t.cpuSpeed).toBe(0.05);
    expect(t.graceMs).toBe(d.graceMs);
  });
});

describe('cpu and validation', () => {
  const fresh = (): MatchState => startRound(createMatch(RULE_PRESETS[0].rules, { mode: 'classic', players: 4 }, 42)).match;

  it('think and react delays scale with the speed', () => {
    expect(thinkDelay(1, 1, () => 0)).toBeLessThan(thinkDelay(5, 1, () => 0));
    expect(thinkDelay(3, 0.1, () => 0.5)).toBeLessThan(thinkDelay(3, 1, () => 0.5));
    expect(reactDelay(1, () => 1)).toBeLessThan(2500);
  });

  it('validMove only accepts a legal move of that seat (keeps ku, drops a bad give)', () => {
    const m = fresh();
    const seat = m.round!.turn;
    const legal = legalMoves(m, seat);
    const play = legal.find((x) => x.kind === 'play');
    expect(validMove(m, seat, { kind: 'draw', seat })).toEqual({ kind: 'draw', seat });
    expect(validMove(m, seat, { kind: 'draw', seat: (seat + 1) % 4 })).toBeNull();
    expect(validMove(m, seat, null)).toBeNull();
    expect(validMove(m, seat, { kind: 'play', seat, cardId: 9999 })).toBeNull();
    if (play) {
      const v = validMove(m, seat, { ...play, ku: true, give: 5, extra: 'x' })!;
      expect(v.kind).toBe('play');
      expect((v as { give?: number }).give).toBeUndefined();
      expect((v as { extra?: string }).extra).toBeUndefined();
    }
  });

  it('validMove checks multiPlay extras like the engine (rule, same number, in hand, no repeats)', () => {
    const a = num('sol', 7);
    const b = num('mar', 7);
    const c = num('palma', 7);
    const n8 = num('mar', 8);
    const m = scenario({ rules: { multiPlay: true }, hands: { 0: [a, b, c, n8], 1: [num('mar', 1)] }, top: num('coral', 7) });
    expect(validMove(m, 0, { kind: 'play', seat: 0, cardId: a.id, extra: [c.id, b.id], ku: true })).toEqual({ kind: 'play', seat: 0, cardId: a.id, extra: [c.id, b.id], ku: true });
    expect(validMove(m, 0, { kind: 'play', seat: 0, cardId: a.id, extra: [n8.id] })).toBeNull();
    expect(validMove(m, 0, { kind: 'play', seat: 0, cardId: a.id, extra: [b.id, b.id] })).toBeNull();
    expect(validMove(m, 0, { kind: 'play', seat: 0, cardId: a.id, extra: [9999] })).toBeNull();
    expect(validMove(m, 0, { kind: 'play', seat: 0, cardId: a.id, extra: [1.5] })).toBeNull();
    expect(validMove(m, 0, { kind: 'play', seat: 0, cardId: a.id, extra: [] })).toEqual({ kind: 'play', seat: 0, cardId: a.id });
    const off = scenario({ hands: { 0: [a, b], 1: [num('mar', 1)] }, top: num('coral', 7) });
    expect(validMove(off, 0, { kind: 'play', seat: 0, cardId: a.id, extra: [b.id] })).toBeNull();
    // numberFinish: a last special card is not a legal move for the room either
    const nf = scenario({ rules: { numberFinish: true }, hands: { 0: [card('skip', 'coral')], 1: [num('mar', 1)] }, top: num('coral', 7) });
    expect(validMove(nf, 0, { kind: 'play', seat: 0, cardId: nf.round!.hands[0][0].id })).toBeNull();
  });

  it('validMove checks multiDraw2 / multiSkip extras like the engine (one kind, rule on, numberFinish)', () => {
    const d1 = card('draw2', 'coral');
    const d2 = card('draw2', 'mar');
    const s1 = card('skip', 'sol');
    const s2 = card('skip', 'palma');
    const m = scenario({ rules: { multiDraw2: true, multiSkip: true }, hands: { 0: [d1, d2, s1, s2, num('mar', 3)], 1: [num('mar', 1)] }, top: card('draw2', 'sol') });
    expect(validMove(m, 0, { kind: 'play', seat: 0, cardId: d1.id, extra: [d2.id] })).toEqual({ kind: 'play', seat: 0, cardId: d1.id, extra: [d2.id] });
    expect(validMove(m, 0, { kind: 'play', seat: 0, cardId: d1.id, extra: [s1.id] })).toBeNull(); // mixed kinds
    const sk = scenario({ rules: { multiSkip: true }, hands: { 0: [s1, s2, num('mar', 3)], 1: [num('mar', 1)] }, top: num('sol', 4) });
    expect(validMove(sk, 0, { kind: 'play', seat: 0, cardId: s1.id, extra: [s2.id] })).toEqual({ kind: 'play', seat: 0, cardId: s1.id, extra: [s2.id] });
    const off = scenario({ rules: { multiPlay: true }, hands: { 0: [s1, s2, num('mar', 3)], 1: [num('mar', 1)] }, top: num('sol', 4) });
    expect(validMove(off, 0, { kind: 'play', seat: 0, cardId: s1.id, extra: [s2.id] })).toBeNull();
    // numberFinish: two skips may not be the last cards out
    const nf = scenario({ rules: { multiSkip: true, numberFinish: true }, hands: { 0: [s1, s2], 1: [num('mar', 1)] }, top: num('sol', 4) });
    expect(validMove(nf, 0, { kind: 'play', seat: 0, cardId: s1.id, extra: [s2.id] })).toBeNull();
    expect(validMove(nf, 0, { kind: 'play', seat: 0, cardId: s1.id })).toEqual({ kind: 'play', seat: 0, cardId: s1.id });
  });

  it('cpuTurnMove always returns a legal turn move', () => {
    const m = fresh();
    const seat = m.round!.turn;
    for (const level of ['easy', 'normal', 'hard', 'master'] as const) {
      const mv = cpuTurnMove(m, seat, level)!;
      expect(isTurnMove(mv)).toBe(true);
      expect(validMove(m, seat, mv)).not.toBeNull();
    }
  });
});
