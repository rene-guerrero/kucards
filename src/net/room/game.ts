/**
 * Pure game-driving helpers for the room: CPU pacing and decisions, move validation. Mirrors the local
 * game loop (src/app/controller.ts) so online CPUs feel the same. Only the engine's public API is used.
 */
import type { Difficulty, MatchState, Move, PlayStyle, Seat } from '../../contracts';
import { chooseMove } from '../../engine/ai';
import { giveOptions, isLegal, legalMoves, sameMove } from '../../engine/game';

const TURN_KINDS = new Set<Move['kind']>(['play', 'draw', 'pass', 'acceptPenalty', 'respond', 'challenge']);
export const isTurnMove = (m: Move): boolean => TURN_KINDS.has(m.kind);

/** CPU think delay in ms (≈ GameController.cpuTurn): a forced draw is quick, choices take a moment */
export function thinkDelay(legalCount: number, speed = 1, rnd: () => number = Math.random): number {
  const base = legalCount <= 1 ? 450 : 620 + Math.min(legalCount, 6) * 60;
  return (base + rnd() * 450) * speed;
}

/** when the CPUs at the table react to an open window (catch a missed ¡Ku!, shield the partner) */
export const reactDelay = (speed = 1, rnd: () => number = Math.random): number => (700 + rnd() * 900) * speed;

/**
 * Workers freeze the clock during synchronous execution, so the master AI's wall-clock budget never
 * ends a search early; its playout cap bounds the work instead.
 */
const MASTER_OPTS = { maxPlayouts: 240 };

/** the CPU's move for `seat` (null = it does nothing); never throws, always a legal move */
export function cpuDecide(match: MatchState, seat: Seat, level: Difficulty, style?: PlayStyle): Move | null {
  let mv: Move | null = null;
  try {
    mv = chooseMove(match, seat, level, style, level === 'master' ? MASTER_OPTS : undefined);
  } catch (e) {
    console.error('cpu error', e);
    mv = null;
  }
  if (!mv) return null;
  return validMove(match, seat, mv);
}

/** a turn move for `seat` (the CPU covering a human, or a CPU on turn): its choice, else draw / pass / accept */
export function cpuTurnMove(match: MatchState, seat: Seat, level: Difficulty, style?: PlayStyle): Move | null {
  for (let i = 0; i < 2; i++) {
    const mv = cpuDecide(match, seat, level, style);
    if (mv && isTurnMove(mv)) return mv;
    if (!mv) break;
  }
  const legal = legalMoves(match, seat).filter(isTurnMove);
  return legal.find((m) => m.kind === 'draw' || m.kind === 'pass' || m.kind === 'acceptPenalty') ?? legal[0] ?? null;
}

/**
 * Shape check of an untrusted move for `seat`: returns the matching legal move (with the optional
 * `ku`, a valid `give` and, multiPlay, a valid `extra` list), or null. An `extra` list that is not
 * legal (engine isLegal: rule on, same number, in the hand, no repeats, a plain turn) rejects the whole
 * move: it would be another move than the player meant. A non-list `extra` is dropped like any junk field.
 */
export function validMove(match: MatchState, seat: Seat, raw: unknown): Move | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  if (m.seat !== seat || typeof m.kind !== 'string') return null;
  const found = legalMoves(match, seat).find((l) => sameMove(l, m as unknown as Move));
  if (!found) return null;
  if (found.kind !== 'play') return { ...found };
  const out: Move = { ...found };
  if (m.ku === true) out.ku = true;
  if (Array.isArray(m.extra)) {
    if (m.extra.length > 108 || !m.extra.every((id) => Number.isInteger(id))) return null;
    if (m.extra.length) {
      out.extra = (m.extra as number[]).slice();
      if (!isLegal(match, out)) return null;
    }
  }
  if (typeof m.give === 'number' && giveOptions(match, out).includes(m.give)) out.give = m.give;
  return out;
}
