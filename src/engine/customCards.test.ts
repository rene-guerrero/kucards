import { describe, expect, it } from 'vitest';
import type { Card, CardFace, CardKind, Color, MatchState, Move, Seat } from '../contracts';
import { COLORS, NIGHT_COLORS } from '../contracts';
import { applyMove, closeWindow, createMatch, legalMoves, startRound } from './game';
import { buildDeck, buildDeckFromSpec, buildTwoSidedDeck, matchDeck } from './cards';
import { BUILTIN_MODES, COLOURLESS_KINDS, DAY_SIDE_DECK, modeFromTemplate, NIGHT_SIDE_DECK, PER_COLOR_KINDS, sanitizeDeckSpec, sanitizeModeDef, type DeckSpec } from './modes';
import { RULE_PRESETS } from './rules';
import { Rng } from './rng';
import { chooseMove } from './ai';
import { card, num, scenario } from './testutil';

const dnRules = RULE_PRESETS.find((p) => p.id === 'dayNight')!.rules;

// ─────────── the Día y Noche deck as it was built before the deck lists (fixed composition) ───────────

function legacyDayNightDeck(): Card[] {
  const day: CardFace[] = [];
  for (const c of COLORS) {
    day.push({ kind: 'number', color: c, value: 0 });
    for (let v = 1; v <= 9; v++) day.push({ kind: 'number', color: c, value: v }, { kind: 'number', color: c, value: v });
    for (let i = 0; i < 2; i++) day.push({ kind: 'skip', color: c }, { kind: 'reverse', color: c }, { kind: 'draw2', color: c, draw: 2 });
    day.push({ kind: 'flip', color: c });
  }
  for (let i = 0; i < 4; i++) day.push({ kind: 'wild', color: null }, { kind: 'wild4', color: null, draw: 4 });
  const night: CardFace[] = [];
  for (const c of NIGHT_COLORS) {
    night.push({ kind: 'number', color: c, value: 0 });
    for (let v = 1; v <= 9; v++) night.push({ kind: 'number', color: c, value: v }, { kind: 'number', color: c, value: v });
    for (let i = 0; i < 2; i++) night.push({ kind: 'draw6', color: c, draw: 5 }, { kind: 'reverse', color: c }, { kind: 'skip', color: c });
    night.push({ kind: 'flip', color: c });
  }
  for (let i = 0; i < 4; i++) night.push({ kind: 'wild', color: null, night: true }, { kind: 'wild4', color: null, draw: 6, night: true });
  const special = (f: CardFace) => f.color === null || f.kind === 'flip';
  const rng = new Rng(0x6e0c7e);
  const p = night.map((_, i) => i);
  for (let i = p.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [p[i], p[j]] = [p[j], p[i]];
  }
  for (let i = 0; i < p.length; i++) {
    if (!(special(day[i]) && special(night[p[i]]))) continue;
    for (let k = 1; k < p.length; k++) {
      const j = (i + k * 7) % p.length;
      if (!special(day[j]) && !special(night[p[j]])) {
        [p[i], p[j]] = [p[j], p[i]];
        break;
      }
    }
  }
  return day.map((face, id) => ({ id, face, other: night[p[id]] }));
}

describe('configurable two-sided deck', () => {
  it('the default day and night lists rebuild the historical Día y Noche deck card for card', () => {
    const legacy = legacyDayNightDeck();
    expect(buildDeck(dnRules)).toStrictEqual(legacy);
    expect(buildTwoSidedDeck(DAY_SIDE_DECK, NIGHT_SIDE_DECK)).toStrictEqual(legacy);
    expect(buildDeck(dnRules, BUILTIN_MODES.dayNight.deck, BUILTIN_MODES.dayNight.night)).toStrictEqual(legacy);
    // a player-made copy of Día y Noche deals the very same deck
    const copy = modeFromTemplate(BUILTIN_MODES.dayNight, dnRules, 'custom-dn', 'Mi noche');
    expect(copy.night).toEqual(NIGHT_SIDE_DECK);
    const m = createMatch({}, { mode: 'dayNight', players: 3, custom: sanitizeModeDef(JSON.parse(JSON.stringify(copy))) }, 5);
    expect(matchDeck(m)).toStrictEqual(legacy);
  });

  it('a two-sided mode saved before the night list existed keeps the fixed Día y Noche deck', () => {
    const old = sanitizeModeDef({ id: 'custom-old', name: 'Vieja', twoSided: true, deck: { numbers: { zero: 1, each: 2, minValue: 1 }, perColor: [{ kind: 'skip', n: 2 }], wild: [{ kind: 'wild', n: 4 }] } });
    expect(old.deck).toEqual(DAY_SIDE_DECK);
    expect(old.night).toEqual(NIGHT_SIDE_DECK);
    expect(sanitizeModeDef({ id: 'custom-one' }).night).toBeUndefined();
  });

  it('sanitizing accepts the new kinds: colourless ones only in the wild list, Eclipse per colour', () => {
    const d = sanitizeDeckSpec({
      perColor: [{ kind: 'flip', n: 1 }, { kind: 'wildFlip', n: 1 }, { kind: 'shield', n: 1 }, { kind: 'skipAll', n: 1 }],
      wild: [{ kind: 'wildFlip', n: 2 }, { kind: 'sweepWild', n: 3 }, { kind: 'sweep', n: 1 }],
    });
    expect(d.perColor).toEqual([{ kind: 'flip', n: 1 }, { kind: 'shield', n: 1 }, { kind: 'skipAll', n: 1 }]);
    expect(d.wild).toEqual([{ kind: 'wildFlip', n: 2 }, { kind: 'sweepWild', n: 3 }]);
    expect(PER_COLOR_KINDS).toContain('flip');
    expect(COLOURLESS_KINDS).toEqual(expect.arrayContaining(['wildFlip', 'sweepWild']));
  });

  it('a custom two-sided mode deals its own day and night lists', () => {
    const custom = sanitizeModeDef({
      id: 'custom-2s', name: 'Dos caras', twoSided: true,
      deck: { numbers: { zero: 1, each: 1, minValue: 1 }, perColor: [{ kind: 'sweep', n: 1 }, { kind: 'flip', n: 1 }], wild: [{ kind: 'wildFlip', n: 2 }, { kind: 'sweepWild', n: 2 }] },
      night: { numbers: { zero: 1, each: 2, minValue: 5 }, perColor: [{ kind: 'skipAll', n: 1 }, { kind: 'shield', n: 1 }, { kind: 'draw6', n: 1 }], wild: [{ kind: 'wild4', n: 2 }] },
    });
    const m = createMatch({}, { mode: 'dayNight', players: 2, custom }, 3);
    expect(m.rules.deck).toBe('dayNight');
    const deck = matchDeck(m);
    // day 4×(10 + 2) + 4 = 52; night 4×(1 + 10 + 3) + 2 = 58: the day side repeats some faces
    expect(deck).toHaveLength(58);
    expect(deck.every((c) => c.other && (c.face.color === null || COLORS.includes(c.face.color as never)))).toBe(true);
    expect(deck.every((c) => c.other!.color === null || NIGHT_COLORS.includes(c.other!.color as never))).toBe(true);
    expect(deck.filter((c) => c.face.kind === 'wildFlip').length).toBeGreaterThanOrEqual(2);
    expect(deck.filter((c) => c.other!.kind === 'draw6').every((c) => c.other!.draw === 5)).toBe(true);
    expect(deck.filter((c) => c.other!.kind === 'wild4').every((c) => c.other!.draw === 6 && c.other!.night)).toBe(true);
    expect(deck.filter((c) => c.other!.kind === 'skipAll')).toHaveLength(4);
    const r = startRound(m).match.round!;
    expect(r.discard[0].other).toBeDefined();
  });

  it('a one-sided deck leaves Eclipses out', () => {
    const d = buildDeckFromSpec({ numbers: { zero: 1, each: 1, minValue: 9 }, perColor: [{ kind: 'flip', n: 2 }, { kind: 'skip', n: 1 }], wild: [{ kind: 'wildFlip', n: 3 }, { kind: 'wild', n: 1 }] });
    expect(d.map((c) => c.face.kind).filter((k) => k === 'flip' || k === 'wildFlip')).toEqual([]);
    expect(d).toHaveLength(4 * 3 + 1);
  });
});

// ───────────────────────── the new cards ─────────────────────────

let nextId = 7000;
const dn = (face: CardFace, other: CardFace): Card => ({ id: nextId++, face, other });
const n = (color: Color, value: number): CardFace => ({ kind: 'number', color, value });
const plays = (m: MatchState, seat: Seat, id: number) => legalMoves(m, seat).filter((mv): mv is Extract<Move, { kind: 'play' }> => mv.kind === 'play' && mv.cardId === id);

describe('wildFlip (Eclipse comodín)', () => {
  it('two-sided: plays on anything, offers the other side colours, turns everything over and keeps the pick', () => {
    const wf = dn({ kind: 'wildFlip', color: null }, n('rosa', 4));
    const mine = dn(n('mar', 2), n('naranja', 7));
    const deck = Array.from({ length: 10 }, (_, i) => dn(n('mar', i % 10), n('celeste', (i + 3) % 10)));
    const m = scenario({ rules: dnRules, mode: 'dayNight', players: 2, hands: { 0: [wf, mine], 2: [dn(n('palma', 5), n('morado', 1))] }, top: dn(n('sol', 3), n('morado', 3)), deck });
    const options = plays(m, 0, wf.id);
    expect(options.map((mv) => mv.color).sort()).toEqual([...NIGHT_COLORS].sort());
    const { match, events } = applyMove(m, { kind: 'play', seat: 0, cardId: wf.id, color: 'celeste' });
    const r = match.round!;
    expect(r.side).toBe('dark');
    expect(r.discard.at(-1)!.face).toEqual(n('rosa', 4));
    expect(r.activeColor).toBe('celeste'); // the pick, not the colour turned up
    expect(r.hands[0][0].face).toEqual(n('naranja', 7));
    const flip = events.find((e) => e.type === 'flip') as Extract<(typeof events)[number], { type: 'flip' }>;
    expect(flip.color).toBe('celeste');
    expect(r.turn).toBe(2);
    // on the night side it offers the day colours
    const wf2 = dn(n('sol', 1), { kind: 'wildFlip', color: null, night: true });
    const night: MatchState = { ...match, round: { ...r, hands: r.hands.map((h, s) => (s === 2 ? [...h, { ...wf2, face: wf2.other!, other: wf2.face }] : h)) } };
    expect(plays(night, 2, wf2.id).map((mv) => mv.color).sort()).toEqual([...COLORS].sort());
    const back = applyMove(night, { kind: 'play', seat: 2, cardId: wf2.id, color: 'palma' }).match.round!;
    expect(back.side).toBe('light');
    expect(back.activeColor).toBe('palma');
  });

  it('going out on it ends the round without a turn over', () => {
    const wf = dn({ kind: 'wildFlip', color: null }, n('rosa', 4));
    const m = scenario({ rules: { ...dnRules, kuCall: false }, mode: 'dayNight', players: 2, hands: { 0: [wf], 2: [dn(n('palma', 5), n('morado', 1))] }, top: dn(n('sol', 3), n('morado', 3)) });
    const { match, events } = applyMove(m, { kind: 'play', seat: 0, cardId: wf.id, color: 'rosa' });
    expect(events.some((e) => e.type === 'roundEnd')).toBe(true);
    expect(events.some((e) => e.type === 'flip')).toBe(false);
    expect(match.round!.side).toBe('light');
  });

  it('one-sided (never dealt there, but safe): a plain wild', () => {
    const wf = card('wildFlip');
    const m = scenario({ players: 2, hands: { 0: [wf, num('mar', 1)], 2: [num('palma', 5)] }, top: num('sol', 3) });
    expect(plays(m, 0, wf.id).map((mv) => mv.color).sort()).toEqual([...COLORS].sort());
    const r = applyMove(m, { kind: 'play', seat: 0, cardId: wf.id, color: 'mar' }).match.round!;
    expect(r.side).toBe('light');
    expect(r.activeColor).toBe('mar');
  });
});

describe('sweepWild (Barrida comodín)', () => {
  it('discards every card of the chosen colour under it; that colour is in play', () => {
    const sw = card('sweepWild');
    const keep = num('sol', 1);
    const gone = [num('mar', 2), card('skip', 'mar'), num('mar', 9)];
    const m = scenario({ players: 2, hands: { 0: [sw, keep, ...gone], 2: [num('palma', 5)] }, top: num('coral', 3) });
    expect(plays(m, 0, sw.id).map((mv) => mv.color).sort()).toEqual([...COLORS].sort());
    const { match, events } = applyMove(m, { kind: 'play', seat: 0, cardId: sw.id, color: 'mar' });
    const r = match.round!;
    expect(r.hands[0].map((c) => c.id)).toEqual([keep.id]);
    expect(r.activeColor).toBe('mar');
    expect(r.discard.at(-1)!.id).toBe(sw.id);
    expect(r.discard.slice(-4, -1).map((c) => c.id).sort()).toEqual(gone.map((c) => c.id).sort());
    const ev = events.find((e) => e.type === 'sweep') as Extract<(typeof events)[number], { type: 'sweep' }>;
    expect(ev.cardIds.sort()).toEqual(gone.map((c) => c.id).sort());
    expect(r.turn).toBe(2);
  });

  it('sweeping the whole hand wins the round', () => {
    const sw = card('sweepWild');
    const m = scenario({ players: 2, hands: { 0: [sw, num('mar', 2), num('mar', 4)], 2: [num('palma', 5)] }, top: num('coral', 3) });
    const { events } = applyMove(m, { kind: 'play', seat: 0, cardId: sw.id, color: 'mar' });
    expect(events.some((e) => e.type === 'roundEnd' && e.winner === 0)).toBe(true);
  });

  it('the bots pick the colour that sheds the most cards', () => {
    const sw = card('sweepWild');
    const hand = [sw, num('mar', 2), num('mar', 4), num('mar', 7), num('palma', 1)];
    const m = scenario({ players: 2, hands: { 0: hand, 2: [num('palma', 5), num('sol', 5), num('sol', 6), num('coral', 1)] }, top: num('coral', 3) });
    for (const level of ['normal', 'hard'] as const) {
      const mv = chooseMove(m, 0, level) as Extract<Move, { kind: 'play' }>;
      expect(mv.kind).toBe('play');
      expect(mv.cardId).toBe(sw.id);
      expect(mv.color).toBe('mar');
    }
  });
});

describe('retired power cards in player-made decks', () => {
  it('skipAll: everyone else is skipped and the player goes again', () => {
    const sa = card('skipAll', 'sol');
    const m = scenario({ players: 3, hands: { 0: [sa, num('sol', 1)], 1: [num('mar', 1)], 3: [num('mar', 2)] }, top: num('sol', 3) });
    const { match, events } = applyMove(m, { kind: 'play', seat: 0, cardId: sa.id });
    expect(events.filter((e) => e.type === 'skip').map((e) => (e as { seat: Seat }).seat)).toEqual([1, 3]);
    expect(match.round!.turn).toBe(0);
  });

  it('shield: the victim cancels a penalty out of turn', () => {
    const d2 = card('draw2', 'sol');
    const sh = card('shield', 'mar');
    const m = scenario({ rules: { stacking: 'off' }, players: 2, hands: { 0: [d2, num('sol', 1)], 2: [sh, num('palma', 1)] }, top: num('sol', 3) });
    let x = applyMove(m, { kind: 'play', seat: 0, cardId: d2.id }).match;
    expect(x.round!.window?.reason).toBe('penalty');
    x = applyMove(x, { kind: 'respond', seat: 2, cardId: sh.id }).match;
    expect(x.round!.pendingDraw).toBe(0);
    expect(x.round!.hands[2]).toHaveLength(1);
  });
});

// ───────────────── random player-made decks with every power card ─────────────────

const ALL_PER_COLOR: CardKind[] = ['skip', 'skipAll', 'reverse', 'draw2', 'draw6', 'shield', 'sweep', 'mirror'];
const ALL_WILD: CardKind[] = ['wild4', 'draw10', 'swap', 'wildColor', 'sweepWild'];

function randomSpec(rng: Rng, twoSided: boolean): DeckSpec {
  const perColor = ALL_PER_COLOR.filter(() => rng.next() < 0.7).map((kind) => ({ kind, n: 1 + rng.int(2) }));
  const wild = [{ kind: 'wild' as CardKind, n: 2 }, ...ALL_WILD.filter(() => rng.next() < 0.6).map((kind) => ({ kind, n: 1 + rng.int(2) }))];
  if (twoSided) {
    perColor.push({ kind: 'flip', n: 1 });
    wild.push({ kind: 'wildFlip', n: 1 + rng.int(2) });
  }
  // every power kind shows up somewhere over the seeds
  return { numbers: { zero: rng.int(2), each: 1 + rng.int(2), minValue: 1 + rng.int(5) }, perColor, wild };
}

function playOut(m0: MatchState, label: string): Set<CardKind> {
  const played = new Set<CardKind>();
  let m = startRound(m0).match;
  let ended = false;
  for (let i = 0; i < 20000 && !ended; i++) {
    const r = m.round!;
    if (r.over) break;
    const seats = [r.turn, ...m.seats.filter((s) => s !== r.turn)] as Seat[];
    let moved = false;
    for (const s of seats) {
      if (!legalMoves(m, s).length) continue;
      const mv = chooseMove(m, s, (['easy', 'normal', 'hard'] as const)[i % 3]);
      if (!mv) continue;
      if (mv.kind === 'play' || mv.kind === 'respond') {
        const c = m.round!.hands[s].find((x) => x.id === mv.cardId);
        if (c) played.add(c.face.kind);
      }
      const out = applyMove(m, mv);
      m = out.match;
      ended = out.events.some((e) => e.type === 'roundEnd');
      moved = true;
      break;
    }
    if (!moved) {
      if (!m.round!.window) break;
      const out = closeWindow(m);
      m = out.match;
      ended = out.events.some((e) => e.type === 'roundEnd');
    }
  }
  expect(m.round!.over || ended, label).toBe(true);
  return played;
}

describe('random player-made decks with every power card play full rounds', () => {
  it('one-sided and two-sided', () => {
    const seen = new Set<CardKind>();
    for (let seed = 1; seed <= 16; seed++) {
      for (const twoSided of [false, true]) {
        const rng = new Rng(seed * 31 + (twoSided ? 7 : 0));
        const custom = sanitizeModeDef({
          id: `custom-r${seed}`, name: `R${seed}`, twoSided,
          deck: randomSpec(rng, twoSided),
          ...(twoSided ? { night: randomSpec(rng, true) } : {}),
          rules: { target: 0, stacking: rng.next() < 0.5 ? 'any' : 'off', kuCall: true },
        });
        const m = createMatch({}, { mode: twoSided ? 'dayNight' : 'classic', players: (2 + rng.int(3)) as 2 | 3 | 4, custom }, seed);
        for (const k of playOut(m, `seed ${seed} ${twoSided ? 'two' : 'one'}-sided`)) seen.add(k);
      }
    }
    // the bots really played the new and the retired kinds
    for (const k of ['wildFlip', 'sweepWild', 'flip', 'skipAll', 'sweep', 'swap'] as CardKind[]) expect(seen.has(k), k).toBe(true);
  });
});
