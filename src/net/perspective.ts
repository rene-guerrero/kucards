/**
 * Seat perspective. The whole client (renderer, HUD, plates, summaries) is built around "seat 0 = me,
 * at the bottom". The server numbers seats absolutely, so every seat- and per-seat value coming from it
 * is rotated here (and my moves rotated back). Ported from Kudominoes.
 *
 * Mapping: the seats in play, in turn order, are laid onto the local seats of the same count
 * (SEATS_FOR[n]) starting with me at local 0, so the turn order and the usual table layout are kept
 * (4 players: a plain rotation; 3 players: bottom / right / left; 2 players: bottom / top). Team indices
 * are kept as they are (the team lists are rotated), so `teams[i]` means the same pair on both sides.
 */
import type { GameEvent, MatchState, Move, ResponseWindow, RoundState, Seat } from '../contracts';
import { SEATS_FOR } from './protocol';

type N = 2 | 3 | 4;
const ALL: Seat[] = [0, 1, 2, 3, 4, 5];

export class Perspective {
  /** local seat of each server seat */
  private loc: Seat[] = ALL.slice();
  /** server seat of each local seat */
  private srv: Seat[] = ALL.slice();
  /** server seats in play, in turn order */
  readonly seats: Seat[];

  constructor(
    readonly me: Seat,
    seats: readonly Seat[],
  ) {
    const active = (seats.length ? seats.slice() : [0, 1, 2, 3]) as Seat[];
    active.sort((a, b) => a - b);
    this.seats = active;
    const n = Math.max(2, Math.min(4, active.length)) as N;
    const k = Math.max(0, active.indexOf(me));
    const target = SEATS_FOR[n];
    const used = new Set<number>();
    active.forEach((s, i) => {
      this.loc[s] = target[(i - k + n) % n];
      used.add(s);
    });
    // seats not in play: any bijection onto the free local seats
    const freeLocal = ALL.filter((l) => !target.includes(l));
    for (const s of ALL) if (!used.has(s)) this.loc[s] = freeLocal.shift() ?? s;
    for (const s of ALL) this.srv[this.loc[s]] = s;
  }

  /** server seat → local seat */
  seat = (s: Seat): Seat => this.loc[s] ?? s;
  /** local seat → server seat */
  server = (l: Seat): Seat => this.srv[l] ?? l;

  localSeats(): Seat[] {
    return this.seats.map(this.seat).sort((a, b) => a - b);
  }

  /** a per-seat array (index = seat) re-indexed by local seat */
  perSeat<T>(arr: readonly T[]): T[] {
    return ALL.slice(0, Math.max(arr.length, 0)).map((l) => arr[this.srv[l]]);
  }

  private seatList = (s: readonly Seat[]): Seat[] => s.map(this.seat).sort((a, b) => a - b);

  teams(t: [Seat[], Seat[]] | null | undefined): [Seat[], Seat[]] | undefined {
    return t ? [this.seatList(t[0]), this.seatList(t[1])] : undefined;
  }

  private window(w: ResponseWindow | null): ResponseWindow | null {
    if (!w) return null;
    const out: ResponseWindow = { ...w, seats: this.seatList(w.seats) };
    if (w.victim !== undefined) out.victim = this.seat(w.victim);
    return out;
  }

  move(m: Move): Move {
    const out = { ...m, seat: this.seat(m.seat) } as Move & { target?: Seat };
    if ('target' in m && m.target !== undefined) out.target = this.seat(m.target);
    return out;
  }

  moveToServer(m: Move): Move {
    const out = { ...m, seat: this.server(m.seat) } as Move & { target?: Seat };
    if ('target' in m && m.target !== undefined) out.target = this.server(m.target);
    return out;
  }

  event(ev: GameEvent): GameEvent {
    switch (ev.type) {
      case 'deal':
        return { ...ev, counts: this.perSeat(ev.counts), starter: this.seat(ev.starter) };
      case 'play':
      case 'draw':
      case 'skip':
      case 'shield':
      case 'sweep':
      case 'ku':
      case 'eliminated':
      case 'turn':
        return { ...ev, seat: this.seat(ev.seat) };
      case 'mirror':
        return { ...ev, from: this.seat(ev.from), to: this.seat(ev.to) };
      case 'swapHands':
        return { ...ev, a: this.seat(ev.a), b: this.seat(ev.b) };
      case 'kuCaught':
        return { ...ev, by: this.seat(ev.by), target: this.seat(ev.target) };
      case 'window':
        return { ...ev, window: this.window(ev.window) };
      case 'roundEnd':
        return { ...ev, winner: this.seat(ev.winner), points: this.perSeat(ev.points) };
      case 'matchEnd':
        return { ...ev, winner: ev.winner === null ? null : this.seat(ev.winner) };
      default:
        return ev;
    }
  }

  round(r: RoundState): RoundState {
    const out: RoundState & { mirrorVictim?: Seat | null } = {
      ...r,
      hands: this.perSeat(r.hands),
      kuCalled: this.perSeat(r.kuCalled),
      eliminated: this.perSeat(r.eliminated),
      turn: this.seat(r.turn),
      pendingFrom: r.pendingFrom === null ? null : this.seat(r.pendingFrom),
      window: this.window(r.window),
    };
    const mv = (r as { mirrorVictim?: Seat | null }).mirrorVictim;
    if (mv !== undefined && mv !== null) out.mirrorVictim = this.seat(mv);
    if (r.outPoints) out.outPoints = this.perSeat(r.outPoints);
    return out;
  }

  match(m: MatchState): MatchState {
    return {
      ...m,
      seats: this.seatList(m.seats),
      scores: this.perSeat(m.scores),
      teams: this.teams(m.teams),
      winner: m.winner === null ? null : this.seat(m.winner),
      round: m.round ? this.round(m.round) : null,
    };
  }
}
