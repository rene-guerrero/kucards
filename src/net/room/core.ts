/**
 * The room itself, free of any platform: lobby messages, the authoritative match, CPUs, timers and
 * per-seat redaction. The Durable Object (room.ts) wraps it with WebSockets, storage and the alarm; the
 * dev mock server (src/net/mock/room.ts) wraps it with BroadcastChannel and setTimeout, so both run the
 * very same logic.
 *
 * Game flow (advance() after every change):
 *  - a human on turn gets TURN_TIMEOUT_MS per turn; then the engine's `timeoutMove` plays for them, as in
 *    the local game ('covered', 'timeout'): the normal CPU policy with colours -> red, a pass after a draw
 *    they made themselves, and after a draw made by the timer the drawn card when playable (`afterAutoDraw`);
 *  - a CPU on turn "thinks" for a short delay; before it plays, the other CPUs may act out of turn
 *    (jump in, call ¡Ku!), as in the local game;
 *  - an open response window (round.window) gets WINDOW_MS: the CPUs at the table have one moment to
 *    react ('react'), humans may act any time; when it ends the server calls closeWindow (a CPU victim
 *    of a penalty makes its own choice instead: shield, mirror, stack or take the cards). A human victim
 *    of a penalty decides on their turn clock. A CPU on turn waits while a window is open.
 *  - the round clock (room.clock, set by the host): with a round limit the server owns the countdown
 *    (room.roundEnds, sent in 'turn' / SeatView). In the final minute every human move gets the shorter
 *    final-minute time; at zero the round ends at once with the engine's `timeUp` verdict (fewest card
 *    points wins; the clients show every hand face up for a beat first).
 *  - out-of-turn moves are first come, first served: each message is checked with legalMoves for that
 *    seat when it arrives; a late one gets 'too_late'.
 */
import type { GameEvent, MatchState, Move, Seat } from '../../contracts';
import { applyMove, closeWindow, createMatch, legalMoves, startRound, timeUp } from '../../engine/game';
import { FINAL_MS, fitThink, inFinalMinute, moveMs } from '../../engine/clock';
import { afterAutoDraw, timeoutMove } from '../../engine/ai';
import { finalRanks } from '../../engine/ranks';
import { redactEvents, seatView, snapshotFor } from '../redact';
import {
  COVER_LEVEL,
  PROTOCOL_VERSION,
  isChatId,
  type ClientMsg,
  type ErrorCode,
  type RoomInfoResponse,
  type SeatView,
  type ServerMsg,
} from '../protocol';
import { profileOf } from '../../roster';
import { cpuDecide, cpuTurnMove, isTurnMove, reactDelay, thinkDelay, validMove } from './game';
import {
  autoSeat,
  connectedHumans,
  ensureHost,
  fillSeats,
  freeSeats,
  humanCount,
  isSeat,
  isValidPlayerId,
  LobbyError,
  MAX_MEMBERS,
  newRoom,
  publicRoom,
  removeMember,
  sanitizeFace,
  sanitizeName,
  seatOf,
  setCpu,
  setMode,
  setClock,
  setRules,
  sit,
  type RoomData,
} from './lobby';
import { clearGameTimer, clearWinTimer, nextAlarm, setTimer, takeDue, type GameTimer } from './schedule';

export interface Tunables {
  turnTimeoutMs: number;
  windowMs: number;
  graceMs: number;
  idleTtlMs: number;
  nextRoundMs: number;
  cpuSpeed: number;
}

/** per-socket identity (a Durable Object keeps it with serializeAttachment, so it survives hibernation) */
export interface Attachment {
  /** playerId from the ?pid= query (null if absent; then hello decides) */
  pid: string | null;
  hello: boolean;
}

/** what the core needs from its host platform */
export interface CoreIO<S> {
  now(): number;
  random(): number;
  /** a random 32-bit seed for a new match */
  seed(): number;
  /** every open socket of the room */
  sockets(): S[];
  attachment(s: S): Attachment | null;
  setAttachment(s: S, a: Attachment): void;
  send(s: S, msg: ServerMsg): void;
  close(s: S, code: number, reason: string): void;
}

type Controller = 'human' | 'cover' | 'cpu';

export const MAX_FRAME = 4096;
/** phrases: at most one per PHRASE_GAP_MS and PHRASE_BURST per PHRASE_WINDOW_MS */
const PHRASE_GAP_MS = 1200;
const PHRASE_BURST = 5;
const PHRASE_WINDOW_MS = 20_000;
/** about how long the clients' deal animation takes (the first turn starts after it) */
export const DEAL_ANIM_MS = 4_000;

export class RoomCore<S> {
  private phraseLog = new Map<string, number[]>();

  constructor(
    private io: CoreIO<S>,
    private cfg: Tunables,
    public data: RoomData | null = null,
  ) {}

  // ───────────────────────── lifecycle ─────────────────────────

  /** a new room under `code` (false: the code is taken) */
  create(code: string, host: string | null): boolean {
    if (this.data) return false;
    const now = this.io.now();
    this.data = newRoom(code, now, host && isValidPlayerId(host) ? host : '');
    this.data.schedule.idle = now + this.cfg.idleTtlMs; // nobody ever joins → cleaned up
    return true;
  }

  info(): RoomInfoResponse {
    const r = this.data;
    return r ? { exists: true, phase: r.phase, freeSeats: freeSeats(r) } : { exists: false };
  }

  /** a socket opened (?pid= from the URL); a missing room answers room_not_found and closes */
  accept(s: S, pid: string | null): void {
    this.io.setAttachment(s, { pid: pid && isValidPlayerId(pid) ? pid : null, hello: false });
    if (!this.data) {
      this.io.send(s, { t: 'error', code: 'room_not_found' });
      this.io.close(s, 4004, 'room_not_found');
    }
  }

  nextAlarm(): number | null {
    return this.data ? nextAlarm(this.data.schedule) : null;
  }

  // ───────────────────────── sockets ─────────────────────────

  /** sockets that said hello, with their player id */
  private live(except?: S): { s: S; pid: string }[] {
    const out: { s: S; pid: string }[] = [];
    for (const s of this.io.sockets()) {
      if (s === except) continue;
      const a = this.io.attachment(s);
      if (a?.hello && a.pid) out.push({ s, pid: a.pid });
    }
    return out;
  }

  private err(s: S, code: ErrorCode, message?: string): void {
    this.io.send(s, message ? { t: 'error', code, message } : { t: 'error', code });
  }

  private broadcast(make: (pid: string, seat: Seat | null) => ServerMsg | null): void {
    const r = this.data!;
    for (const { s, pid } of this.live()) {
      const msg = make(pid, seatOf(r, pid));
      if (msg) this.io.send(s, msg);
    }
  }

  private broadcastRoom(): void {
    const room = publicRoom(this.data!);
    this.broadcast(() => ({ t: 'room', room }));
  }

  private broadcastEvents(events: GameEvent[], after: MatchState): void {
    this.broadcast((_pid, seat) => ({ t: 'events', events: redactEvents(events, seat, after), snap: snapshotFor(after, seat) }));
  }

  /** a socket closed or failed */
  socketGone(s: S): void {
    const r = this.data;
    if (!r) return;
    const a = this.io.attachment(s);
    if (!a?.hello || !a.pid) return;
    const pid = a.pid;
    const m = r.members[pid];
    if (!m || !m.connected) return;
    if (this.live(s).some((x) => x.pid === pid)) return; // another socket of theirs is open
    const now = this.io.now();
    m.connected = false;
    r.schedule.grace[pid] = now + this.cfg.graceMs;
    if (connectedHumans(r).length === 0) r.schedule.idle = now + this.cfg.idleTtlMs;
    this.broadcastRoom();
    this.advance();
  }

  // ───────────────────────── messages ─────────────────────────

  message(s: S, raw: unknown): void {
    if (typeof raw !== 'string' || raw.length > MAX_FRAME) return this.err(s, 'bad_request', 'frame');
    let msg: ClientMsg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return this.err(s, 'bad_request', 'json');
    }
    if (!msg || typeof msg !== 'object' || typeof (msg as { t?: unknown }).t !== 'string') return this.err(s, 'bad_request');
    if (msg.t === 'ping') {
      this.io.send(s, { t: 'pong', at: typeof msg.at === 'number' ? msg.at : 0, serverNow: this.io.now() });
      return;
    }
    const r = this.data;
    if (!r) {
      this.io.send(s, { t: 'error', code: 'room_not_found' });
      this.io.close(s, 4004, 'room_not_found');
      return;
    }
    const att = this.io.attachment(s) ?? { pid: null, hello: false };
    try {
      if (msg.t === 'hello') this.onHello(s, att, msg);
      else {
        if (!att.hello || !att.pid || !r.members[att.pid]) return this.err(s, 'bad_request', 'say hello first');
        this.onMessage(s, att.pid, msg);
      }
    } catch (e) {
      if (e instanceof LobbyError) this.err(s, e.code, e.message);
      else {
        console.error('room error', e);
        this.err(s, 'bad_request', 'internal');
      }
    }
  }

  private onHello(s: S, att: Attachment, msg: Extract<ClientMsg, { t: 'hello' }>): void {
    const r = this.data!;
    if (msg.v !== PROTOCOL_VERSION) {
      this.err(s, 'version_mismatch', `server speaks v${PROTOCOL_VERSION}`);
      this.io.close(s, 4000, 'version_mismatch');
      return;
    }
    const pid = msg.playerId;
    if (!isValidPlayerId(pid) || (att.pid && att.pid !== pid) || (att.hello && att.pid !== pid)) {
      this.err(s, 'bad_request', 'bad playerId');
      return;
    }
    const now = this.io.now();
    let m = r.members[pid];
    if (!m) {
      if (Object.keys(r.members).length >= MAX_MEMBERS || freeSeats(r) === 0) {
        this.err(s, 'room_full');
        this.io.close(s, 4003, 'room_full');
        return;
      }
      m = { playerId: pid, name: '', face: 0, connected: false, cpuCovering: false, joinedAt: now };
      r.members[pid] = m;
      if (autoSeat(r, pid) === null && r.phase === 'playing') {
        delete r.members[pid];
        this.err(s, 'room_full');
        this.io.close(s, 4003, 'room_full');
        return;
      }
    }
    m.name = sanitizeName(msg.name);
    m.face = sanitizeFace(msg.face);
    m.connected = true;
    m.cpuCovering = false;
    delete r.schedule.grace[pid];
    r.schedule.idle = null;
    if (!r.hostId || !r.members[r.hostId]) r.hostId = pid;
    ensureHost(r);

    // older sockets of the same player are replaced
    for (const x of this.live(s)) if (x.pid === pid) {
      this.io.setAttachment(x.s, { pid, hello: false });
      this.io.close(x.s, 4001, 'replaced');
    }
    // a returning player takes their seat back from the covering CPU (new turn clock if it is theirs)
    this.advance();
    // this socket is now the player's
    this.io.setAttachment(s, { pid, hello: true });

    const seat = seatOf(r, pid);
    const room = publicRoom(r);
    this.io.send(s, { t: 'welcome', you: { playerId: pid, seat, isHost: r.hostId === pid }, room, view: this.viewFor(pid) });
    for (const x of this.live(s)) {
      this.io.send(x.s, { t: 'room', room });
      const turn = this.turnMsgFor(x.pid);
      if (turn) this.io.send(x.s, turn);
    }
  }

  private onMessage(s: S, pid: string, msg: ClientMsg): void {
    const r = this.data!;
    switch (msg.t) {
      case 'sit':
        if (msg.seat !== null && !isSeat(msg.seat)) throw new LobbyError('bad_request');
        sit(r, pid, msg.seat);
        this.broadcastRoom();
        return;
      case 'setCpu':
        setCpu(r, pid, msg.seat, msg.characterId ?? null);
        this.broadcastRoom();
        return;
      case 'setMode':
        setMode(r, pid, msg.mode, msg.playerCount, msg.teamPlay === true);
        this.broadcastRoom();
        return;
      case 'setRules':
        setRules(r, pid, msg.rules);
        this.broadcastRoom();
        return;
      case 'setClock':
        setClock(r, pid, msg.clock);
        this.broadcastRoom();
        return;
      case 'start':
      case 'rematch':
        this.startMatch(pid);
        return;
      case 'move':
        return this.onMove(s, pid, msg.move);
      case 'phrase':
        return this.onPhrase(s, pid, msg.id);
      case 'leave':
        removeMember(r, pid, () => this.io.random());
        delete r.schedule.grace[pid];
        if (connectedHumans(r).length === 0) r.schedule.idle = this.io.now() + this.cfg.idleTtlMs;
        this.io.setAttachment(s, { pid, hello: false });
        this.io.close(s, 1000, 'left');
        this.broadcastRoom();
        this.advance(true);
        return;
      default:
        throw new LobbyError('bad_request', 'unknown message');
    }
  }

  private startMatch(pid: string): void {
    const r = this.data!;
    if (r.hostId !== pid) throw new LobbyError('not_host');
    if (r.phase === 'playing') throw new LobbyError('bad_request', 'already playing');
    // the host stood up and nobody sits: put the host back at the table
    if (humanCount(r) === 0 && seatOf(r, pid) === null) autoSeat(r, pid);
    fillSeats(r, () => this.io.random());
    const players = (r.mode === 'sideBySide' ? 4 : r.playerCount) as 2 | 3 | 4;
    r.match = createMatch(r.rules, { mode: r.mode, players, teams: !!r.teamPlay, partnerSide: 'after' }, this.io.seed());
    if (r.clock) r.match.clock = { ...r.clock };
    r.phase = 'playing';
    r.win = null;
    for (const m of Object.values(r.members)) m.cpuCovering = !m.connected && seatOf(r, m.playerId) !== null;
    this.broadcastRoom();
    this.commit(startRound(r.match));
  }

  private onMove(s: S, pid: string, raw: Move): void {
    const r = this.data!;
    const m = r.match;
    const round = m?.round;
    const seat = seatOf(r, pid);
    if (r.phase !== 'playing' || !m || !round || round.over || seat === null) return this.err(s, 'not_your_turn');
    const mv = validMove(m, seat, raw);
    if (!mv) {
      const kind = (raw as { kind?: unknown } | null)?.kind;
      const turnLike = seat === round.turn && typeof kind === 'string' && isTurnMove({ kind } as Move);
      return this.err(s, turnLike ? 'bad_move' : 'too_late');
    }
    this.commit(applyMove(m, mv));
  }

  private onPhrase(s: S, pid: string, id: string): void {
    const r = this.data!;
    const seat = seatOf(r, pid);
    if (seat === null || !isChatId(id)) return this.err(s, 'bad_request');
    const now = this.io.now();
    const log = (this.phraseLog.get(pid) ?? []).filter((t) => now - t < PHRASE_WINDOW_MS);
    if ((log.length && now - log[log.length - 1] < PHRASE_GAP_MS) || log.length >= PHRASE_BURST) {
      this.phraseLog.set(pid, log);
      return this.err(s, 'rate_limited');
    }
    log.push(now);
    this.phraseLog.set(pid, log);
    this.broadcast(() => ({ t: 'phrase', seat, id }));
  }

  // ───────────────────────── game flow ─────────────────────────

  private controller(seat: Seat): Controller {
    const r = this.data!;
    const slot = r.seats[seat];
    if (!slot || slot.kind !== 'human') return 'cpu';
    const m = r.members[slot.playerId];
    // a dropped player keeps their turn clock during the grace period; after it a CPU covers them
    return m && !m.cpuCovering ? 'human' : 'cover';
  }

  private profile(seat: Seat): { level: ReturnType<typeof profileOf>['level']; style?: ReturnType<typeof profileOf>['style'] } {
    const slot = this.data!.seats[seat];
    return slot?.kind === 'cpu' ? profileOf(slot.characterId) : { level: COVER_LEVEL };
  }

  /** a CPU (or the cover CPU) decides for `seat` */
  private decide(seat: Seat, turn: boolean): Move | null {
    const m = this.data!.match!;
    const p = this.profile(seat);
    return turn ? cpuTurnMove(m, seat, p.level, p.style) : cpuDecide(m, seat, p.level, p.style);
  }

  /** take an engine transition: new state, redacted events to everyone, then the next timers */
  private commit(res: { match: MatchState; events: GameEvent[] }, cover?: { seat: Seat; reason: 'timeout' | 'disconnected' }): void {
    const r = this.data!;
    r.match = res.match;
    r.step++;
    r.turnNo += res.events.filter((e) => e.type === 'turn').length;
    if (res.events.some((e) => e.type === 'deal')) {
      r.busyUntil = this.io.now() + DEAL_ANIM_MS * Math.min(1, this.cfg.cpuSpeed);
      // the round clock starts after the deal animation
      r.roundEnds = r.clock?.roundMin ? r.busyUntil + r.clock.roundMin * 60_000 : null;
    }
    if (res.match.round?.over) {
      r.roundEnds = null;
      r.schedule.clock = null;
    }
    if (cover) this.broadcast(() => ({ t: 'covered', seat: cover.seat, reason: cover.reason }));
    if (res.events.length) this.broadcastEvents(res.events, res.match);
    if (res.match.round?.over) {
      if (res.match.over) r.phase = 'finished';
      this.broadcastRoom(); // scores (and phase)
    }
    this.advance(true);
  }

  private play(move: Move, cover?: { seat: Seat; reason: 'timeout' | 'disconnected' }): void {
    this.commit(applyMove(this.data!.match!, move), cover);
  }

  /** seats a CPU plays right now */
  private cpuSeats(): Seat[] {
    const m = this.data!.match!;
    return m.seats.filter((s) => this.controller(s) !== 'human');
  }

  /** moves `seat` may make out of its turn right now */
  private outOfTurn(seat: Seat): Move[] {
    const m = this.data!.match!;
    const legal = legalMoves(m, seat);
    return seat === m.round?.turn ? legal.filter((x) => !isTurnMove(x)) : legal;
  }

  private shuffled<T>(xs: T[]): T[] {
    const a = xs.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.io.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  /** CPUs may act out of turn (catch a missed ¡Ku!, jump in, shield, call ¡Ku!); true when one did */
  private cpuReactions(except: Seat | null): boolean {
    const m = this.data!.match!;
    for (const s of this.shuffled(this.cpuSeats())) {
      if (s === except || !this.outOfTurn(s).length) continue;
      const mv = this.decide(s, false);
      if (!mv || (s === m.round?.turn && isTurnMove(mv))) continue;
      this.play(mv, this.controller(s) === 'cover' ? { seat: s, reason: 'disconnected' } : undefined);
      return true;
    }
    return false;
  }

  /** alarm: everything that is due */
  alarm(): 'deleted' | void {
    const r = this.data;
    if (!r) return;
    const now = this.io.now();
    const due = takeDue(r.schedule, now);
    if (due.idle && connectedHumans(r).length === 0 && this.live().length === 0) {
      this.data = null;
      return 'deleted';
    }
    let roomChanged = false;
    for (const pid of due.grace) {
      const m = r.members[pid];
      if (!m || m.connected) continue;
      if (r.phase === 'playing' && seatOf(r, pid) !== null) m.cpuCovering = true;
      roomChanged = true;
    }
    if (due.grace.length && ensureHost(r)) roomChanged = true;
    if (roomChanged) this.broadcastRoom();
    if (due.clock) this.onClockTimer(due.clock);
    if (due.game) this.onGameTimer(due.game);
    if (due.win) this.onWinTimer(due.win);
    this.advance();
  }

  /** ms left on the round clock (null = no limit) */
  private roundLeft(): number | null {
    const ends = this.data!.roundEnds;
    return ends === null || ends === undefined ? null : Math.max(0, ends - this.io.now());
  }

  /** the time a human move gets right now (the final minute is shorter) */
  private moveTime(): number {
    const c = this.data!.clock;
    return c ? moveMs(c, this.roundLeft()) : this.cfg.turnTimeoutMs;
  }

  /** the round clock: its final minute starts (advance() shortens the turn clock) or it ran out */
  private onClockTimer(t: GameTimer): void {
    const r = this.data!;
    const m = r.match;
    const round = m?.round;
    if (r.phase !== 'playing' || !m || !round || round.over) return;
    if (t.kind === 'timeUp' && t.key === `${round.roundNo}:up`) this.commit(timeUp(m));
  }

  private onGameTimer(t: GameTimer): void {
    const r = this.data!;
    const m = r.match;
    if (r.phase !== 'playing' || !m) return;
    if (t.kind === 'nextRound') {
      if (t.key === `${r.step}:next` && !m.over && (!m.round || m.round.over)) this.commit(startRound(m));
      return;
    }
    const round = m.round;
    if (!round || round.over) return;
    const seat = round.turn;
    if (t.kind === 'turn') {
      if (t.key !== `${r.turnNo}:${seat}:human` && t.key !== `${r.turnNo}:${seat}:human:f`) return; // stale
      const mv = timeoutMove(m, seat);
      if (mv) {
        this.play(mv, { seat, reason: 'timeout' });
        // a draw made by the timer: the drawn card is played when it can be
        const next = mv.kind === 'draw' ? afterAutoDraw(this.data!.match!, seat) : null;
        if (next) this.play(next, { seat, reason: 'timeout' });
      } else if (round.window) this.commit(closeWindow(m));
      return;
    }
    if (t.kind === 'cpu') {
      if (!t.key.startsWith(`${r.step}:${seat}:`) || round.window) return; // stale
      // the other CPUs may react first (jump in, call ¡Ku!), as in the local game
      if (this.cpuReactions(seat)) return;
      const cover = this.controller(seat) === 'cover' ? { seat, reason: 'disconnected' as const } : undefined;
      // a non-turn move first (calling ¡Ku!), then the turn move right away
      for (let i = 0; i < 3; i++) {
        const cur = this.data!.match!;
        if (cur.round?.over || cur.round?.turn !== seat || cur.round.window) return;
        const choice = this.decide(seat, false);
        const mv = choice ?? this.decide(seat, true);
        if (!mv) return;
        this.play(mv, cover);
        if (isTurnMove(mv)) return;
      }
    }
  }

  private onWinTimer(t: GameTimer): void {
    const r = this.data!;
    const m = r.match;
    const round = m?.round;
    if (r.phase !== 'playing' || !m || !round || round.over || !round.window || !r.win) return;
    if (!t.key.startsWith(`${r.win.id}:`)) return; // another window
    if (t.kind === 'react') {
      r.win.reacted = true;
      this.cpuReactions(null);
      return;
    }
    if (t.kind === 'window') {
      const w = round.window;
      const victim = w.reason === 'penalty' && w.victim === round.turn ? w.victim : null;
      if (victim !== null && this.controller(victim) !== 'human') {
        // a CPU victim chooses: shield, mirror, stack, challenge or take the cards
        const mv = this.decide(victim, true);
        if (mv) return this.play(mv, this.controller(victim) === 'cover' ? { seat: victim, reason: 'disconnected' } : undefined);
      }
      this.commit(closeWindow(m));
    }
  }

  /**
   * Make sure the right timers are pending for the current situation and, after a change (`force`) or
   * when the turn clock changed, tell everyone the state (whose turn, deadlines, their legal moves).
   */
  private advance(force = false): void {
    const r = this.data!;
    const m = r.match;
    const sch = r.schedule;
    if (r.phase !== 'playing' || !m || m.over || connectedHumans(r).length === 0) {
      // nobody connected: the table waits (no CPU-vs-CPU games burning alarms)
      clearGameTimer(sch);
      clearWinTimer(sch);
      return;
    }
    const now = Math.max(this.io.now(), r.busyUntil ?? 0);
    const sp = this.cfg.cpuSpeed;
    const round = m.round;
    if (!round || round.over) {
      clearWinTimer(sch);
      r.win = null;
      setTimer(sch, 'game', 'nextRound', now + this.cfg.nextRoundMs, `${r.step}:next`);
      return;
    }
    let changed = false;
    const seat = round.turn;
    const ctl = this.controller(seat);
    const w = round.window;
    const victimTurn = !!w && w.reason === 'penalty' && w.victim === seat;

    // ── the response window ──
    if (w) {
      const id = `${round.roundNo}:${w.reason}:${w.victim ?? ''}`;
      if (!r.win || r.win.id !== id) r.win = { id, ends: now + this.cfg.windowMs, reacted: false };
      const reactors = !r.win.reacted && this.cpuSeats().some((s) => !(victimTurn && s === seat) && this.outOfTurn(s).length > 0);
      if (reactors) changed = setTimer(sch, 'win', 'react', Math.min(now + reactDelay(sp, () => this.io.random()), r.win.ends - 50), `${id}:react`).changed || changed;
      else if (victimTurn && ctl === 'human') clearWinTimer(sch); // the human victim decides on their turn clock
      else changed = setTimer(sch, 'win', 'window', r.win.ends, `${id}:window`).changed || changed;
    } else {
      clearWinTimer(sch);
      r.win = null;
    }

    // ── the round clock ──
    const ends = r.roundEnds ?? null;
    if (ends !== null) {
      if (this.io.now() < ends - FINAL_MS) changed = setTimer(sch, 'clock', 'final', ends - FINAL_MS, `${round.roundNo}:final`).changed || changed;
      else changed = setTimer(sch, 'clock', 'timeUp', ends, `${round.roundNo}:up`).changed || changed;
    } else sch.clock = null;
    const final = !!r.clock && inFinalMinute(r.clock, this.roundLeft());

    // ── the turn clock ──
    if (ctl === 'human') {
      // the final minute: a running turn shrinks to the final-minute move time (never grows)
      const base = `${r.turnNo}:${seat}:human`;
      const ms = this.moveTime();
      const g = sch.game;
      const at = final && g?.kind === 'turn' && g.key === base ? Math.min(g.at, now + ms) : now + ms;
      changed = setTimer(sch, 'game', 'turn', at, final ? `${base}:f` : base).changed || changed;
    }
    else if (w) clearGameTimer(sch); // a CPU on turn waits for the window (a CPU victim decides when it closes)
    else {
      const n = legalMoves(m, seat).filter(isTurnMove).length;
      let think = thinkDelay(n, sp, () => this.io.random());
      if (r.clock) think = fitThink(think, r.clock, this.roundLeft()); // CPUs think inside the move time
      changed = setTimer(sch, 'game', 'cpu', now + think, `${r.step}:${seat}:${ctl}`).changed || changed;
    }
    if (force || changed) this.broadcast((pid) => this.turnMsgFor(pid));
  }

  /** deadlines as `pid` should see them */
  private deadlines(): { deadline: number | null; windowEnds: number | null } {
    const r = this.data!;
    const round = r.match?.round;
    const g = r.schedule.game;
    const deadline = g && g.kind === 'turn' ? g.at : null;
    let windowEnds: number | null = null;
    if (round?.window && r.win) {
      const victimTurn = round.window.reason === 'penalty' && round.window.victim === round.turn && this.controller(round.turn) === 'human';
      windowEnds = victimTurn ? deadline : r.win.ends;
    }
    return { deadline, windowEnds };
  }

  /** the current 'turn' message as `pid` should see it (null when no round is in progress) */
  private turnMsgFor(pid: string): ServerMsg | null {
    const r = this.data!;
    const m = r.match;
    const round = m?.round;
    if (r.phase !== 'playing' || !m || !round || round.over || m.over) return null;
    const mySeat = seatOf(r, pid);
    const legal = mySeat !== null && this.controller(mySeat) === 'human' ? legalMoves(m, mySeat) : [];
    // the final minute: who holds the fewest card points (clients cannot see the other hands)
    const final = !!r.clock && inFinalMinute(r.clock, this.roundLeft());
    const ranks = final ? finalRanks(m) : undefined;
    return { t: 'turn', seat: round.turn, legal, ...this.deadlines(), roundEnds: r.roundEnds ?? null, moveMs: this.moveTime(), ...(ranks ? { ranks } : {}) };
  }

  private viewFor(pid: string): SeatView | null {
    const r = this.data!;
    const seat = seatOf(r, pid);
    if (seat === null || !r.match || r.phase === 'lobby') return null;
    const round = r.match.round;
    const live = r.phase === 'playing' && !!round && !round.over;
    const legal = live && this.controller(seat) === 'human' ? legalMoves(r.match, seat) : [];
    const d = this.deadlines();
    return { ...seatView(r.match, seat, legal, live ? d.deadline : null, live ? d.windowEnds : null), roundEnds: live ? (r.roundEnds ?? null) : null, moveMs: this.moveTime() };
  }
}
