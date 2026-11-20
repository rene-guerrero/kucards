/**
 * Timer schedule of one room. A Durable Object has a single alarm, so every pending timer lives here
 * (persisted with the room) and the alarm is always set to the earliest due time. Pure functions only.
 *
 *  - game:  the turn clock: a human's turn deadline, a CPU's think delay, or the pause before the next
 *           deal. `key` identifies the situation it was set for, so re-evaluating the same situation never
 *           resets a running turn clock.
 *  - win:   the open response window: first the moment CPUs may react ('react'), then its end ('window',
 *           when the server closes it).
 *  - clock: the round clock: the start of its final minute ('final'), then its end ('timeUp').
 *  - grace: per disconnected player, when a CPU starts covering their seat.
 *  - idle:  when the room is deleted (only set while nobody is connected).
 */

export type GameTimerKind = 'turn' | 'cpu' | 'nextRound' | 'react' | 'window' | 'final' | 'timeUp';

export interface GameTimer {
  kind: GameTimerKind;
  at: number;
  key: string;
}

export interface Schedule {
  game: GameTimer | null;
  win: GameTimer | null;
  /** optional: rooms stored before the round clock lack it */
  clock?: GameTimer | null;
  grace: Record<string, number>;
  idle: number | null;
}

export const emptySchedule = (): Schedule => ({ game: null, win: null, grace: {}, idle: null });

/** earliest due time, or null when nothing is pending */
export function nextAlarm(s: Schedule): number | null {
  let t: number | null = null;
  const take = (at: number | null | undefined) => {
    if (at !== null && at !== undefined && (t === null || at < t)) t = at;
  };
  take(s.game?.at);
  take(s.win?.at);
  take(s.clock?.at);
  for (const at of Object.values(s.grace)) take(at);
  take(s.idle);
  return t;
}

export interface DueItems {
  game: GameTimer | null;
  win: GameTimer | null;
  clock: GameTimer | null;
  grace: string[];
  idle: boolean;
}

/** what is due at `now`; the due entries are removed from the (mutated) schedule */
export function takeDue(s: Schedule, now: number): DueItems {
  const out: DueItems = { game: null, win: null, clock: null, grace: [], idle: false };
  if (s.clock && s.clock.at <= now) {
    out.clock = s.clock;
    s.clock = null;
  }
  if (s.game && s.game.at <= now) {
    out.game = s.game;
    s.game = null;
  }
  if (s.win && s.win.at <= now) {
    out.win = s.win;
    s.win = null;
  }
  for (const [pid, at] of Object.entries(s.grace)) {
    if (at <= now) {
      out.grace.push(pid);
      delete s.grace[pid];
    }
  }
  if (s.idle !== null && s.idle <= now) {
    out.idle = true;
    s.idle = null;
  }
  return out;
}

/**
 * Set a timer slot for a situation. If a timer with the same key and kind is already pending it is kept
 * (so a running deadline is not extended); returns the timer in effect.
 */
export function setTimer(s: Schedule, slot: 'game' | 'win' | 'clock', kind: GameTimerKind, at: number, key: string): { timer: GameTimer; changed: boolean } {
  const cur = s[slot] ?? null;
  if (cur && cur.key === key && cur.kind === kind) return { timer: cur, changed: false };
  const timer = { kind, at, key };
  s[slot] = timer;
  return { timer, changed: true };
}

export function setGameTimer(s: Schedule, kind: GameTimerKind, at: number, key: string): { timer: GameTimer; changed: boolean } {
  return setTimer(s, 'game', kind, at, key);
}

export function clearGameTimer(s: Schedule): void {
  s.game = null;
}

export function clearWinTimer(s: Schedule): void {
  s.win = null;
}
