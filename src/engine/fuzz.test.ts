/**
 * CPU vs CPU fuzz: full matches for every preset, player count and partner seating, with the rule
 * toggles varied per seed, plus "everything on" configurations (Cyclone deck, every power card,
 * challenge, partnerShield / partnerPass). Invariants: every move is legal, cards are conserved, games
 * terminate.
 *
 * Moves come from the CPU (`chooseMove`). So the engine suite does not depend on how complete the CPU
 * is, the driver also: picks a random legal move when the CPU has none for the seat on turn, now and
 * then answers penalty windows / challenges at random (respond, challenge) and attaches a random
 * partnerPass `give` to 7 plays.
 */
import { describe, expect, it } from 'vitest';
import type { Difficulty, GameMode, MatchSetup, MatchState, Move, RuleSettings, Seat } from '../contracts';
import { applyMove, buildDeck, cardCount, chooseMove, closeWindow, createMatch, giveOptions, isLegal, legalMoves, RULE_PRESETS, startRound } from '.';
import { Rng } from './rng';

// the Cyclone deck without elimination can run long rounds (huge stacks): a few thousand moves seen
const MAX_MOVES_PER_ROUND = 10000;
const MAX_ROUNDS = 60;
const MATCHES = 110;

function variedRules(base: RuleSettings, rng: Rng, all: boolean): RuleSettings {
  const pick = <T,>(xs: T[]) => xs[rng.int(xs.length)];
  const rules: RuleSettings = {
    ...base,
    jumpIn: rng.next() < 0.5,
    sevenZero: rng.next() < (all ? 0.3 : 0.5),
    forcePlay: rng.next() < 0.3,
    kuCall: rng.next() < 0.8,
    drawMode: pick(['one', 'untilPlayable']),
    stacking: base.stacking === 'off' ? pick(['off', 'off', 'same', 'any']) : base.stacking,
    eliminateAt: base.eliminateAt ? base.eliminateAt : pick([0, 0, 25]),
    handSize: pick([5, 7, 7, 10]),
    target: pick([0, 0, 200]),
    wild4Challenge: all || rng.next() < 0.3,
    partnerShield: all || rng.next() < 0.3,
    partnerPass: all || rng.next() < 0.3,
  };
  if (all) {
    Object.assign(rules, { deck: 'cyclone', 'power.swap': true, 'power.shield': true, 'power.sweep': true, 'power.mirror': true });
    rules.stacking = pick(['off', 'same', 'any']);
  }
  return rules;
}

interface Stats {
  rounds: number;
  moves: number;
  offTurn: number;
  responds: number;
  challenges: number;
  gives: number;
}

/** the CPU's move, with the random extras described at the top */
function driverMove(m: MatchState, seat: Seat, level: Difficulty, rng: Rng, onTurn: boolean): Move | null {
  const legal = legalMoves(m, seat);
  if (!legal.length) return null;
  const extras = legal.filter((x) => x.kind === 'respond' || x.kind === 'challenge');
  if (extras.length && rng.next() < 0.35) return extras[rng.int(extras.length)];
  let mv = chooseMove(m, seat, level);
  if (!mv && onTurn) mv = legal[rng.int(legal.length)];
  if (mv?.kind === 'play' && mv.give === undefined && rng.next() < 0.5) {
    const gifts = giveOptions(m, mv);
    if (gifts.length) mv = { ...mv, give: gifts[rng.int(gifts.length)] };
  }
  return mv;
}

function playMatch(rules: RuleSettings, setup: MatchSetup, seed: number, stats: Stats): MatchState {
  const rng = new Rng(seed ^ 0x5bd1e995);
  const levels: Difficulty[] = [0, 1, 2, 3, 4, 5].map(() => (rng.next() < 0.5 ? 'easy' : 'normal'));
  let m = createMatch(rules, setup, seed);
  const deckSize = buildDeck(rules).length;
  let rounds = 0;
  const lastMoves: unknown[] = [];
  const apply = (mv: Move) => {
    lastMoves.push(mv);
    if (lastMoves.length > 50) lastMoves.shift();
    if (!isLegal(m, mv)) throw new Error(`illegal move ${JSON.stringify(mv)} (seed ${seed})`);
    if (mv.kind === 'respond') stats.responds++;
    if (mv.kind === 'challenge') stats.challenges++;
    if (mv.kind === 'play' && mv.give !== undefined) stats.gives++;
    m = applyMove(m, mv).match;
    const rr = m.round!;
    if (cardCount(rr) !== deckSize) throw new Error(`card count ${cardCount(rr)} != ${deckSize} (seed ${seed})`);
    const ids = new Set([...rr.hands.flat(), ...rr.deck, ...rr.discard].map((c) => c.id));
    if (ids.size !== deckSize) throw new Error(`duplicate cards (seed ${seed})`);
    for (const s of m.seats) if (rr.eliminated[s] && rr.hands[s].length) throw new Error('eliminated seat holds cards');
    if (!rr.over && rr.pendingDraw > 0 && rr.eliminated[rr.turn]) throw new Error('pending penalty on an eliminated seat');
    if (rr.window?.reason === 'penalty' && rr.window.victim !== rr.turn) throw new Error('penalty window victim is not on turn');
  };
  while (!m.over) {
    if (++rounds > MAX_ROUNDS) throw new Error(`match ${seed} did not finish in ${MAX_ROUNDS} rounds`);
    m = startRound(m).match;
    stats.rounds++;
    let moves = 0;
    while (!m.round!.over) {
      if (++moves > MAX_MOVES_PER_ROUND) {
        const rr = m.round!;
        throw new Error(`round did not terminate (seed ${seed}) ${JSON.stringify({ rules, turn: rr.turn, pend: rr.pendingDraw, w: rr.window, hands: rr.hands.map((h) => h.map((c) => c.face.kind + ':' + c.face.color + ':' + (c.face.value ?? ''))), deck: rr.deck.length, disc: rr.discard.length, top: rr.discard.at(-1), ac: rr.activeColor, last: lastMoves.slice(-12) })}`);
      }
      const r = m.round!;
      // off-turn reactions first (jump-in, ¡Ku! calls / catches, partner shields), in a varying seat order
      const start = rng.int(m.seats.length);
      let reacted = false;
      for (let i = 0; i < m.seats.length && !reacted; i++) {
        const s = m.seats[(start + i) % m.seats.length] as Seat;
        if (s === r.turn) continue;
        const mv = driverMove(m, s, levels[s], rng, false);
        if (!mv) continue;
        apply(mv);
        stats.offTurn++;
        reacted = true;
      }
      if (reacted) continue;
      if (m.round!.window && rng.next() < 0.4) {
        m = closeWindow(m).match;
        continue;
      }
      const turn = m.round!.turn;
      const mv = driverMove(m, turn, levels[turn], rng, true);
      expect(mv).not.toBeNull();
      apply(mv!);
      stats.moves++;
    }
  }
  return m;
}

interface Config {
  name: string;
  mode: GameMode;
  players: 2 | 3 | 4;
  seating?: 'across' | 'side';
  all?: boolean;
}
const configs: Config[] = [];
for (const p of RULE_PRESETS) {
  if (p.id === 'partners') {
    configs.push({ name: 'partners across', mode: 'partners', players: 4, seating: 'across' });
    configs.push({ name: 'partners side', mode: 'partners', players: 4, seating: 'side' });
  } else for (const n of [2, 3, 4] as const) configs.push({ name: `${p.id} ${n}p`, mode: p.id, players: n });
}
for (const n of [2, 3, 4] as const) configs.push({ name: `cyclone + everything ${n}p`, mode: 'cyclone', players: n, all: true });
for (const seating of ['across', 'side'] as const) configs.push({ name: `partners + everything ${seating}`, mode: 'partners', players: 4, seating, all: true });

describe(`fuzz: ${MATCHES} CPU matches per configuration`, () => {
  for (const cfg of configs) {
    it(cfg.name, () => {
      const base = RULE_PRESETS.find((p) => p.id === cfg.mode)!.rules;
      const stats: Stats = { rounds: 0, moves: 0, offTurn: 0, responds: 0, challenges: 0, gives: 0 };
      for (let seed = 1; seed <= MATCHES; seed++) {
        const rng = new Rng(seed * 7919);
        const rules = variedRules(base, rng, !!cfg.all);
        const m = playMatch(rules, { mode: cfg.mode, players: cfg.players, seating: cfg.seating }, seed, stats);
        expect(m.over).toBe(true);
        expect(m.winner).not.toBeNull();
        if (cfg.mode === 'partners') {
          const [a, b] = m.teams!;
          expect(m.scores[a[0]]).toBe(m.scores[a[1]]);
          expect(m.scores[b[0]]).toBe(m.scores[b[1]]);
          expect(m.winnerTeam === 0 || m.winnerTeam === 1).toBe(true);
        }
      }
      expect(stats.rounds).toBeGreaterThanOrEqual(MATCHES);
      expect(stats.moves / stats.rounds).toBeLessThan(300); // rounds stay a sane length on average
      if (cfg.all) {
        expect(stats.responds).toBeGreaterThan(0);
        expect(stats.challenges).toBeGreaterThan(0);
      }
      if (cfg.all && cfg.mode === 'partners') expect(stats.gives).toBeGreaterThan(0);
    }, 60_000);
  }
});
