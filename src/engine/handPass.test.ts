/** Comodín Rueda (wheelWild), the sevenSwap and zeroPass rules, their badges and the old sevenZero key */
import { describe, expect, it } from 'vitest';
import type { Card, GameEvent, MatchState, Move, Seat } from '../contracts';
import { applyMove, chooseMove, legalMoves, RULE_PRESETS, RULE_SETTINGS } from '.';
import { COLOURLESS_KINDS, sanitizeModeDef, upgradeLegacyRules } from './modes';
import { buildDeck } from './cards';
import { card, num, scenario } from './testutil';
import { sanitizeRules } from '../app/settings';
import { normalizeRules } from '../net/room/lobby';
import { redactEvents, seatView, snapshotFor } from '../net/redact';
import { applyEvent, applySnapshot } from '../net/mirror';
import { faceKey } from '../render/cardAtlas';
import { BADGE_X, BADGE_Y, badgeIndex, faceBadge } from '../render/ruleBadges';
import { cardSvg } from '../ui/cardArt';

const ids = (cards: readonly Card[]) => cards.map((c) => c.id);
const plays = (m: MatchState, cardId: number) => legalMoves(m).filter((x): x is Extract<Move, { kind: 'play' }> => x.kind === 'play' && x.cardId === cardId);

describe('Comodín Rueda (wheelWild)', () => {
  it('is a colourless card the deck editor offers, and a wild the player picks the colour for', () => {
    expect(COLOURLESS_KINDS).toContain('wheelWild');
    const deck = buildDeck({ deck: 'classic' }, { numbers: { zero: 1, each: 2, minValue: 1 }, perColor: [], wild: [{ kind: 'wheelWild', n: 3 }] });
    expect(deck.filter((c) => c.face.kind === 'wheelWild')).toHaveLength(3);
    const wheel = card('wheelWild');
    const m = scenario({ hands: { 0: [wheel, num('mar', 2)] }, top: num('sol', 5) });
    expect(plays(m, wheel.id).map((p) => p.color)).toEqual(['sol', 'mar', 'palma', 'coral']);
  });

  it('passes every hand to the next player clockwise (direction 1) and sets the colour', () => {
    const wheel = card('wheelWild');
    const mine = [num('coral', 1), num('coral', 2)];
    const h1 = [num('mar', 1)];
    const h2 = [num('mar', 2), num('mar', 3), num('mar', 4)];
    const h3 = [num('palma', 3), num('palma', 4)];
    const m = scenario({ hands: { 0: [wheel, ...mine], 1: h1, 2: h2, 3: h3 }, top: num('sol', 5) });
    const { match, events } = applyMove(m, { kind: 'play', seat: 0, cardId: wheel.id, color: 'palma' });
    expect(events).toContainEqual(expect.objectContaining({ type: 'rotateHands', direction: 1 }));
    const r = match.round!;
    expect(r.activeColor).toBe('palma');
    expect(ids(r.hands[1])).toEqual(ids(mine));
    expect(ids(r.hands[2])).toEqual(ids(h1));
    expect(ids(r.hands[3])).toEqual(ids(h2));
    expect(ids(r.hands[0])).toEqual(ids(h3));
    expect(r.turn).toBe(1);
  });

  it('passes the other way when play runs counter-clockwise (direction -1)', () => {
    const wheel = card('wheelWild');
    const mine = [num('coral', 1), num('coral', 2)];
    const h1 = [num('mar', 1)];
    const h2 = [num('mar', 2), num('mar', 3), num('mar', 4)];
    const h3 = [num('palma', 3), num('palma', 4)];
    const m = scenario({ direction: -1, hands: { 0: [wheel, ...mine], 1: h1, 2: h2, 3: h3 }, top: num('sol', 5) });
    const { match, events } = applyMove(m, { kind: 'play', seat: 0, cardId: wheel.id, color: 'sol' });
    expect(events).toContainEqual(expect.objectContaining({ type: 'rotateHands', direction: -1 }));
    const r = match.round!;
    expect(ids(r.hands[3])).toEqual(ids(mine));
    expect(ids(r.hands[2])).toEqual(ids(h3));
    expect(ids(r.hands[1])).toEqual(ids(h2));
    expect(ids(r.hands[0])).toEqual(ids(h1));
    expect(r.turn).toBe(3);
  });

  it('the CPU plays it when the hand coming to it is smaller than its own', () => {
    const wheel = card('wheelWild');
    // seat 0 keeps 4 cards and seat 3 (the hand that comes to seat 0) holds 1; nothing else fits
    const m = scenario({ hands: { 0: [wheel, num('mar', 1), num('mar', 2), num('mar', 3), num('mar', 4)], 1: [num('coral', 1), num('coral', 2)], 2: [num('coral', 3), num('coral', 4)], 3: [num('coral', 6)] }, top: num('sol', 5) });
    expect(chooseMove(m, 0, 'normal')).toMatchObject({ kind: 'play', cardId: wheel.id });
  });
});

describe('sevenSwap rule', () => {
  it('a 7 lists one play per other player and swaps hands with the chosen one', () => {
    const seven = num('sol', 7);
    const theirs = [num('mar', 1)];
    const m = scenario({ rules: { sevenSwap: true }, hands: { 0: [seven, num('mar', 2), num('mar', 3)], 1: [num('coral', 1), num('coral', 2)], 2: theirs, 3: [num('palma', 1), num('palma', 2)] }, top: num('sol', 5) });
    expect(plays(m, seven.id).map((p) => p.target)).toEqual([1, 2, 3]);
    const { match, events } = applyMove(m, { kind: 'play', seat: 0, cardId: seven.id, target: 2 });
    expect(events).toContainEqual(expect.objectContaining({ type: 'swapHands', a: 0, b: 2 }));
    expect(ids(match.round!.hands[0])).toEqual(ids(theirs));
    expect(match.round!.hands[2]).toHaveLength(2);
    expect(match.round!.hands[1]).toHaveLength(2); // the others keep theirs
  });

  it('does not pass hands on a 0 (only zeroPass does)', () => {
    const zero = num('sol', 0);
    const m = scenario({ rules: { sevenSwap: true }, hands: { 0: [zero, num('mar', 2)], 1: [num('coral', 1)] }, top: num('sol', 5) });
    const { events } = applyMove(m, { kind: 'play', seat: 0, cardId: zero.id });
    expect(events.some((e) => e.type === 'rotateHands')).toBe(false);
  });

  it('the CPU picks the opponent with the fewest cards as its target', () => {
    const seven = num('sol', 7);
    const m = scenario({ rules: { sevenSwap: true }, hands: { 0: [seven, num('mar', 1), num('mar', 2), num('mar', 3)], 1: [num('coral', 1), num('coral', 2), num('coral', 3)], 2: [num('coral', 4)], 3: [num('coral', 5), num('coral', 6)] }, top: num('sol', 5) });
    for (const lv of ['easy', 'normal', 'hard'] as const) {
      const mv = chooseMove(m, 0, lv);
      if (mv && mv.kind === 'play' && mv.cardId === seven.id) expect(mv.target).toBeDefined();
    }
    expect(chooseMove(m, 0, 'normal')).toMatchObject({ kind: 'play', cardId: seven.id, target: 2 });
  });
});

describe('zeroPass rule', () => {
  it('a 0 passes every hand to the next player, no colour asked', () => {
    const zero = num('sol', 0);
    const h1 = [num('mar', 1)];
    const h2 = [num('mar', 2), num('mar', 3)];
    const h3 = [num('palma', 3), num('palma', 4), num('palma', 5)];
    const m = scenario({ rules: { zeroPass: true }, hands: { 0: [zero, num('coral', 1), num('coral', 2)], 1: h1, 2: h2, 3: h3 }, top: num('sol', 5) });
    expect(plays(m, zero.id)).toEqual([{ kind: 'play', seat: 0, cardId: zero.id }]);
    const { match, events } = applyMove(m, { kind: 'play', seat: 0, cardId: zero.id });
    expect(events).toContainEqual(expect.objectContaining({ type: 'rotateHands', direction: 1 }));
    const r = match.round!;
    expect(r.hands[1]).toHaveLength(2);
    expect(ids(r.hands[2])).toEqual(ids(h1));
    expect(ids(r.hands[3])).toEqual(ids(h2));
    expect(ids(r.hands[0])).toEqual(ids(h3));
  });

  it('a 7 asks for no target with only zeroPass on', () => {
    const seven = num('sol', 7);
    const m = scenario({ rules: { zeroPass: true }, hands: { 0: [seven, num('mar', 2)] }, top: num('sol', 5) });
    expect(plays(m, seven.id)).toEqual([{ kind: 'play', seat: 0, cardId: seven.id }]);
  });
});

describe('both rules off', () => {
  it('7s and 0s are plain numbers', () => {
    const seven = num('sol', 7);
    const zero = num('mar', 0);
    const hands = { 0: [seven, zero, num('coral', 2)], 1: [num('coral', 1), num('coral', 3)] };
    const m = scenario({ hands, top: num('sol', 5) });
    expect(plays(m, seven.id)).toEqual([{ kind: 'play', seat: 0, cardId: seven.id }]);
    const a = applyMove(m, { kind: 'play', seat: 0, cardId: seven.id });
    expect(a.events.some((e) => e.type === 'swapHands' || e.type === 'rotateHands')).toBe(false);
    const m2 = scenario({ hands, top: num('mar', 5) });
    const b = applyMove(m2, { kind: 'play', seat: 0, cardId: zero.id });
    expect(b.events.some((e) => e.type === 'swapHands' || e.type === 'rotateHands')).toBe(false);
    expect(b.match.round!.hands[1]).toHaveLength(2);
  });
});

describe('rule settings', () => {
  it('both toggles are listed with help text, default off, and on in Ciclón (the harshest preset)', () => {
    for (const key of ['sevenSwap', 'zeroPass']) {
      const d = RULE_SETTINGS.find((x) => x.key === key)!;
      expect(d).toMatchObject({ type: 'toggle', default: false });
      expect(d.help?.es && d.help.en).toBeTruthy();
    }
    expect(RULE_SETTINGS.some((x) => x.key === 'sevenZero')).toBe(false);
    const cyclone = RULE_PRESETS.find((p) => p.id === 'cyclone')!.rules;
    expect(cyclone).toMatchObject({ sevenSwap: true, zeroPass: true });
    expect(RULE_PRESETS.find((p) => p.id === 'classic')!.rules).toMatchObject({ sevenSwap: false, zeroPass: false });
  });

  it('the old combined sevenZero key turns both on (stored settings, room rules, player-made modes)', () => {
    expect(upgradeLegacyRules({ sevenZero: true })).toEqual({ sevenSwap: true, zeroPass: true });
    expect(upgradeLegacyRules({ sevenZero: true, zeroPass: false })).toEqual({ sevenSwap: true, zeroPass: false });
    expect(upgradeLegacyRules({ sevenZero: false })).toEqual({});
    expect(sanitizeRules({ sevenZero: true }, 'classic')).toMatchObject({ sevenSwap: true, zeroPass: true });
    expect(normalizeRules({ sevenZero: true }, 'classic')).toMatchObject({ sevenSwap: true, zeroPass: true });
    const def = sanitizeModeDef({ id: 'custom-a', rules: { sevenZero: true, jumpIn: true } });
    expect(def.rules).toEqual({ sevenSwap: true, zeroPass: true, jumpIn: true });
  });
});

describe('badges', () => {
  it('7s show the swap badge and 0s the pass badge only when their rule is on; the Comodín Rueda always', () => {
    const seven = { kind: 'number' as const, color: 'coral' as const, value: 7 };
    const zero = { kind: 'number' as const, color: 'mar' as const, value: 0 };
    expect(faceBadge(seven, { sevenSwap: true })).toBe('swap');
    expect(faceBadge(seven, { zeroPass: true })).toBeUndefined();
    expect(faceBadge(zero, { zeroPass: true })).toBe('pass');
    expect(faceBadge(zero, {})).toBeUndefined();
    expect(faceBadge({ kind: 'wheelWild' }, null)).toBe('pass');
    // the badge sits outside the face (the corner tab), so the atlas cell of a 7 stays the same
    expect(faceKey({ ...seven, badge: 'swap' })).toBe(faceKey(seven));
    expect([badgeIndex(undefined), badgeIndex('swap'), badgeIndex('pass')]).toEqual([0, 1, 2]);
    // it overhangs the card's top-left corner
    expect(BADGE_X).toBeLessThan(0);
    expect(BADGE_Y).toBeLessThan(0);
    // the DOM art draws the same badge (red / yellow rounded square), outside the card box
    const svg = cardSvg({ ...seven, badge: 'swap' });
    expect(svg).toContain('#d7262e');
    expect(svg).toContain('overflow="visible"');
    expect(cardSvg(seven)).not.toContain('#d7262e');
    expect(cardSvg(seven)).not.toContain('overflow');
    expect(cardSvg({ kind: 'wheelWild', color: null })).toContain('#ffd23a');
  });
});

describe('online', () => {
  it('after a 7 swap and a 0 pass every seat sees only its own hand; the mirror follows', () => {
    const seven = num('sol', 7);
    const zero = num('mar', 0);
    const m0 = scenario({ rules: { sevenSwap: true, zeroPass: true }, hands: { 0: [seven, num('palma', 2), num('palma', 3)], 1: [num('coral', 1), zero, num('coral', 3)], 2: [num('mar', 1)], 3: [num('sol', 1), num('sol', 2)] }, top: num('sol', 5) });
    const a = applyMove(m0, { kind: 'play', seat: 0, cardId: seven.id, target: 2 });
    // seat 1 plays its 0 next (the colour in play set to mar so it fits)
    const m1 = { ...a.match, round: { ...a.match.round!, activeColor: 'mar' as const } };
    const b = applyMove(m1, { kind: 'play', seat: 1, cardId: zero.id });
    const check = (events: GameEvent[], after: MatchState) => {
      for (const seat of after.seats) {
        const red = redactEvents(events, seat, after);
        for (const ev of red) {
          if (ev.type === 'swapHands') {
            if (ev.a === seat || ev.b === seat) expect(ids(ev.cards!)).toEqual(ids(after.round!.hands[seat]));
            else expect(ev.cards).toBeUndefined();
          }
          if (ev.type === 'rotateHands') expect(ids(ev.cards!)).toEqual(ids(after.round!.hands[seat]));
        }
        const v = seatView(after, seat, [], null, null);
        const r = (v.match as MatchState).round!;
        r.hands.forEach((h, s) => expect(h.length).toBe(s === seat ? after.round!.hands[s].length : 0));
        expect(v.handCounts).toEqual(after.round!.hands.map((h) => h.length));
      }
    };
    check(a.events, a.match);
    check(b.events, b.match);
    // a seat outside the swap never gets a face it should not see
    const outside = redactEvents(a.events, 3 as Seat, a.match);
    expect(JSON.stringify(outside)).not.toContain(`"id":${m0.round!.hands[2][0].id}`);
    // the mirror of seat 3 keeps the counts right and its own hand
    let mir = seatView(m0, 3, [], null, null).match as MatchState;
    for (const ev of redactEvents(a.events, 3, a.match)) mir = applyEvent(mir, ev);
    mir = applySnapshot(mir, snapshotFor(a.match, 3));
    expect(mir.round!.hands.map((h) => h.length)).toEqual(a.match.round!.hands.map((h) => h.length));
    expect(ids(mir.round!.hands[3])).toEqual(ids(a.match.round!.hands[3]));
  });
});
