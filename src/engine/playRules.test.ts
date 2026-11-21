/**
 * Optional rules numberFinish ("win with numbers only") and multiPlay ("play same numbers together").
 */
import { describe, expect, it } from 'vitest';
import type { GameEvent, MatchState, Move, Seat } from '../contracts';
import { applyMove, chooseMove, closeWindow, giveOptions, isLegal, legalMoves, multiPlayOptions } from '.';
import { card, num, scenario } from './testutil';

const NF = { numberFinish: true };
const MP = { multiPlay: true };
const plays = (m: MatchState, seat?: Seat) => legalMoves(m, seat).filter((x): x is Extract<Move, { kind: 'play' }> => x.kind === 'play');
const playIds = (m: MatchState, seat?: Seat) => [...new Set(plays(m, seat).map((x) => x.cardId))];
const types = (ev: GameEvent[]) => ev.map((e) => e.type);

describe('numberFinish: win with numbers only', () => {
  it('a last power card cannot be played: the player draws and the turn moves on', () => {
    const sk = card('skip', 'sol');
    const m = scenario({ rules: NF, hands: { 0: [sk], 1: [num('mar', 1)] }, top: num('sol', 5), deck: [num('coral', 2)] });
    expect(playIds(m)).toEqual([]);
    expect(legalMoves(m).map((x) => x.kind)).toEqual(['draw']);
    expect(() => applyMove(m, { kind: 'play', seat: 0, cardId: sk.id })).toThrow(/illegal/);
    const { match } = applyMove(m, { kind: 'draw', seat: 0 });
    expect(match.round!.turn).toBe(1);
    expect(match.round!.hands[0]).toHaveLength(2);
    // with two cards the power card is playable again
    const m2 = scenario({ rules: NF, hands: { 0: [sk, num('coral', 2)], 1: [num('mar', 1)] }, top: num('sol', 5) });
    expect(playIds(m2)).toEqual([sk.id]);
  });

  it('without the rule a last power card wins as before', () => {
    const sk = card('skip', 'sol');
    const m = scenario({ hands: { 0: [sk], 1: [num('mar', 1)] }, top: num('sol', 5) });
    expect(applyMove(m, { kind: 'play', seat: 0, cardId: sk.id }).match.round!.over).toBe(true);
  });

  it('a last number card still wins; a last wild never does', () => {
    const n = num('sol', 3);
    const m = scenario({ rules: NF, hands: { 0: [n], 1: [num('mar', 1)] }, top: num('sol', 5) });
    const { match, events } = applyMove(m, { kind: 'play', seat: 0, cardId: n.id });
    expect(match.round!.over).toBe(true);
    expect(events.find((e) => e.type === 'roundEnd')).toMatchObject({ winner: 0 });
    const w = scenario({ rules: NF, hands: { 0: [card('wild')], 1: [num('mar', 1)] }, top: num('sol', 5) });
    expect(playIds(w)).toEqual([]);
  });

  it('a sweep that would discard the rest of the hand is illegal, one that leaves a card is fine', () => {
    const sw = card('sweep', 'sol');
    const all = scenario({ rules: NF, hands: { 0: [sw, num('sol', 1), num('sol', 8)], 1: [num('mar', 1)] }, top: num('sol', 5) });
    expect(playIds(all)).not.toContain(sw.id);
    const some = scenario({ rules: NF, hands: { 0: [sw, num('sol', 1), num('mar', 8)], 1: [num('mar', 1)] }, top: num('sol', 5) });
    expect(playIds(some)).toContain(sw.id);
    const { match } = applyMove(some, { kind: 'play', seat: 0, cardId: sw.id, ku: true });
    expect(match.round!.hands[0]).toHaveLength(1);
    expect(match.round!.over).toBe(false);
  });

  it('a wild sweep: only the colours that leave a card are offered', () => {
    const sw = card('sweepWild');
    const m = scenario({ rules: NF, hands: { 0: [sw, num('mar', 1), num('mar', 8)], 1: [num('mar', 1)] }, top: num('sol', 5) });
    const colors = plays(m).filter((x) => x.cardId === sw.id).map((x) => x.color);
    expect(colors).not.toContain('mar');
    expect(colors).toContain('sol');
  });

  it('a last penalty card cannot be stacked: the victim accepts', () => {
    const d2 = card('draw2', 'mar');
    const m = scenario({ rules: { ...NF, stacking: 'any' }, hands: { 0: [d2], 1: [num('mar', 1)] }, top: card('draw2', 'sol'), pendingDraw: 2 });
    expect(legalMoves(m).map((x) => x.kind)).toEqual(['acceptPenalty']);
    // closeWindow-free: accepting draws the stack
    expect(applyMove(m, { kind: 'acceptPenalty', seat: 0 }).match.round!.hands[0]).toHaveLength(3);
  });

  it('no jump-in with a last special card; a last number may jump in and win', () => {
    const top = card('skip', 'sol');
    const m = scenario({ rules: { ...NF, jumpIn: true }, hands: { 0: [num('mar', 3), num('mar', 4)], 1: [card('skip', 'sol')] }, top });
    expect(legalMoves(m, 1).filter((x) => x.kind === 'jumpIn')).toEqual([]);
    const t2 = num('sol', 5);
    const m2 = scenario({ rules: { ...NF, jumpIn: true }, hands: { 0: [num('mar', 3), num('mar', 4)], 1: [num('sol', 5)] }, top: t2 });
    const j = legalMoves(m2, 1).find((x) => x.kind === 'jumpIn')!;
    expect(applyMove(m2, j).match.round!.over).toBe(true);
  });

  it('a round where nobody can go out and nothing can be drawn ends blocked', () => {
    // two players, each holding one matching power card; deck and pile empty
    const m = scenario({ rules: NF, players: 2, hands: { 0: [card('skip', 'sol')], 2: [card('reverse', 'sol')] }, top: num('sol', 5), deck: [] });
    expect(legalMoves(m).map((x) => x.kind)).toEqual(['draw']);
    const { match, events } = applyMove(m, { kind: 'draw', seat: 0 });
    expect(match.round!.over).toBe(true);
    expect(types(events)).toContain('roundEnd');
  });

  it('time-up still ends a round with the rule on', async () => {
    const { timeUp } = await import('./game');
    const m = scenario({ rules: NF, hands: { 0: [card('skip', 'sol')], 1: [num('mar', 1), num('mar', 2)] }, top: num('sol', 5) });
    expect(timeUp(m).match.round!.over).toBe(true);
  });

  it('CPUs never try to go out on a special card', () => {
    for (const level of ['easy', 'normal', 'hard', 'master'] as const) {
      const m = scenario({ rules: NF, hands: { 0: [card('wild4')], 1: [num('mar', 1)] }, top: num('sol', 5) });
      const mv = chooseMove(m, 0, level)!;
      expect(mv.kind).toBe('draw');
      expect(isLegal(m, mv)).toBe(true);
    }
  });
});

describe('numberFinish: jump-in', () => {
  it('a jumped-in sweep that would sweep the last cards away is not offered', () => {
    const sw = card('sweep', 'sol');
    const m = scenario({ rules: { ...NF, jumpIn: true, 'power.sweep': true }, hands: { 0: [num('mar', 1), num('mar', 2)], 1: [sw, num('sol', 1)] }, top: card('sweep', 'sol') });
    expect(legalMoves(m, 1).some((x) => x.kind === 'jumpIn')).toBe(false);
    const off = scenario({ rules: { jumpIn: true, 'power.sweep': true }, hands: { 0: [num('mar', 1), num('mar', 2)], 1: [sw, num('sol', 1)] }, top: card('sweep', 'sol') });
    expect(legalMoves(off, 1).some((x) => x.kind === 'jumpIn')).toBe(true);
  });
});

describe('multiPlay: play same numbers together', () => {
  const sevens = () => ({ a: num('sol', 7), b: num('mar', 7), c: num('palma', 7) });

  it('multiPlayOptions lists the other cards of the number; legalMoves keeps single plays', () => {
    const { a, b, c } = sevens();
    const x = num('mar', 2);
    const m = scenario({ rules: MP, hands: { 0: [a, b, c, x, card('skip', 'sol')], 1: [num('mar', 1)] }, top: num('coral', 7) });
    expect(multiPlayOptions(m, { kind: 'play', seat: 0, cardId: a.id }).sort()).toEqual([b.id, c.id].sort());
    expect(plays(m).every((p) => p.extra === undefined)).toBe(true);
    expect(playIds(m).sort()).toEqual([a.id, b.id, c.id].sort());
    // rule off: nothing joins
    const off = scenario({ hands: { 0: [a, b, c, x], 1: [num('mar', 1)] }, top: num('coral', 7) });
    expect(multiPlayOptions(off, { kind: 'play', seat: 0, cardId: a.id })).toEqual([]);
    expect(isLegal(off, { kind: 'play', seat: 0, cardId: a.id, extra: [b.id] })).toBe(false);
  });

  it('plays the cards in order in one turn: the last sets the colour, the turn advances once', () => {
    const { a, b, c } = sevens();
    const m = scenario({ rules: MP, hands: { 0: [a, b, c, num('mar', 2), num('sol', 1)], 1: [num('mar', 1)] }, top: num('coral', 7) });
    const { match, events } = applyMove(m, { kind: 'play', seat: 0, cardId: b.id, extra: [c.id, a.id] });
    expect(types(events)).toEqual(['play', 'play', 'play', 'turn']);
    expect(events.slice(0, 3).map((e) => (e as { card: { id: number } }).card.id)).toEqual([b.id, c.id, a.id]);
    expect(events.slice(0, 3).map((e) => (e as { more?: boolean }).more)).toEqual([true, true, undefined]);
    const r = match.round!;
    expect(r.discard.slice(-3)).toEqual([b, c, a]);
    expect(r.activeColor).toBe('sol');
    expect(r.turn).toBe(1);
    expect(r.hands[0]).toHaveLength(2);
  });

  it('the first card may match by colour; the others need not be playable on their own', () => {
    const red7 = num('coral', 7);
    const blue7 = num('mar', 7);
    const m = scenario({ rules: MP, hands: { 0: [red7, blue7, num('sol', 1)], 1: [num('mar', 1)] }, top: num('coral', 4) });
    expect(playIds(m)).toEqual([red7.id]);
    expect(isLegal(m, { kind: 'play', seat: 0, cardId: red7.id, extra: [blue7.id] })).toBe(true);
    expect(isLegal(m, { kind: 'play', seat: 0, cardId: blue7.id, extra: [red7.id] })).toBe(false);
    expect(applyMove(m, { kind: 'play', seat: 0, cardId: red7.id, extra: [blue7.id] }).match.round!.activeColor).toBe('mar');
  });

  it('rejects bad extras', () => {
    const { a, b } = sevens();
    const n8 = num('mar', 8);
    const sk = card('skip', 'coral');
    const other = num('palma', 7); // not in the hand
    const m = scenario({ rules: MP, hands: { 0: [a, b, n8, sk], 1: [num('mar', 1), other] }, top: num('coral', 7) });
    const mv = (extra: number[]) => ({ kind: 'play' as const, seat: 0 as Seat, cardId: a.id, extra });
    expect(isLegal(m, mv([b.id]))).toBe(true);
    expect(isLegal(m, mv([n8.id]))).toBe(false); // another number
    expect(isLegal(m, mv([sk.id]))).toBe(false); // not a number
    expect(isLegal(m, mv([b.id, b.id]))).toBe(false); // twice
    expect(isLegal(m, mv([a.id]))).toBe(false); // the first card again
    expect(isLegal(m, mv([other.id]))).toBe(false); // not in the hand
    expect(isLegal(m, mv([]))).toBe(true); // empty list = a single play
    expect(() => applyMove(m, mv([n8.id]))).toThrow(/illegal/);
  });

  it('only on a plain turn: not after drawing, not as a penalty answer, not out of turn', () => {
    const { a, b } = sevens();
    const m = scenario({ rules: MP, hands: { 0: [num('mar', 1), num('mar', 2)], 1: [a, b] }, top: num('coral', 7), deck: [num('palma', 9)] });
    // seat 1 is not on turn
    expect(multiPlayOptions(m, { kind: 'play', seat: 1, cardId: a.id })).toEqual([]);
    // after a draw that brought a playable card
    const d7 = num('coral', 7);
    const m2 = scenario({ rules: MP, hands: { 0: [b, num('mar', 2)], 1: [num('mar', 1)] }, top: num('coral', 3), deck: [d7] });
    const drawn = applyMove(m2, { kind: 'draw', seat: 0 }).match;
    expect(drawn.round!.drewThisTurn).toBe(true);
    expect(multiPlayOptions(drawn, { kind: 'play', seat: 0, cardId: d7.id })).toEqual([]);
    expect(isLegal(drawn, { kind: 'play', seat: 0, cardId: d7.id, extra: [b.id] })).toBe(false);
    // a pending penalty
    const m3 = scenario({ rules: { ...MP, stacking: 'any' }, hands: { 0: [card('draw2', 'mar'), num('mar', 7), num('sol', 7)], 1: [num('mar', 1)] }, top: card('draw2', 'sol'), pendingDraw: 2 });
    for (const p of plays(m3)) expect(multiPlayOptions(m3, p)).toEqual([]);
  });

  it('¡Ku!: the play may carry ku for the final hand size; a missed call opens the catch window', () => {
    const { a, b, c } = sevens();
    const last = num('mar', 2);
    const base = () => scenario({ rules: MP, hands: { 0: [a, b, c, last], 1: [num('mar', 1), num('mar', 3)] }, top: num('coral', 7) });
    // callKu is offered with 4 cards because one play could leave one
    expect(legalMoves(base()).some((x) => x.kind === 'callKu')).toBe(true);
    const called = applyMove(base(), { kind: 'play', seat: 0, cardId: a.id, extra: [b.id, c.id], ku: true });
    expect(types(called.events)).toEqual(['ku', 'play', 'play', 'play', 'turn']);
    expect(called.match.round!.window).toBeNull();
    const missed = applyMove(base(), { kind: 'play', seat: 0, cardId: a.id, extra: [b.id, c.id] });
    expect(missed.match.round!.window).toMatchObject({ reason: 'ku', victim: 0 });
    // called first (a separate callKu move), then the multi-play: the flag survives the 4-card hand
    const pre = applyMove(base(), { kind: 'callKu', seat: 0 }).match;
    expect(pre.round!.kuCalled[0]).toBe(true);
    const after = applyMove(pre, { kind: 'play', seat: 0, cardId: a.id, extra: [b.id, c.id] }).match;
    expect(after.round!.window).toBeNull();
    expect(after.round!.kuCalled[0]).toBe(true);
    // called early, then a single play that leaves three: the call is gone
    const single = applyMove(pre, { kind: 'play', seat: 0, cardId: a.id }).match;
    expect(single.round!.kuCalled[0]).toBe(false);
    // a ku flag on a multi-play that still leaves two cards is ignored
    const five = scenario({ rules: MP, hands: { 0: [a, b, num('mar', 2), num('sol', 1)], 1: [num('mar', 1)] }, top: num('coral', 7) });
    const two = applyMove(five, { kind: 'play', seat: 0, cardId: a.id, extra: [b.id], ku: true });
    expect(types(two.events)).not.toContain('ku');
  });

  it('a multi-play that empties the hand wins; with numberFinish too (all numbers)', () => {
    const { a, b } = sevens();
    const m = scenario({ rules: { ...MP, ...NF }, hands: { 0: [a, b], 1: [num('mar', 1)] }, top: num('coral', 7) });
    const { match, events } = applyMove(m, { kind: 'play', seat: 0, cardId: a.id, extra: [b.id] });
    expect(match.round!.over).toBe(true);
    expect(events.find((e) => e.type === 'roundEnd')).toMatchObject({ winner: 0 });
  });

  it('partnerPass: a gift cannot be one of the extras, and the giver keeps a card', () => {
    const { a, b, c } = sevens();
    const x = num('mar', 2);
    const m = scenario({ rules: { ...MP, partnerPass: true }, seating: 'across', hands: { 0: [a, b, c, x], 1: [num('mar', 1)], 2: [num('sol', 4)], 3: [num('sol', 1)] }, top: num('coral', 7) });
    expect(giveOptions(m, { kind: 'play', seat: 0, cardId: a.id, extra: [b.id] })).toEqual([c.id, x.id]);
    expect(giveOptions(m, { kind: 'play', seat: 0, cardId: a.id, extra: [b.id, c.id] })).toEqual([]);
    expect(isLegal(m, { kind: 'play', seat: 0, cardId: a.id, extra: [b.id], give: b.id })).toBe(false);
    expect(isLegal(m, { kind: 'play', seat: 0, cardId: a.id, extra: [b.id], give: x.id })).toBe(true);
  });

  it('7-0: several 7s still swap hands once', () => {
    const { a, b } = sevens();
    const m = scenario({ rules: { ...MP, sevenZero: true }, hands: { 0: [a, b, num('mar', 2)], 1: [num('mar', 1), num('mar', 3), num('sol', 3)] }, top: num('coral', 7) });
    const { match, events } = applyMove(m, { kind: 'play', seat: 0, cardId: a.id, target: 1, extra: [b.id] });
    expect(types(events).filter((t) => t === 'swapHands')).toHaveLength(1);
    expect(match.round!.hands[0]).toHaveLength(3);
    expect(match.round!.hands[1]).toHaveLength(1);
  });

  it('CPUs play their same numbers together, the colour they keep most of last', () => {
    const { a, b, c } = sevens();
    // after the 7s: two mar cards left, so mar should end on top
    const hand = [a, b, c, num('mar', 2), num('mar', 4), num('sol', 9)];
    let multi = 0;
    for (const level of ['normal', 'hard', 'master'] as const) {
      const m = scenario({ rules: MP, hands: { 0: hand.slice(), 1: [num('coral', 1), num('coral', 2), num('coral', 3)] }, top: num('coral', 7) });
      const mv = chooseMove(m, 0, level)!;
      expect(isLegal(m, mv)).toBe(true);
      if (mv.kind !== 'play') continue;
      const ids = [mv.cardId, ...(mv.extra ?? [])];
      if (!ids.includes(a.id)) continue; // chose another card altogether
      expect([...ids].sort()).toEqual([a.id, b.id, c.id].sort());
      expect((mv.extra ?? []).at(-1)).toBe(b.id);
      multi++;
    }
    expect(multi).toBeGreaterThan(0);
  });

  it('closeWindow after a multi-play ¡Ku! slip moves on', () => {
    const { a, b } = sevens();
    const m = scenario({ rules: MP, hands: { 0: [a, b, num('mar', 2)], 1: [num('mar', 1)] }, top: num('coral', 7) });
    const res = applyMove(m, { kind: 'play', seat: 0, cardId: a.id, extra: [b.id] }).match;
    expect(res.round!.window?.reason).toBe('ku');
    expect(closeWindow(res).match.round!.window).toBeNull();
  });
});
