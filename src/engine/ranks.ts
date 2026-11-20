/**
 * Final-minute position badges: the two players holding the fewest card points right now get (1) and
 * (2). Always individual players, also in team games (you and your partner may well be 1 and 2), and
 * never more than two badges: fewer cards break a points tie, then seat order.
 * Pure; used by the offline controller and by the room server (online clients cannot see the hands).
 */
import type { MatchState, Seat } from '../contracts';
import { activeSeats, handPoints } from './game';

/** [seat, rank] for the two players with a badge; empty without a live round */
export function finalRanks(m: MatchState): [Seat, 1 | 2][] {
  const r = m.round;
  if (!r || r.over) return [];
  const keyed = activeSeats(m, r).map((s, i) => ({ s, i, p: handPoints(r.hands[s]), c: r.hands[s].length }));
  keyed.sort((a, b) => a.p - b.p || a.c - b.c || a.i - b.i);
  return keyed.slice(0, 2).map((k, i) => [k.s, (i + 1) as 1 | 2]);
}
