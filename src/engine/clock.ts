/**
 * Match clocks (not rules: picked on the new-game screen / by the online host). Shared by the offline
 * controller, the client and the room server.
 *
 *  - roundMin: round time limit in minutes (0 = off). When it runs out the round ends by time
 *    (engine `timeUp`): the fewest card points in hand wins.
 *  - moveSec: time per move (the human's turn clock offline, every human's turn clock online).
 *  - finalSec: time per move during the round's final minute (only with a round limit).
 */
export interface ClockSettings {
  roundMin: number;
  moveSec: number;
  finalSec: number;
}

export const ROUND_MIN_OPTIONS = [0, 2, 3, 5, 8, 10] as const;
export const MOVE_SEC = { min: 10, max: 60, def: 30, options: [10, 15, 20, 30, 45, 60] } as const;
export const FINAL_SEC = { min: 4, max: 15, def: 8, options: [4, 5, 6, 8, 10, 12, 15] } as const;
/** the final minute: shorter moves, urgent countdown, frantic music */
export const FINAL_MS = 60_000;

export const DEFAULT_CLOCK: ClockSettings = { roundMin: 0, moveSec: MOVE_SEC.def, finalSec: FINAL_SEC.def };

/** clamp to [min, max], then snap to the nearest offered option */
function pick(v: unknown, r: { min: number; max: number; def: number; options: readonly number[] }): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.min(r.max, Math.max(r.min, v)) : r.def;
  return r.options.reduce((a, b) => (Math.abs(b - n) < Math.abs(a - n) ? b : a));
}

/** any stored / received value → valid clock settings */
export function sanitizeClock(raw: unknown): ClockSettings {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    roundMin: pick(o.roundMin, { min: 0, max: 10, def: 0, options: ROUND_MIN_OPTIONS }),
    moveSec: pick(o.moveSec, MOVE_SEC),
    finalSec: pick(o.finalSec, FINAL_SEC),
  };
}

/** whether `roundLeftMs` (null = no round limit) is inside the final minute */
export const inFinalMinute = (c: ClockSettings, roundLeftMs: number | null): boolean => !!c.roundMin && roundLeftMs !== null && roundLeftMs <= FINAL_MS;

/** the time a move gets right now */
export const moveMs = (c: ClockSettings, roundLeftMs: number | null): number => (inFinalMinute(c, roundLeftMs) ? c.finalSec : c.moveSec) * 1000;

/** a CPU's think delay, kept well inside the move time */
export const fitThink = (think: number, c: ClockSettings, roundLeftMs: number | null): number => Math.min(think, moveMs(c, roundLeftMs) * 0.4);
