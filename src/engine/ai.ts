/**
 * CPU players. Deterministic: randomness comes from hashSeed(match state, seat, level), never Math.random.
 *  - easy:   a random legal card (random wild colour), catches / calls ¡Ku! only some of the time.
 *  - normal: heuristics with casual slips (dump high cards, keep wilds, best colour, penalties on short opponents,
 *            partner-aware: never penalise the partner when avoidable, reverse to steer penalties;
 *            shield / mirror when hit, never mirror onto the partner; careful +4 challenges).
 *  - hard:   normal + public card counting, partner knowledge, holding penalties / wilds for the endgame
 *            (aiKnow.ts, aiPolicy.ts HARD_W), with a few small slips.
 *  - master: hard without the slips + short determinized Monte Carlo with hard playouts (aiSim.ts, MASTER_MS).
 * Balance (4 players, classic, ai.bench.test.ts): see PLAN.md §5.
 * `style` adds light biases on top of the level (STYLE_WEIGHTS in aiPolicy.ts).
 */
import { colorSlot } from '../contracts';
import type { Color, Difficulty, MatchState, Move, PlayStyle, RoundState, Seat } from '../contracts';
import { knowledge, observe } from './aiKnow';
import { chooseEasy, chooseHeuristic, makeCtx, scoreTurn, styleWeights, type Level } from './aiPolicy';
import { chooseMaster, masterSeed, type MasterOptions } from './aiSim';
import { legalMoves } from './game';
import { hashSeed, Rng } from './rng';

export { EASY_FORGET_KU, STYLE_WEIGHTS, styleWeights } from './aiPolicy';
export { MASTER_MS, lastMasterStats, type MasterOptions } from './aiSim';
export { resetTracker } from './aiKnow';

const LEVEL_ID: Record<Difficulty, number> = { easy: 1, normal: 2, hard: 3, master: 4 };

export function chooseMove(match: MatchState, seat: Seat, level: Difficulty, style?: PlayStyle, opts?: MasterOptions): Move | null {
  const r = match.round;
  if (!r || r.over || match.over) return null;
  // every hard / master look at the table feeds the public-history tracker
  const track = level === 'hard' || level === 'master' ? observe(match) : null;
  const legal = legalMoves(match, seat);
  if (!legal.length) return null;
  if (level === 'master') return chooseMaster(match, seat, knowledge(match, r, seat, track), masterSeed(match, seat), style, opts);
  const rng = new Rng(hashSeed(match.rng, seat, LEVEL_ID[level], r.discard.length, r.deck.length, r.hands[seat].length, r.turn, r.roundNo));
  const lv = LEVEL_ID[level] as Level;
  const k = level === 'hard' ? knowledge(match, r, seat, track) : null;
  const c = makeCtx(match, seat, lv, styleWeights(style), k, rng);
  if (lv === 3) c.slip = true;
  return lv === 1 ? chooseEasy(c, legal, style) : chooseHeuristic(c, legal);
}

/** normal-level heuristic value of a turn move (or a jump-in, scored as a play by `seat`) */
export function scoreMove(m: MatchState, _r: RoundState, seat: Seat, mv: Move): number {
  return scoreTurn(makeCtx(m, seat, 2, styleWeights(), null, new Rng(1)), mv);
}

/** the colour an automatic play picks (turn timer, or a human's winning last card): red */
export const AUTO_COLOR: Color = 'coral';

const TIMEOUT_KINDS = new Set<Move['kind']>(['play', 'draw', 'pass', 'acceptPenalty', 'respond', 'challenge']);

/** `mv` with its colour choice (if any) replaced by AUTO_COLOR, as listed in `legal` */
export function withAutoColor(legal: Move[], mv: Move): Move {
  if (mv.kind !== 'play' || !mv.color) return mv;
  // Día y Noche: on the night side the same slot (morado)
  const red = legal.find((l) => l.kind === 'play' && l.cardId === mv.cardId && !!l.color && colorSlot(l.color) === colorSlot(AUTO_COLOR) && l.target === mv.target);
  return red ? { ...red, ...(mv.ku ? { ku: true } : {}) } : mv;
}

/**
 * The move made for a human whose turn timer ran out (offline controller and room server alike):
 *  - after a draw the player made themselves: pass, so the drawn card is NOT played (unless forcePlay
 *    leaves no pass, then it is played, red if wild);
 *  - otherwise the normal-level CPU policy picks among the turn moves (stack, challenge, shield, play,
 *    draw…), any colour → red. When that move is a draw, apply it and then `afterAutoDraw`.
 */
export function timeoutMove(match: MatchState, seat: Seat): Move | null {
  const r = match.round;
  if (!r || r.over || match.over || r.turn !== seat) return null;
  const legal = legalMoves(match, seat).filter((m) => TIMEOUT_KINDS.has(m.kind));
  if (!legal.length) return null;
  if (r.drewThisTurn) return legal.find((m) => m.kind === 'pass') ?? withAutoColor(legal, legal[0]);
  const rng = new Rng(hashSeed(match.rng, seat, LEVEL_ID.normal, r.discard.length, r.deck.length, r.hands[seat].length, r.turn, r.roundNo));
  const mv = chooseHeuristic(makeCtx(match, seat, 2, styleWeights(), null, rng), legal);
  return withAutoColor(legal, mv && TIMEOUT_KINDS.has(mv.kind) ? mv : legal[0]);
}

/** after a draw made by the turn timer: the drawn card is played when it can be (red if wild), else pass */
export function afterAutoDraw(match: MatchState, seat: Seat): Move | null {
  const r = match.round;
  if (!r || r.over || match.over || r.turn !== seat || !r.drewThisTurn) return null;
  const legal = legalMoves(match, seat);
  const play = legal.find((m) => m.kind === 'play' && m.cardId === r.drawnCardId);
  if (play) {
    const mv = withAutoColor(legal, play);
    return mv.kind === 'play' && match.rules.kuCall && r.hands[seat].length === 2 ? { ...mv, ku: true } : mv;
  }
  return legal.find((m) => m.kind === 'pass') ?? null;
}
