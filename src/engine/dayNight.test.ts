import { describe, expect, it } from 'vitest';
import type { Card, CardFace, Color, MatchState, Move } from '../contracts';
import { COLORS, NIGHT_COLORS } from '../contracts';
import { applyMove, buildDeck, cardPoints, chooseMove, createMatch, legalMoves, RULE_PRESETS, startRound } from '.';
import { dayFaces, dayNightPairing, nightFaces, NIGHT_DRAW } from './cards';
import { cardCount } from './game';
import { scenario } from './testutil';

const rules = RULE_PRESETS.find((p) => p.id === 'dayNight')!.rules;
let nextId = 5000;
/** a two-sided test card */
const dn = (face: CardFace, other: CardFace): Card => ({ id: nextId++, face, other });
const n = (color: Color, value: number): CardFace => ({ kind: 'number', color, value });
const flipOf = (color: Color): CardFace => ({ kind: 'flip', color });

/** a Día y Noche match mid-round */
function dnScenario(hands: Record<number, Card[]>, top: Card, extra: Partial<Parameters<typeof scenario>[0]> = {}): MatchState {
  const deck = Array.from({ length: 10 }, (_, i) => dn(n('mar', i % 10), n('celeste', (i + 3) % 10)));
  return scenario({ rules, mode: 'dayNight', players: 2, hands, top, deck, ...extra });
}

describe('Día y Noche deck', () => {
  it('112 two-sided cards: the day side and the night side, every face used once', () => {
    const d = buildDeck(rules);
    expect(d).toHaveLength(112);
    expect(d.every((c) => !!c.other)).toBe(true);
    const key = (f: CardFace) => `${f.kind}:${f.color}:${f.value ?? ''}:${f.draw ?? ''}`;
    expect(d.map((c) => key(c.face)).sort()).toEqual(dayFaces().map(key).sort());
    expect(d.map((c) => key(c.other!)).sort()).toEqual(nightFaces().map(key).sort());
    expect(d.every((c) => !c.face.color || COLORS.includes(c.face.color as never))).toBe(true);
    expect(d.every((c) => !c.other!.color || NIGHT_COLORS.includes(c.other!.color as never))).toBe(true);
    // the night side: +5, Salto total, Comodín +6, 4 Eclipses per side
    expect(d.filter((c) => c.other!.kind === 'draw6' && c.other!.draw === NIGHT_DRAW)).toHaveLength(8);
    expect(d.filter((c) => c.other!.kind === 'skip')).toHaveLength(8);
    expect(d.filter((c) => c.other!.kind === 'wild4' && c.other!.draw === 6)).toHaveLength(4);
    expect(d.filter((c) => c.other!.kind === 'wildColor')).toHaveLength(0);
    expect(d.filter((c) => c.face.kind === 'flip')).toHaveLength(4);
    expect(d.filter((c) => c.other!.kind === 'flip')).toHaveLength(4);
  });

  it('pairing: a permutation, never special (wild / Eclipse) on both sides, colours spread out', () => {
    const p = dayNightPairing();
    expect([...p].sort((a, b) => a - b)).toEqual(p.map((_, i) => i));
    const d = buildDeck(rules);
    const special = (f: CardFace) => f.color === null || f.kind === 'flip';
    expect(d.filter((c) => special(c.face) && special(c.other!))).toHaveLength(0);
    // every day colour sits behind at least three different night colours
    for (const c of COLORS) expect(new Set(d.filter((x) => x.face.color === c).map((x) => x.other!.color)).size).toBeGreaterThanOrEqual(3);
  });

  it('night cards score more: +5 and Salto total 30', () => {
    expect(cardPoints({ kind: 'draw6', color: 'rosa', draw: 5 })).toBe(30);
    expect(cardPoints({ kind: 'skipAll', color: 'morado' })).toBe(30);
    expect(cardPoints({ kind: 'flip', color: 'sol' })).toBe(20);
    expect(cardPoints({ kind: 'draw6', color: 'mar', draw: 6 })).toBe(20);
  });

  it('a round starts on the day side; the deal shows everybody the backs', () => {
    const m = createMatch(rules, { mode: 'dayNight', players: 3 }, 11);
    expect(m.rules.stacking).toBe('any');
    const { match, events } = startRound(m);
    expect(match.round!.side).toBe('light');
    const deal = events[0] as Extract<(typeof events)[number], { type: 'deal' }>;
    expect(deal.backs![1]).toEqual(match.round!.hands[1].map((c) => c.other));
    expect(deal.deckBack).toEqual(match.round!.deck.at(-1)!.other);
  });
});

describe('Día y Noche: the Eclipse', () => {
  it('turns every card over: hands, deck and pile; the side and the colour change', () => {
    const eclipse = dn(flipOf('sol'), n('rosa', 4));
    const mine = dn(n('mar', 2), n('naranja', 7));
    const theirs = dn(n('palma', 5), { kind: 'skipAll', color: 'celeste' });
    const m = dnScenario({ 0: [eclipse, mine], 2: [theirs] }, dn(n('sol', 3), n('morado', 1)));
    const deckBefore = m.round!.deck.map((c) => c.id);
    const { match, events } = applyMove(m, { kind: 'play', seat: 0, cardId: eclipse.id });
    const r = match.round!;
    expect(r.side).toBe('dark');
    expect(r.discard.at(-1)!.face).toEqual(n('rosa', 4));
    expect(r.activeColor).toBe('rosa');
    expect(r.hands[0][0].face).toEqual(n('naranja', 7));
    expect(r.hands[0][0].other).toEqual(n('mar', 2));
    expect(r.hands[2][0].face.kind).toBe('skipAll');
    expect(r.deck.map((c) => c.id)).toEqual(deckBefore);
    expect(r.deck.every((c) => NIGHT_COLORS.includes(c.face.color as never))).toBe(true);
    expect(cardCount(r)).toBe(cardCount(m.round!));
    const flip = events.find((e) => e.type === 'flip') as Extract<(typeof events)[number], { type: 'flip' }>;
    expect(flip.side).toBe('dark');
    expect(flip.color).toBe('rosa');
    expect(flip.backs![2]).toEqual([n('palma', 5)]);
    expect(flip.hand!.map((c) => c.id)).toEqual([mine.id]);
    expect(r.turn).toBe(2);
  });

  it('a wild turned up keeps the colour slot of the other side; a second Eclipse goes back to day', () => {
    const e1 = dn(flipOf('coral'), { kind: 'wild', color: null, night: true });
    const e2 = dn(n('sol', 8), flipOf('naranja'));
    const m = dnScenario({ 0: [e1, dn(n('mar', 1), n('celeste', 1))], 2: [e2, dn(n('palma', 1), n('rosa', 1))] }, dn(n('coral', 3), n('naranja', 3)));
    let x = applyMove(m, { kind: 'play', seat: 0, cardId: e1.id }).match;
    expect(x.round!.activeColor).toBe('morado'); // coral ↔ morado
    // seat 2 now holds the night Eclipse (naranja) and may not play it on morado / wild… unless it fits:
    // a wild was turned up with morado active, so only morado or an Eclipse match by kind
    expect(legalMoves(x, 2).some((mv) => mv.kind === 'play' && mv.cardId === e2.id)).toBe(false);
    x = { ...x, round: { ...x.round!, activeColor: 'naranja' } };
    x = applyMove(x, { kind: 'play', seat: 2, cardId: e2.id }).match;
    expect(x.round!.side).toBe('light');
    expect(x.round!.discard.at(-1)!.face).toEqual(n('sol', 8));
    expect(x.round!.activeColor).toBe('sol');
  });

  it('wild colour choices are the night colours on the night side', () => {
    const wild = dn({ kind: 'wildColor', color: null, night: true }, n('sol', 1));
    const top = dn(n('rosa', 2), n('mar', 2));
    const m = dnScenario({ 0: [wild, dn(n('rosa', 5), n('sol', 5))], 2: [dn(n('naranja', 1), n('mar', 9))] }, top);
    const night: MatchState = { ...m, round: { ...m.round!, side: 'dark', activeColor: 'rosa' } };
    const colors = legalMoves(night, 0).filter((mv): mv is Extract<Move, { kind: 'play' }> => mv.kind === 'play' && mv.cardId === wild.id).map((mv) => mv.color);
    expect(colors.sort()).toEqual([...NIGHT_COLORS].sort());
  });

  it('the night +5 stacks and makes the victim draw 5', () => {
    const p5 = dn({ kind: 'draw6', color: 'rosa', draw: 5 }, n('sol', 1));
    const m0 = dnScenario({ 0: [p5, dn(n('rosa', 5), n('sol', 5))], 2: [dn(n('naranja', 1), n('mar', 9)), dn(n('celeste', 1), n('mar', 8))] }, dn(n('rosa', 2), n('mar', 2)));
    const m: MatchState = { ...m0, round: { ...m0.round!, side: 'dark', activeColor: 'rosa' } };
    let x = applyMove(m, { kind: 'play', seat: 0, cardId: p5.id }).match;
    expect(x.round!.pendingDraw).toBe(5);
    x = applyMove(x, { kind: 'acceptPenalty', seat: 2 }).match;
    expect(x.round!.hands[2]).toHaveLength(7);
  });
});

describe('Día y Noche CPU', () => {
  it('flips when its other side is much stronger and the opponents get weak cards', () => {
    const eclipse = dn(flipOf('sol'), n('naranja', 4));
    // my hand: plain day numbers backed by night wilds and +5s
    const mine = [
      dn(n('mar', 9), { kind: 'wildColor', color: null, night: true }),
      dn(n('palma', 8), { kind: 'draw6', color: 'naranja', draw: 5 }),
      dn(n('coral', 7), { kind: 'wild', color: null, night: true }),
    ];
    const sol5 = dn(n('sol', 5), n('celeste', 2));
    // the opponent's backs (what it would hold at night): plain numbers
    const theirs = [dn({ kind: 'wild4', color: null, draw: 4 }, n('celeste', 0)), dn({ kind: 'wild', color: null }, n('rosa', 1))];
    const m = dnScenario({ 0: [eclipse, sol5, ...mine], 2: theirs }, dn(n('sol', 3), n('morado', 1)));
    const mv = chooseMove(m, 0, 'normal');
    expect(mv).toMatchObject({ kind: 'play', cardId: eclipse.id });
  });

  it('keeps the Eclipse when flipping would arm the opponent', () => {
    const eclipse = dn(flipOf('sol'), n('naranja', 4));
    const sol5 = dn(n('sol', 5), n('celeste', 2));
    const theirs = [dn(n('mar', 1), { kind: 'wildColor', color: null, night: true }), dn(n('mar', 2), { kind: 'draw6', color: 'naranja', draw: 5 })];
    const m = dnScenario({ 0: [eclipse, sol5, dn(n('palma', 1), n('rosa', 1)), dn(n('mar', 3), n('celeste', 3))], 2: theirs }, dn(n('sol', 3), n('morado', 1)));
    const mv = chooseMove(m, 0, 'normal');
    expect(mv).toMatchObject({ kind: 'play', cardId: sol5.id });
  });
});
