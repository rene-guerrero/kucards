import { describe, it, expect } from 'vitest';
import type { CardKind, MatchState, Seat } from '../contracts';
import { applyMove, closeWindow, createMatch, legalMoves, startRound } from './game';
import { buildDeck, buildDeckFromSpec } from './cards';
import { BUILTIN_MODES, deckSpecForRules, modeDef, sanitizeModeDef, type DeckSpec } from './modes';
import { RULE_PRESETS, modeRules } from './rules';
import { Rng } from './rng';
import { chooseMove } from './ai';
import { freeName, nameFree, nameKey } from '../modes/core';

describe('modes as data', () => {
  it('every built-in deck is built from its card list, same cards in the same order', () => {
    for (const p of RULE_PRESETS) {
      if (p.rules.deck === 'dayNight') continue;
      const viaSpec = buildDeckFromSpec(deckSpecForRules(p.rules));
      expect(buildDeck(p.rules)).toEqual(viaSpec);
    }
  });

  it('the forced rules are what the modes always enforced', () => {
    expect(modeRules('classic', { stacking: 'off' }).stacking).toBe('off');
    for (const m of ['action', 'cyclone', 'sideBySide', 'dayNight'] as const) expect(modeRules(m, { stacking: 'off' }).stacking).toBe('any');
    expect(modeRules('action', {})).toMatchObject({ 'power.sweep': true, 'power.swap': true });
    expect(modeRules('sideBySide', {})['power.sweep']).toBe(true);
  });

  it('seating comes from the definition: Codo a codo always 4 players side by side', () => {
    expect(modeDef('sideBySide')).toMatchObject({ teams: 'always', seating: 'side' });
    const m = createMatch({}, { mode: 'sideBySide', players: 2 });
    expect(m.seats).toHaveLength(4);
    expect(m.teams).toEqual([[0, 1], [2, 3]]);
    expect(createMatch({}, { mode: 'classic', players: 4, teams: true }).teams).toEqual([[0, 2], [1, 3]]);
    expect(createMatch({}, { mode: 'classic', players: 3, teams: true }).teams).toBeUndefined();
  });

  it('stored JSON: missing fields take defaults, unknown rule keys are kept, junk is dropped', () => {
    const d = sanitizeModeDef({ id: 'custom-a', name: '  Mi modo  ', rules: { target: 300, futureRule: 'x', bad: { no: 1 } }, deck: { perColor: [{ kind: 'skip', n: 99 }, { kind: 'wild4', n: 2 }, { kind: 'nope', n: 1 }] } });
    expect(d).toMatchObject({ v: 1, id: 'custom-a', name: 'Mi modo', icon: 'cards', teams: 'optional', seating: 'across', twoSided: false });
    expect(d.rules).toEqual({ target: 300, futureRule: 'x' });
    // a colourless card can't be per colour; counts are capped
    expect(d.deck.perColor).toEqual([{ kind: 'skip', n: 12 }]);
    expect(d.deck.wild.length).toBeGreaterThan(0);
    expect(sanitizeModeDef(null).teams).toBe('optional');
    expect(sanitizeModeDef({ teams: 'off', seating: 'side' }).seating).toBe('across');
    // round trip
    expect(sanitizeModeDef(JSON.parse(JSON.stringify(BUILTIN_MODES.cyclone)))).toMatchObject({ id: 'cyclone', builtIn: true, forced: { stacking: 'any' } });
  });

  it('names: unique without case / accents / spaces, and a free copy name', () => {
    expect(nameKey(' Ciclón  Loco ')).toBe('ciclon loco');
    expect(nameFree('ciclon', ['Ciclón'])).toBe(false);
    expect(nameFree('Mi modo', ['Ciclón'])).toBe(true);
    expect(freeName('Ciclón', ['Ciclón', 'Ciclón (2)'])).toBe('Ciclón (3)');
  });

  // random card mixes (what a player could build) always play a whole round with the bots
  it('random decks play full rounds', () => {
    const POWER: CardKind[] = ['skip', 'skipAll', 'reverse', 'draw2', 'draw6', 'shield', 'sweep', 'mirror'];
    const WILD: CardKind[] = ['wild', 'wild4', 'draw10', 'swap', 'wildColor', 'sweepWild'];
    for (let seed = 1; seed <= 12; seed++) {
      const rng = new Rng(seed);
      const spec: DeckSpec = {
        numbers: { zero: rng.int(2), each: 1 + rng.int(2), minValue: 1 + rng.int(5) },
        perColor: POWER.filter(() => rng.next() < 0.6).map((kind) => ({ kind, n: 1 + rng.int(3) })),
        wild: [{ kind: 'wild', n: 2 }, ...WILD.slice(1).filter(() => rng.next() < 0.5).map((kind) => ({ kind, n: 1 + rng.int(3) }))],
      };
      let m: MatchState = startRound(createMatch({ target: 0, stacking: 'any' }, { mode: 'classic', players: (2 + rng.int(3)) as 2 | 3 | 4, deck: spec }, seed)).match;
      let ended = false;
      // penalty-heavy decks with few numbers make very long rounds (the editor should warn about them)
      for (let i = 0; i < 20000 && !ended; i++) {
        const r = m.round!;
        if (r.over) break;
        // whoever has a legal move acts (the turn seat first)
        const seats = [r.turn, ...m.seats.filter((s) => s !== r.turn)] as Seat[];
        let moved = false;
        for (const s of seats) {
          if (!legalMoves(m, s).length) continue;
          const mv = chooseMove(m, s, 'normal');
          if (!mv) continue;
          const out = applyMove(m, mv);
          m = out.match;
          ended = out.events.some((e) => e.type === 'roundEnd');
          moved = true;
          break;
        }
        if (!moved) {
          // a window (¡Ku! / penalty) nobody answers closes on its timer in the game
          if (!m.round!.window) break;
          const out = closeWindow(m);
          m = out.match;
          ended = out.events.some((e) => e.type === 'roundEnd');
        }
      }
      expect(m.round!.over || ended, `seed ${seed}`).toBe(true);
    }
  });
});

describe('player-made modes', () => {
  const custom = sanitizeModeDef({
    id: 'custom-test', name: 'Locura', icon: 'flame', base: 'classic', teams: 'always', seating: 'across',
    deck: { numbers: { zero: 1, each: 2, minValue: 1 }, perColor: [{ kind: 'skip', n: 3 }, { kind: 'draw6', n: 2 }], wild: [{ kind: 'wild', n: 4 }, { kind: 'draw10', n: 2 }] },
    rules: { target: 200, stacking: 'any' },
  });

  it('a match plays the custom definition: forced 2 vs 2 across, its rules and its deck', () => {
    const m = startRound(createMatch({}, { mode: 'classic', players: 2, custom }, 7)).match;
    expect(m.seats).toHaveLength(4);
    expect(m.teams).toEqual([[0, 2], [1, 3]]);
    expect(m.rules).toMatchObject({ target: 200, stacking: 'any' });
    expect(m.custom).toEqual({ id: 'custom-test', name: 'Locura', icon: 'flame' });
    const kinds = new Set([...m.round!.deck, ...m.round!.discard, ...m.round!.hands.flat()].map((c) => c.face.kind));
    expect(kinds.has('draw10')).toBe(true);
    expect(kinds.has('reverse')).toBe(false);
  });

  it('a room adopts a custom mode and starts it; a built-in pick clears it', async () => {
    const { newRoom, setCustom, setMode, publicRoom } = await import('../net/room/lobby');
    const r = newRoom('ABCD', 0, 'host');
    setCustom(r, 'host', custom, 3);
    expect(r.playerCount).toBe(4);
    expect(publicRoom(r).custom?.id).toBe('custom-test');
    expect(r.rules.target).toBe(200);
    setMode(r, 'host', 'cyclone', 3);
    expect(r.custom).toBeUndefined();
    expect(() => setCustom(r, 'host', { id: 'classic' })).toThrow();
  });
});
