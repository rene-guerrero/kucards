/** Phase 4: power cards, penalty response windows, the Cyclone deck, challenge and partner extras. */
import { describe, expect, it } from 'vitest';
import type { GameEvent, MatchState, Move, Seat } from '../contracts';
import { applyMove, buildDeck, cardCount, cardPoints, closeWindow, DEFAULT_RULES, giveOptions, isLegal, isWildKind, legalMoves, RULE_PRESETS, RULE_SETTINGS, visibleHands } from '.';
import { card, num, scenario } from './testutil';

const types = (ev: GameEvent[]) => ev.map((e) => e.type);
const play = (m: MatchState, move: Move) => applyMove(m, move);
const kinds = (m: MatchState, seat?: Seat) => legalMoves(m, seat).map((x) => x.kind);
const deck = (n = 20) => Array.from({ length: n }, () => num('coral', 9));

describe('cyclone deck', () => {
  it('adds +6 and 2 Sweep per colour (no skipAll) and 6 +10, 6 wild +4, no wildColor; the preset uses it', () => {
    const rules = RULE_PRESETS.find((p) => p.id === 'cyclone')!.rules;
    expect(rules.deck).toBe('cyclone');
    const d = buildDeck(rules);
    expect(d).toHaveLength(128);
    expect(d.map((c) => c.id)).toEqual(d.map((_, i) => i));
    const count = (k: string) => d.filter((c) => c.face.kind === k).length;
    expect([count('skipAll'), count('sweep'), count('draw6'), count('draw10'), count('wildColor'), count('wild4')]).toEqual([0, 8, 4, 6, 0, 6]);
    expect(d.find((c) => c.face.kind === 'draw6')!.face.draw).toBe(6);
    expect(d.find((c) => c.face.kind === 'draw10')!.face).toMatchObject({ color: null, draw: 10 });
    expect(buildDeck(DEFAULT_RULES).some((c) => c.face.kind === 'draw6')).toBe(false);
  });

  it('scores and classifies the new cards', () => {
    expect(cardPoints({ kind: 'skipAll', color: 'sol' })).toBe(20);
    expect(cardPoints({ kind: 'draw6', color: 'sol', draw: 6 })).toBe(20);
    expect(cardPoints({ kind: 'draw10', color: null, draw: 10 })).toBe(50);
    expect(cardPoints({ kind: 'wildColor', color: null })).toBe(50);
    expect(isWildKind('draw10') && isWildKind('wildColor') && isWildKind('swap')).toBe(true);
    expect(isWildKind('draw6')).toBe(false);
  });

  it('skipAll skips every other seat and the player plays again', () => {
    const sa = card('skipAll', 'sol');
    const m = scenario({ hands: { 0: [sa, num('mar', 1), num('mar', 2)] }, top: num('sol', 5) });
    const { match, events } = play(m, { kind: 'play', seat: 0, cardId: sa.id });
    expect(events.filter((e) => e.type === 'skip')).toEqual([1, 2, 3].map((seat) => ({ type: 'skip', seat })));
    expect(events.at(-1)).toEqual({ type: 'turn', seat: 0 });
    expect(match.round!.turn).toBe(0);
  });

  it('+6 and +10 are penalties; stacking any = equal or bigger, never lower', () => {
    const d2 = card('draw2', 'sol');
    const d6 = card('draw6', 'mar');
    const d10 = card('draw10');
    const small = card('draw2', 'palma');
    const m = scenario({ rules: { stacking: 'any' }, hands: { 0: [d2, num('mar', 1)], 1: [d6, num('coral', 1)], 2: [d10, small, num('sol', 3)], 3: [card('draw2', 'mar'), num('sol', 1)] }, top: num('sol', 5) });
    const a = play(m, { kind: 'play', seat: 0, cardId: d2.id }).match;
    const b = play(a, { kind: 'play', seat: 1, cardId: d6.id }).match;
    expect(b.round!.pendingDraw).toBe(8);
    const ids = legalMoves(b).filter((x) => x.kind === 'play').map((x) => (x as { cardId: number }).cardId);
    expect(new Set(ids)).toEqual(new Set([d10.id])); // a +2 does not go on a +6
    const c = play(b, { kind: 'play', seat: 2, cardId: d10.id, color: 'mar' }).match;
    expect(c.round!.pendingDraw).toBe(18);
    // no +2 on the wild +10, even of the chosen colour
    expect(legalMoves(c).some((x) => x.kind === 'play')).toBe(false);
    const r = play(c, { kind: 'acceptPenalty', seat: 3 }).match.round!;
    expect(r.hands[3]).toHaveLength(20);
    expect(r.turn).toBe(0);
  });

  it("stacking 'same' only takes the same kind", () => {
    const a = card('draw6', 'sol');
    const m = scenario({ rules: { stacking: 'same' }, hands: { 0: [a, num('mar', 1)], 1: [card('draw6', 'mar'), card('draw10'), card('draw2', 'sol')] }, top: num('sol', 5) });
    const r = play(m, { kind: 'play', seat: 0, cardId: a.id }).match;
    const plays = legalMoves(r).filter((x) => x.kind === 'play');
    expect(plays).toHaveLength(1);
    expect(r.round!.hands[1][0].id).toBe((plays[0] as { cardId: number }).cardId);
  });

  it('without stacking a +6 is drawn at once', () => {
    const d6 = card('draw6', 'sol');
    const m = scenario({ hands: { 0: [d6, num('mar', 1)], 1: [num('mar', 3)] }, top: num('sol', 5) });
    const r = play(m, { kind: 'play', seat: 0, cardId: d6.id }).match.round!;
    expect(r.hands[1]).toHaveLength(7);
    expect(r.turn).toBe(2);
  });

  it('wildColor: the next seat draws until the chosen colour and loses the turn; not stackable', () => {
    const wc = card('wildColor');
    const hit = num('palma', 4);
    const m = scenario({ hands: { 0: [wc, num('mar', 1)], 1: [num('mar', 3)] }, top: num('sol', 5), deck: [num('sol', 1), hit, card('wild'), num('mar', 2), num('coral', 2)] });
    const { match, events } = play(m, { kind: 'play', seat: 0, cardId: wc.id, color: 'palma' });
    const r = match.round!;
    expect(events).toContainEqual(expect.objectContaining({ type: 'draw', seat: 1, count: 4, reason: 'penalty' }));
    expect(r.hands[1].at(-1)).toBe(hit);
    expect(r.turn).toBe(2);
    expect(r.pendingDraw).toBe(0);
    // during a pending stack a wildColor cannot be played
    const w2 = card('wildColor');
    const d2 = card('draw2', 'sol');
    const s = scenario({ rules: { stacking: 'any' }, hands: { 0: [d2, num('mar', 1)], 1: [w2, num('mar', 3)] }, top: num('sol', 5) });
    expect(legalMoves(play(s, { kind: 'play', seat: 0, cardId: d2.id }).match).some((x) => x.kind === 'play')).toBe(false);
  });

  it('wildColor stops when nothing is left to draw', () => {
    const wc = card('wildColor');
    const m = scenario({ hands: { 0: [wc, num('mar', 1)], 1: [num('mar', 3)] }, top: num('sol', 5), deck: [num('coral', 1)], discardUnder: [num('coral', 2)] });
    const before = cardCount(m.round!);
    const { match, events } = play(m, { kind: 'play', seat: 0, cardId: wc.id, color: 'palma' });
    expect(types(events)).toContain('reshuffle');
    expect(match.round!.hands[1]).toHaveLength(4); // coral 1, then the reshuffled coral 2 and the old sol 5
    expect(cardCount(match.round!)).toBe(before);
    expect(match.round!.turn).toBe(2);
  });
});

describe('swap', () => {
  it('lists colour × target and swaps hands with the target', () => {
    const sw = card('swap');
    const theirs = [num('mar', 1), num('mar', 2), num('mar', 3), num('mar', 4)];
    const m = scenario({ hands: { 0: [sw, num('coral', 1), num('coral', 2)], 2: theirs }, top: num('sol', 5) });
    expect(legalMoves(m).filter((x) => x.kind === 'play' && x.cardId === sw.id)).toHaveLength(12);
    expect(isLegal(m, { kind: 'play', seat: 0, cardId: sw.id, color: 'mar' })).toBe(false);
    const { match, events } = play(m, { kind: 'play', seat: 0, cardId: sw.id, color: 'palma', target: 2 });
    expect(events).toContainEqual({ type: 'swapHands', a: 0, b: 2, cards: theirs });
    expect(match.round!.hands[0]).toEqual(theirs);
    expect(match.round!.hands[2]).toHaveLength(2);
    expect(match.round!.activeColor).toBe('palma');
    expect(match.round!.turn).toBe(1);
  });

  it('a seat left on one card after the swap is the one that must call ¡Ku!', () => {
    const sw = card('swap');
    const m = scenario({ hands: { 0: [sw, num('coral', 1)], 1: [num('mar', 1), num('mar', 2), num('mar', 3)] }, top: num('sol', 5) });
    const r = play(m, { kind: 'play', seat: 0, cardId: sw.id, color: 'mar', target: 1 }).match.round!;
    expect(r.window).toEqual({ reason: 'ku', seats: [0, 2, 3], victim: 1 });
  });
});

describe('sweep', () => {
  it('sends every other card of its colour under the sweep card', () => {
    const sw = card('sweep', 'mar');
    const a = num('mar', 1);
    const b = card('skip', 'mar');
    const keep = [num('sol', 2), card('wild')];
    const top = num('mar', 5);
    const m = scenario({ hands: { 0: [a, sw, keep[0], b, keep[1]] }, top });
    const { match, events } = play(m, { kind: 'play', seat: 0, cardId: sw.id });
    expect(types(events)).toEqual(['play', 'sweep', 'turn']);
    expect(events[1]).toEqual({ type: 'sweep', seat: 0, cardIds: [a.id, b.id] });
    const r = match.round!;
    expect(r.hands[0]).toEqual(keep);
    expect(r.discard).toEqual([top, a, b, sw]);
    expect(r.activeColor).toBe('mar');
    expect(r.turn).toBe(1);
  });

  it('emptying the hand wins the round', () => {
    const sw = card('sweep', 'sol');
    const m = scenario({ players: 2, rules: { target: 0 }, hands: { 0: [num('sol', 1), sw, num('sol', 9)], 2: [num('mar', 3)] }, top: num('mar', 5), activeColor: 'sol' });
    const { match, events } = play(m, { kind: 'play', seat: 0, cardId: sw.id });
    expect(types(events)).toEqual(['play', 'sweep', 'roundEnd', 'matchEnd']);
    expect(match.round!.over).toBe(true);
    expect(match.winner).toBe(0);
  });

  it('leaving one card: ¡Ku! with the play counts, otherwise a catch window opens', () => {
    const mk = () => {
      const sw = card('sweep', 'sol');
      return { sw, m: scenario({ hands: { 0: [num('sol', 1), sw, num('sol', 9), num('mar', 2)] }, top: num('sol', 5) }) };
    };
    const x = mk();
    const called = play(x.m, { kind: 'play', seat: 0, cardId: x.sw.id, ku: true });
    expect(called.events[0]).toEqual({ type: 'ku', seat: 0 });
    expect(called.match.round!.window).toBeNull();
    const y = mk();
    expect(play(y.m, { kind: 'play', seat: 0, cardId: y.sw.id }).match.round!.window).toMatchObject({ reason: 'ku', victim: 0 });
  });
});

describe('penalty response window', () => {
  const rules = { 'power.shield': true, 'power.mirror': true, kuCall: false };

  it('no shield or mirror: the penalty is drawn at once (no window)', () => {
    const d2 = card('draw2', 'sol');
    const m = scenario({ rules, hands: { 0: [d2, num('mar', 1)], 1: [num('mar', 3)] }, top: num('sol', 5) });
    const r = play(m, { kind: 'play', seat: 0, cardId: d2.id }).match.round!;
    expect(r.window).toBeNull();
    expect(r.hands[1]).toHaveLength(3);
  });

  it('only a playable +N: a window opens so the dialog can offer the stack, never the draw', () => {
    const d2 = card('draw2', 'sol');
    const stack = card('draw2', 'mar');
    const m = scenario({ rules: { ...rules, stacking: 'any' }, hands: { 0: [d2, num('mar', 1)], 1: [stack, num('mar', 3)] }, top: num('sol', 5) });
    const a = play(m, { kind: 'play', seat: 0, cardId: d2.id }).match;
    expect(a.round!.window).toEqual({ reason: 'penalty', seats: [1], victim: 1 });
    expect(a.round!.turn).toBe(1);
    expect(kinds(a)).toEqual(['play']); // no acceptPenalty while stacking is possible
  });

  it('shield: the victim discards it, draws nothing and keeps the turn', () => {
    const d2 = card('draw2', 'sol');
    const sh = card('shield', 'coral');
    const m = scenario({ rules, hands: { 0: [d2, num('mar', 1)], 1: [sh, num('mar', 3)] }, top: num('sol', 5) });
    const a = play(m, { kind: 'play', seat: 0, cardId: d2.id });
    const r = a.match.round!;
    expect(r.window).toEqual({ reason: 'penalty', seats: [1], victim: 1 });
    expect(r.turn).toBe(1);
    expect(r.pendingDraw).toBe(2);
    expect(r.pendingFrom).toBe(0);
    expect(legalMoves(a.match)).toEqual([{ kind: 'respond', seat: 1, cardId: sh.id }, { kind: 'acceptPenalty', seat: 1 }]);
    expect(legalMoves(a.match, 2)).toEqual([]);
    const b = play(a.match, { kind: 'respond', seat: 1, cardId: sh.id });
    expect(types(b.events)).toEqual(['shield', 'window']);
    const rb = b.match.round!;
    expect(rb.pendingDraw).toBe(0);
    expect(rb.window).toBeNull();
    expect(rb.turn).toBe(1);
    expect(rb.hands[1]).toHaveLength(1);
    expect(rb.discard.at(-1)).toBe(sh); // the shield is the new top card
    expect(rb.discard.at(-2)).toBe(d2);
    expect(rb.activeColor).toBe('coral'); // and it sets the colour in play
    expect(legalMoves(b.match).some((x) => x.kind === 'draw')).toBe(true); // a normal turn
  });

  it('closeWindow / acceptPenalty: the victim draws and loses the turn', () => {
    const d2 = card('draw2', 'sol');
    const m = scenario({ rules, hands: { 0: [d2, num('mar', 1)], 1: [card('mirror', 'coral'), num('mar', 3)] }, top: num('sol', 5) });
    const a = play(m, { kind: 'play', seat: 0, cardId: d2.id }).match;
    for (const r of [closeWindow(a).match.round!, play(a, { kind: 'acceptPenalty', seat: 1 }).match.round!]) {
      expect(r.hands[1]).toHaveLength(4);
      expect(r.window).toBeNull();
      expect(r.pendingDraw).toBe(0);
      expect(r.turn).toBe(2);
    }
  });

  it('mirror: the stack goes back to its player, the direction turns and play continues after the victim', () => {
    const d2 = card('draw2', 'sol');
    const mi = card('mirror', 'mar');
    const m = scenario({ rules, hands: { 0: [d2, num('mar', 1)], 1: [mi, num('mar', 3)], 2: [num('palma', 1)] }, top: num('sol', 5) });
    const a = play(m, { kind: 'play', seat: 0, cardId: d2.id }).match;
    const { match, events } = play(a, { kind: 'respond', seat: 1, cardId: mi.id });
    expect(events).toContainEqual(expect.objectContaining({ type: 'mirror', from: 1, to: 0, total: 2 }));
    expect(events).toContainEqual({ type: 'reverse', direction: -1 });
    const r = match.round!;
    expect(r.hands[0]).toHaveLength(3);
    expect(r.hands[1]).toHaveLength(1);
    expect(r.window).toBeNull();
    expect(r.pendingDraw).toBe(0);
    expect(r.direction).toBe(-1);
    expect(r.turn).toBe(0); // next after the original victim, in the new direction
    expect(r.discard.at(-1)).toBe(d2); // the mirror stays under the top card
    expect(r.discard.at(-2)).toBe(mi);
    expect(r.activeColor).toBe('sol'); // the top card and colour are unchanged
  });

  it('mirror chain: the bounced player may mirror back or stack, and each mirror turns the table', () => {
    const d2 = card('draw2', 'sol');
    const mi0 = card('mirror', 'palma');
    const mi1 = card('mirror', 'mar');
    const m = scenario({ rules: { ...rules, stacking: 'any' }, hands: { 0: [d2, mi0, card('draw2', 'mar'), num('mar', 1)], 1: [mi1, num('mar', 3)], 2: [num('palma', 1)] }, top: num('sol', 5) });
    const a = play(m, { kind: 'play', seat: 0, cardId: d2.id }).match;
    const b = play(a, { kind: 'respond', seat: 1, cardId: mi1.id });
    expect(b.match.round!.window).toEqual({ reason: 'penalty', seats: [0], victim: 0 });
    expect(b.match.round!.turn).toBe(0);
    expect(b.match.round!.direction).toBe(-1);
    expect(b.match.round!.pendingFrom).toBe(1);
    expect(kinds(b.match)).toEqual(['play', 'respond']); // stack the +2 or mirror back, never draw
    const c = play(b.match, { kind: 'respond', seat: 0, cardId: mi0.id });
    expect(c.events).toContainEqual(expect.objectContaining({ type: 'mirror', from: 0, to: 1, total: 2 }));
    expect(c.events).toContainEqual({ type: 'reverse', direction: 1 });
    const r = c.match.round!;
    expect(r.hands[1]).toHaveLength(3); // no response left: drawn at once
    expect(r.direction).toBe(1);
    expect(r.turn).toBe(2); // play resumes after the original victim
  });

  it('the bounced player may stack a +N instead of drawing, keeping the reversed direction', () => {
    const d2 = card('draw2', 'sol');
    const mi = card('mirror', 'mar');
    const stack = card('draw2', 'coral');
    const m = scenario({ players: 3, rules: { ...rules, stacking: 'any' }, hands: { 0: [d2, stack, num('mar', 1)], 1: [mi, num('mar', 3)], 2: [num('palma', 1)] }, top: num('sol', 5) });
    const a = play(m, { kind: 'play', seat: 0, cardId: d2.id }).match;
    const b = play(a, { kind: 'respond', seat: 1, cardId: mi.id });
    expect(b.match.round!.window).toEqual({ reason: 'penalty', seats: [0], victim: 0 });
    expect(b.match.round!.direction).toBe(-1);
    expect(kinds(b.match)).toEqual(['play']); // only the stack: no shield, no mirror, no draw
    const c = play(b.match, { kind: 'play', seat: 0, cardId: stack.id });
    expect(c.match.round!.pendingDraw).toBe(4);
    expect(c.match.round!.pendingFrom).toBe(0);
    expect(c.match.round!.turn).toBe(3); // 3-player seats are 0/1/3: next after the stacker, reversed
    expect(c.match.round!.direction).toBe(-1);
    expect(c.match.round!.window).toBeNull();
  });

  it('a shield ending a mirrored penalty also resumes after the original victim in the new direction', () => {
    const d2 = card('draw2', 'sol');
    const sh = card('shield', 'palma');
    const mi = card('mirror', 'mar');
    const m = scenario({ rules, hands: { 0: [d2, sh, num('mar', 1)], 1: [mi, num('mar', 3)] }, top: num('sol', 5) });
    const a = play(m, { kind: 'play', seat: 0, cardId: d2.id }).match;
    const b = play(a, { kind: 'respond', seat: 1, cardId: mi.id }).match;
    expect(b.round!.direction).toBe(-1);
    const r = play(b, { kind: 'respond', seat: 0, cardId: sh.id }).match.round!;
    expect(r.hands[0]).toHaveLength(1);
    expect(r.pendingDraw).toBe(0);
    expect(r.turn).toBe(0);
  });

  it('with stacking the victim may also stack, which moves the window on', () => {
    const d2 = card('draw2', 'sol');
    const d2b = card('draw2', 'mar');
    const sh = card('shield', 'coral');
    const m = scenario({ rules: { ...rules, stacking: 'same' }, hands: { 0: [d2, num('mar', 1)], 1: [sh, d2b, num('mar', 3)], 2: [num('palma', 1), num('palma', 2)] }, top: num('sol', 5) });
    const a = play(m, { kind: 'play', seat: 0, cardId: d2.id }).match;
    expect(kinds(a)).toEqual(['play', 'respond']); // stacking is mandatory: no accept
    const b = play(a, { kind: 'play', seat: 1, cardId: d2b.id });
    expect(b.match.round!.window).toBeNull();
    expect(b.match.round!.turn).toBe(2);
    expect(b.match.round!.pendingDraw).toBe(4);
  });

  it('a shield that empties the hand wins the round', () => {
    const d2 = card('draw2', 'sol');
    const sh = card('shield', 'coral');
    const m = scenario({ players: 2, rules: { ...rules, target: 0 }, hands: { 0: [d2, num('mar', 1)], 2: [sh] }, top: num('sol', 5) });
    const a = play(m, { kind: 'play', seat: 0, cardId: d2.id }).match;
    const { match } = play(a, { kind: 'respond', seat: 2, cardId: sh.id });
    expect(match.round!.over).toBe(true);
    expect(match.winner).toBe(2);
  });

  it('a mirror that empties the hand wins after the bounced stack is drawn', () => {
    const d2 = card('draw2', 'sol');
    const mi = card('mirror', 'coral');
    const m = scenario({ players: 2, rules: { ...rules, target: 0 }, hands: { 0: [d2, num('mar', 1)], 2: [mi] }, top: num('sol', 5) });
    const a = play(m, { kind: 'play', seat: 0, cardId: d2.id }).match;
    const { match, events } = play(a, { kind: 'respond', seat: 2, cardId: mi.id });
    expect(match.winner).toBe(2);
    expect(events.find((e) => e.type === 'roundEnd')).toEqual({ type: 'roundEnd', winner: 2, points: [0, 0, 19, 0, 0, 0] });
  });

  for (const seating of ['across', 'side'] as const) {
    it(`partnerShield (${seating}): the victim's partner may shield it`, () => {
      const d2 = card('draw2', 'sol');
      const sh = card('shield', 'mar');
      const partner: Seat = seating === 'across' ? 0 : 3; // seat 2's partner
      const hands: Partial<Record<Seat, ReturnType<typeof num>[]>> = { 0: [num('palma', 1), num('palma', 2)], 1: [d2, num('mar', 1)], 2: [num('mar', 3)], 3: [num('coral', 1), num('coral', 2)] };
      hands[partner] = [sh, ...hands[partner]!];
      const on = scenario({ seating, rules: { ...rules, partnerShield: true }, hands, top: num('sol', 5), turn: 1 });
      const off = scenario({ seating, rules, hands, top: num('sol', 5), turn: 1 });
      expect(play(off, { kind: 'play', seat: 1, cardId: d2.id }).match.round!.window).toBeNull();
      const a = play(on, { kind: 'play', seat: 1, cardId: d2.id }).match;
      expect(a.round!.window).toEqual({ reason: 'penalty', seats: [partner], victim: 2 });
      expect(a.round!.turn).toBe(2);
      expect(legalMoves(a, 2)).toEqual([{ kind: 'acceptPenalty', seat: 2 }]);
      expect(legalMoves(a, partner)).toContainEqual({ kind: 'respond', seat: partner, cardId: sh.id });
      const b = play(a, { kind: 'respond', seat: partner, cardId: sh.id });
      expect(b.events).toContainEqual(expect.objectContaining({ type: 'shield', seat: partner }));
      expect(b.match.round!.turn).toBe(2);
      expect(b.match.round!.hands[2]).toHaveLength(1);
      expect(closeWindow(a).match.round!.hands[2]).toHaveLength(3);
    });
  }

  it('partnerShield: not against a penalty the partner played itself (side by side)', () => {
    const d2 = card('draw2', 'sol');
    const m = scenario({ seating: 'side', rules: { ...rules, partnerShield: true }, hands: { 0: [d2, card('shield', 'mar'), num('mar', 1)], 1: [num('mar', 3)] }, top: num('sol', 5) });
    const r = play(m, { kind: 'play', seat: 0, cardId: d2.id }).match.round!;
    expect(r.window).toBeNull();
    expect(r.pendingDraw).toBe(2); // Codo a codo always stacks: seat 1 must stack or accept
  });

  it('a partner may not answer with a mirror', () => {
    const d2 = card('draw2', 'sol');
    const m = scenario({ seating: 'across', rules: { ...rules, partnerShield: true }, hands: { 0: [d2, num('mar', 1)], 1: [num('mar', 3)], 3: [card('mirror', 'mar'), num('coral', 1)] }, top: num('sol', 5) });
    expect(play(m, { kind: 'play', seat: 0, cardId: d2.id }).match.round!.window).toBeNull();
  });
});

describe('wild4Challenge', () => {
  const setup = (holdsColor: boolean, extra: Record<string, unknown> = {}) => {
    const w4 = card('wild4');
    const m = scenario({
      rules: { wild4Challenge: true, kuCall: false, ...extra },
      hands: { 0: [w4, holdsColor ? num('sol', 1) : num('mar', 1), num('coral', 4)], 1: [num('mar', 3)] },
      top: num('sol', 5),
    });
    return play(m, { kind: 'play', seat: 0, cardId: w4.id, color: 'palma' }).match;
  };

  it('the victim may challenge instead of drawing at once', () => {
    const a = setup(true);
    expect(a.round!.turn).toBe(1);
    expect(a.round!.pendingDraw).toBe(4);
    expect(kinds(a)).toEqual(['challenge', 'acceptPenalty']);
    expect(play(a, { kind: 'acceptPenalty', seat: 1 }).match.round!.hands[1]).toHaveLength(5);
  });

  it('held the old colour: the player draws the penalty and the victim keeps the turn', () => {
    const r = play(setup(true), { kind: 'challenge', seat: 1 }).match.round!;
    expect(r.hands[0]).toHaveLength(6);
    expect(r.hands[1]).toHaveLength(1);
    expect(r.turn).toBe(1);
    expect(r.pendingDraw).toBe(0);
    expect(r.activeColor).toBe('palma');
  });

  it('a fair +4: the challenger draws penalty + 2 and loses the turn', () => {
    const { match, events } = play(setup(false), { kind: 'challenge', seat: 1 });
    expect(events).toContainEqual(expect.objectContaining({ type: 'draw', seat: 1, count: 6, reason: 'penalty' }));
    expect(match.round!.hands[0]).toHaveLength(2);
    expect(match.round!.turn).toBe(2);
  });

  it('also applies to +10, not to +2; always on', () => {
    const d10 = card('draw10');
    const m = scenario({ rules: { wild4Challenge: true }, hands: { 0: [d10, num('mar', 1)], 1: [num('mar', 3)] }, top: num('sol', 5) });
    const a = play(m, { kind: 'play', seat: 0, cardId: d10.id, color: 'sol' }).match;
    expect(kinds(a)).toContain('challenge');
    const d2 = card('draw2', 'sol');
    const m2 = scenario({ rules: { wild4Challenge: true }, hands: { 0: [d2, num('mar', 1)], 1: [num('mar', 3)] }, top: num('sol', 5) });
    expect(play(m2, { kind: 'play', seat: 0, cardId: d2.id }).match.round!.hands[1]).toHaveLength(3);
    const w4 = card('wild4');
    const m3 = scenario({ hands: { 0: [w4, num('mar', 1)], 1: [num('mar', 3)] }, top: num('sol', 5) });
    expect(play(m3, { kind: 'play', seat: 0, cardId: w4.id, color: 'sol' }).match.round!.pendingDraw).toBe(4);
  });

  it('with stacking the challenge is offered next to accepting', () => {
    const a = setup(true, { stacking: 'any' });
    expect(kinds(a)).toEqual(['challenge', 'acceptPenalty']);
  });

  for (const mode of ['classic', 'sideBySide'] as const) {
    it(`${mode}: a +4 stacked on a pending penalty cannot be challenged`, () => {
      const w4 = card('wild4');
      // seat 0 holds a sol card (an "illegal" +4 if it were played alone), but it lands on a pending +2
      const m = scenario({ mode, rules: { stacking: 'any', kuCall: false }, hands: { 0: [w4, num('sol', 1), num('coral', 4)], 1: [num('mar', 3)], 2: [num('mar', 4)], 3: [num('mar', 6)] }, top: card('draw2', 'sol'), pendingDraw: 2 });
      const a = play(m, { kind: 'play', seat: 0, cardId: w4.id, color: 'palma' }).match;
      expect(a.round!.pendingDraw).toBe(6);
      expect(legalMoves(a, a.round!.turn).some((x) => x.kind === 'challenge')).toBe(false);
      expect(legalMoves(a, a.round!.turn).some((x) => x.kind === 'acceptPenalty')).toBe(true);
    });
  }
});

describe('partners extras', () => {
  it('partnerPass: a 7 may carry one card to the partner', () => {
    const seven = num('sol', 7);
    const gift = card('wild');
    const m = scenario({ seating: 'across', rules: { partnerPass: true, kuCall: false }, hands: { 0: [seven, gift, num('mar', 1)], 2: [num('coral', 1)] }, top: num('sol', 5) });
    const mv: Move = { kind: 'play', seat: 0, cardId: seven.id, give: gift.id };
    expect(giveOptions(m, mv)).toHaveLength(2);
    expect(isLegal(m, mv)).toBe(true);
    expect(isLegal(m, { ...mv, give: seven.id })).toBe(false);
    expect(isLegal(m, { ...mv, give: 999999 })).toBe(false);
    const { match, events } = play(m, mv);
    expect(types(events)).toEqual(['play', 'draw', 'turn']);
    expect(events[1]).toEqual({ type: 'draw', seat: 2, count: 1, cards: [gift], reason: 'turn' });
    expect(match.round!.hands[0]).toHaveLength(1);
    expect(match.round!.hands[2].at(-1)).toBe(gift);
    expect(cardCount(match.round!)).toBe(cardCount(m.round!));
  });

  it('partnerPass needs partners, the rule, no 7-0, and a card left to keep', () => {
    const seven = num('sol', 7);
    const other = num('mar', 1);
    const hands = { 0: [seven, other, num('mar', 2)] };
    const mv: Move = { kind: 'play', seat: 0, cardId: seven.id, give: other.id };
    expect(isLegal(scenario({ rules: { partnerPass: true }, hands, top: num('sol', 5) }), mv)).toBe(false);
    expect(isLegal(scenario({ seating: 'across', hands, top: num('sol', 5) }), mv)).toBe(false);
    const sz = scenario({ seating: 'across', rules: { partnerPass: true, sevenZero: true }, hands, top: num('sol', 5) });
    expect(isLegal(sz, { ...mv, target: 1 })).toBe(false);
    expect(isLegal(sz, { kind: 'play', seat: 0, cardId: seven.id, target: 1 })).toBe(true);
    const two = scenario({ seating: 'across', rules: { partnerPass: true }, hands: { 0: [seven, other] }, top: num('sol', 5) });
    expect(isLegal(two, mv)).toBe(false);
    const n = num('sol', 3);
    expect(isLegal(scenario({ seating: 'across', rules: { partnerPass: true }, hands: { 0: [n, other, seven] }, top: num('sol', 5) }), { kind: 'play', seat: 0, cardId: n.id, give: other.id })).toBe(false);
  });

  it('partnerPass: giving down to one card follows the ¡Ku! rules', () => {
    const seven = num('sol', 7);
    const gift = num('mar', 1);
    const m = scenario({ seating: 'across', rules: { partnerPass: true }, hands: { 0: [seven, gift, num('mar', 2)], 2: [num('coral', 1), num('coral', 2)] }, top: num('sol', 5) });
    expect(play(m, { kind: 'play', seat: 0, cardId: seven.id, give: gift.id }).match.round!.window).toMatchObject({ reason: 'ku', victim: 0 });
    expect(play(m, { kind: 'play', seat: 0, cardId: seven.id, give: gift.id, ku: true }).match.round!.window).toBeNull();
  });

  it('visibleHands: own seat, plus the partner with partnerOpen', () => {
    const across = scenario({ seating: 'across', hands: {}, top: num('sol', 5) });
    expect(visibleHands(across, 0)).toEqual([0, 2]);
    expect(visibleHands(across, 3)).toEqual([3, 1]);
    const side = scenario({ seating: 'side', hands: {}, top: num('sol', 5) });
    expect(visibleHands(side, 0)).toEqual([0, 1]);
    expect(visibleHands(scenario({ seating: 'across', rules: { partnerOpen: false }, hands: {}, top: num('sol', 5) }), 0)).toEqual([0]);
    expect(visibleHands(scenario({ hands: {}, top: num('sol', 5) }), 1)).toEqual([1]);
  });

  it('Escudo / Espejo / partnerShield are retired: no rule toggle', () => {
    for (const k of ['partnerShield', 'power.shield', 'power.mirror']) expect(RULE_SETTINGS.find((d) => d.key === k)).toBeUndefined();
  });
});

describe('phase 4 contract fields', () => {
  it('a jumped-in 7 under 7-0 lists one jumpIn per target and swaps with it', () => {
    const top = num('sol', 7);
    const twin = num('sol', 7);
    const theirs = [num('mar', 1)];
    const m = scenario({ rules: { jumpIn: true, sevenZero: true }, hands: { 0: [num('mar', 9)], 1: theirs, 2: [twin, num('coral', 3), num('coral', 4)], 3: [num('mar', 4)] }, top });
    const jumps = legalMoves(m, 2).filter((x) => x.kind === 'jumpIn');
    expect(jumps.map((x) => (x as { target?: Seat }).target)).toEqual([0, 1, 3]);
    const { match, events } = play(m, { kind: 'jumpIn', seat: 2, cardId: twin.id, target: 1 });
    expect(events).toContainEqual(expect.objectContaining({ type: 'swapHands', a: 2, b: 1 }));
    expect(match.round!.hands[2]).toEqual(theirs);
    expect(match.round!.turn).toBe(3);
  });

  it('drawnCardId marks the drawn card; only it may be played', () => {
    const drawn = num('sol', 2);
    const m = scenario({ hands: { 0: [num('sol', 1), num('mar', 1)] }, top: num('sol', 5), deck: [drawn] });
    const a = play(m, { kind: 'draw', seat: 0 }).match;
    expect(a.round!.drawnCardId).toBe(drawn.id);
    expect(legalMoves(a).filter((x) => x.kind === 'play')).toEqual([{ kind: 'play', seat: 0, cardId: drawn.id }]);
    // even when the drawn card is no longer the last one in the hand
    const moved = { ...a, round: { ...a.round!, hands: a.round!.hands.map((h, i) => (i === 0 ? [drawn, ...h.filter((c) => c !== drawn)] : h)) } };
    expect(legalMoves(moved).filter((x) => x.kind === 'play')).toEqual([{ kind: 'play', seat: 0, cardId: drawn.id }]);
    expect(play(a, { kind: 'pass', seat: 0 }).match.round!.drawnCardId).toBeNull();
  });

  it('outPoints lives on the round', () => {
    const d2 = card('draw2', 'sol');
    const big = Array.from({ length: 24 }, () => num('mar', 1));
    const m = scenario({ players: 3, rules: { eliminateAt: 25 }, hands: { 0: [d2, num('coral', 1), num('coral', 2)], 1: big, 3: [num('palma', 1)] }, top: num('sol', 5) });
    const r = play(m, { kind: 'play', seat: 0, cardId: d2.id }).match.round!;
    expect(r.outPoints).toEqual([0, 42, 0, 0, 0, 0]);
  });
});
