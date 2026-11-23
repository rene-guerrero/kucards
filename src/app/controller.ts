/**
 * The offline game loop: the human (seat 0) against CPU characters. It owns the MatchState and glues
 * the pure engine to the 3D table (TableView), the HUD and the plates/avatars.
 *
 * - Every move goes through `act()`, which runs moves one at a time (a promise chain), checks them
 *   against `legalMoves`, applies them and plays their events in order. So a ¡Ku! tap or a CPU catch can
 *   arrive at any moment without racing the turn loop.
 * - CPU seats "think" for a short delay. During that delay the other CPUs may react out of turn (catch
 *   a missed ¡Ku!, jump in), and the human may jump in by tapping an identical card.
 * - The ¡Ku! button is armed whenever the human may call ¡Ku! (2 cards or fewer) or catch someone who
 *   forgot; one tap does whichever applies (catching first).
 * - The match is saved after every move (src/app/save.ts) so "Continuar" works after the app closes.
 * - The human has a turn timer (the clock's move time, as online; ring on their plate; pause stops it). When it
 *   runs out the engine's `timeoutMove` plays for them (normal CPU policy, colours -> red); a draw made by
 *   the timer is followed by `afterAutoDraw` (the drawn card is played when it can be). A draw the player
 *   made themselves is never played by the timer: it passes.
 * - Clocks (src/engine/clock.ts, picked on the new-game screen): the move time replaces the fixed turn
 *   time; with a round limit a countdown runs in the HUD (paused with the game). In its final minute
 *   every move gets the shorter final-minute time, the countdown turns urgent and the music frantic.
 *   At zero the round ends at once: every hand is shown face up for a beat, then the engine's `timeUp`
 *   verdict (fewest card points wins) is scored as any round end.
 */
import type { Card, Color, Difficulty, EngineApi, GameEvent, Lineup, MatchSetup, MatchState, Move, PlayStyle, Seat, TableView } from '../contracts';
import { colorSlot, COLORS, NIGHT_COLORS, isNightColor } from '../contracts';
import type { RoundSummaryCtx, MatchEndCtx } from '../ui/summary';
import type { HudPlayer, KuState, ResponseChoice, ResponseOpts, ScoreRow } from '../ui/hud';
import type { FaceSpec } from '../roster';
import { cardPoints } from '../engine/cards';
import { penaltyOf, timeUpWinner } from '../engine/game';
import { finalRanks } from '../engine/ranks';
import { afterAutoDraw, AUTO_COLOR, timeoutMove } from '../engine/ai';
import { DEFAULT_CLOCK, fitThink, inFinalMinute, moveMs, sanitizeClock, type ClockSettings } from '../engine/clock';
import { voiceForEvent, VOICE_DELAY_MS } from '../audio/voice';
import { powerSfxForEvent } from '../audio/sfx';
import { t, type Key } from '../ui/i18n';

/** what the controller needs from the HUD (src/ui/hud.ts Hud implements it) */
export interface GameHud {
  onKu: (() => void) | null;
  /** another player's colour choice on the colour diamond (display only) */
  showColorChoice?(chosen: Color, colors?: readonly Color[]): Promise<void>;
  setPlayers(list: HudPlayer[]): void;
  setRound(n: number): void;
  setTarget(n: number | null): void;
  setScores(rows: ScoreRow[], bump?: boolean): void;
  setPending(n: number): void;
  setKu(state: KuState): void;
  /** colours: the ones to offer (Día y Noche: the side in play); default the day colours */
  pickColor(colors?: readonly Color[]): Promise<Color>;
  pickTarget(seats: Seat[], title?: string): Promise<Seat>;
  kuPop(name?: string): Promise<void>;
  showResponse(o: ResponseOpts): Promise<ResponseChoice>;
  /** a non-dismissable question in the response bar's place; resolves `onTimeout` when time runs out */
  askChoice?<T extends string>(o: { title: string; options: { id: T; label: string; cls?: string }[]; ms: number; onTimeout: T }): Promise<T>;
  notice(text: string): void;
  closeAll(): void;
  /** the round countdown (ms left; null hides it); urgent = the final minute */
  setClock?(msLeft: number | null, urgent: boolean): void;
}

export interface GameUi {
  hud: GameHud;
  /** speech bubble over a seat */
  say(seat: Seat, text: string, strong: boolean): void;
  /** card phrase for an event (plates.bubbleFor) */
  bubbleFor(ev: GameEvent): { seat: Seat; text: string; strong: boolean } | null;
  avatarEvent(ev: GameEvent): void;
  /** music mood: 'frenzy' in the round's final minute (src/audio/sfx.ts setMusicMode) */
  musicMode?(m: 'normal' | 'frenzy'): void;
  /** final-minute position badge on a seat's avatar (Plates.setRank); null = none */
  rank?(seat: Seat, n: number | null): void;
  /** the turn-timer ring on a plate (Plates.setTimer); null seat = none */
  setTimer?(seat: Seat | null, endsAt?: number, total?: number): void;
  /** a seat that can be caught for a missed ¡Ku! (its avatar becomes the tap target); null = none */
  catchable?(seat: Seat | null, onCatch: () => void): void;
  roundSummary(ctx: RoundSummaryCtx): Promise<'next' | 'menu'>;
  matchEnd(ctx: MatchEndCtx): Promise<'rematch' | 'menu'>;
  t(key: 'game.acceptHint' | 'game.autoDraw' | 'game.catchHint' | 'game.giveHint' | 'game.pickSwapColor' | 'hud.pickSwap' | 'hud.drawnPlayable' | 'hud.drawnPlay' | 'hud.drawnPass' | 'team.a' | 'team.b', p?: Record<string, string | number>): string;
}

export interface SeatInfo {
  seat: Seat;
  name: string;
  face: FaceSpec;
  /** CPU level; undefined for the human */
  level?: Difficulty;
  style?: PlayStyle;
}

/** TableView plus the renderer's extras (src/render/index.ts TableViewExt) */
export type GameView = TableView & {
  setDeck?(cards: readonly Card[]): void;
  restore?: TableView['restore'];
  /** the human's colour-changing card onto the pile before the colour pane opens (resolves when it lands) */
  previewPlay?(cardId: number): Promise<void>;
  /** undo a previewPlay that was not followed by the play */
  cancelPreview?(): void;
};

export interface ControllerOpts {
  engine: EngineApi;
  view: GameView;
  ui: GameUi;
  players: SeatInfo[];
  lineup: Lineup;
  /** CPU think time multiplier (fast animations → shorter) */
  pace?: number;
  save?(match: MatchState, lineup: Lineup): void;
  /** partnerPass: the cards seat may give its partner with this play (engine giveOptions) */
  giveOptions?(match: MatchState, move: Move): number[];
  /** multiPlay: the cards that may join this play (engine multiPlayOptions) */
  multiPlayOptions?(match: MatchState, move: Move): number[];
  clearSave?(): void;
  /** the player chose Menú at a summary, or the match was quit */
  onExit(): void;
  sleep?(ms: number): Promise<void>;
  random?(): number;
  /** the human's turn time in ms (overrides the clock's move time; 0 = no timer) */
  turnMs?: number;
  /** round limit and move times (default: match.clock, else no limit and 30 s moves) */
  clock?: ClockSettings;
}

/** beat before an unanswerable penalty is drawn for the human (offline and online) */
export const AUTO_DRAW_MS = 900;
const TURN_KINDS = new Set(['play', 'draw', 'pass', 'acceptPenalty', 'respond', 'challenge']);
const isTurnMove = (m: Move) => TURN_KINDS.has(m.kind);

/** multiPlay: by playable card id, the cards that may go down with it (null when none may) */
export function joinableFor(m: MatchState, plays: Extract<Move, { kind: 'play' }>[], options: (m: MatchState, mv: Move) => number[]): Record<number, number[]> | null {
  const out: Record<number, number[]> = {};
  let any = false;
  for (const p of plays) {
    if (p.cardId in out) continue;
    const ids = options(m, p);
    if (ids.length) {
      out[p.cardId] = ids;
      any = true;
    }
  }
  return any ? out : null;
}

function sameMove(a: Move, b: Move): boolean {
  if (a.kind !== b.kind || a.seat !== b.seat) return false;
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  for (const k of ['cardId', 'color', 'target', 'give']) if (x[k] !== y[k]) return false;
  return true;
}

export class GameController {
  match: MatchState;
  private o: ControllerOpts;
  private chain: Promise<void> = Promise.resolve();
  private stopped = false;
  private paused = false;
  private resumeWaiters: (() => void)[] = [];
  private bySeat = new Map<Seat, SeatInfo>();
  private sleep: (ms: number) => Promise<void>;
  private rnd: () => number;
  private lastNotice = '';
  // human turn timer
  private turnTotal = 0;
  // round clock: ms left in the round (null = no limit / no round live)
  readonly clock: ClockSettings;
  private clockLeft: number | null = null;
  private clockLast = 0;
  private clockTimer: ReturnType<typeof setInterval> | null = null;
  private frenzy = false;
  /** a time-up resolves these: the human's open prompt is dropped */
  private abortWaiters: (() => void)[] = [];
  /** re-runs the pending human deadline check after the deadline moved */
  private rearm: (() => void) | null = null;
  private turnNo = 0;
  private turnKey = '';
  private deadline = 0;
  private pausedLeft: number | null = null;
  private timerHandle: ReturnType<typeof setTimeout> | null = null;
  private ringOn = false;
  /** bumped whenever a human turn prompt is dropped (timeout / new prompt): stale prompts do nothing */
  private gen = 0;

  constructor(match: MatchState, o: ControllerOpts) {
    this.match = match;
    this.o = o;
    // dev builds: the running offline game, for checks in the browser console
    if (import.meta.env?.DEV && typeof window !== 'undefined') (window as unknown as { __kucaGame: unknown }).__kucaGame = this;
    for (const p of o.players) this.bySeat.set(p.seat, p);
    this.prevScores = match.seats.map((s) => match.scores[s]);
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.rnd = o.random ?? Math.random;
    this.clock = sanitizeClock(o.clock ?? match.clock ?? DEFAULT_CLOCK);
    o.ui.hud.onKu = () => this.onKuTap();
  }

  /** play until the match ends or the player leaves. `restored`: the view already shows the saved round */
  async run(restored = false): Promise<void> {
    try {
      if (restored) {
        this.refreshHud();
        // continue the round clock where it was saved
        if (this.match.round && !this.match.round.over) this.startClock(this.match.clockLeftMs);
      }
      while (!this.stopped) {
        await this.chain;
        await this.waitResume();
        if (this.stopped) return;
        const m = this.match;
        const r = m.round;
        if (!r || r.over) {
          if (r?.over && !(await this.afterRound())) return;
          if (this.stopped) return;
          await this.startRound();
          continue;
        }
        if (r.turn === 0) await this.humanTurn();
        else await this.cpuTurn(r.turn);
      }
    } catch (e) {
      if (!this.stopped) throw e;
    }
  }

  stop(): void {
    this.stopped = true;
    this.stopClock();
    this.o.ui.musicMode?.('normal');
    this.disarm();
    this.o.view.cancelHumanPick();
    this.o.ui.hud.closeAll();
    this.setPaused(false);
  }

  setPaused(p: boolean): void {
    this.paused = p;
    this.o.view.setPaused(p);
    // pausing (also the app going to the background) saves the round clock where it stands
    if (p && this.match.round && !this.match.round.over) this.persist(this.match);
    // the turn timer stands still while paused
    if (p && this.ringOn && this.pausedLeft === null) {
      this.pausedLeft = Math.max(0, this.deadline - Date.now());
      this.o.ui.setTimer?.(null);
    } else if (!p && this.pausedLeft !== null) {
      this.deadline = Date.now() + this.pausedLeft;
      this.pausedLeft = null;
      if (this.ringOn) this.o.ui.setTimer?.(0, this.deadline, this.turnTotal);
    }
    if (!p) {
      const w = this.resumeWaiters;
      this.resumeWaiters = [];
      w.forEach((f) => f());
    }
  }

  private waitResume(): Promise<void> {
    return this.paused ? new Promise((r) => this.resumeWaiters.push(r)) : Promise.resolve();
  }

  private name(s: Seat): string {
    return this.bySeat.get(s)?.name ?? '';
  }

  // ───────────────────────── moves ─────────────────────────

  /** queue a move; it is applied only if still legal when its turn in the queue comes */
  act(move: Move): Promise<void> {
    this.chain = this.chain.then(() => this.apply(move));
    return this.chain;
  }

  private async apply(move: Move): Promise<void> {
    if (this.stopped) return;
    const legal = this.o.engine.legalMoves(this.match, move.seat);
    const bare = move.kind === 'play' && move.give !== undefined ? { ...move, give: undefined } : move;
    const ok = legal.find((l) => sameMove(l, bare));
    if (!ok) return;
    const { match, events } = this.o.engine.applyMove(this.match, move);
    this.match = match;
    this.persist(match);
    await this.present(events);
  }

  private async present(events: GameEvent[]): Promise<void> {
    const { ui, view } = this.o;
    for (const ev of events) {
      if (this.stopped) return;
      ui.avatarEvent(ev);
      const b = ui.bubbleFor(ev);
      if (b) ui.say(b.seat, b.text, b.strong);
      if (ev.type === 'ku') void ui.hud.kuPop(this.name(ev.seat));
      if (ev.type === 'turn' || ev.type === 'deal') this.turnNo++;
      if (ev.type === 'roundEnd') this.stopClock();
      // "Draw N!" starts as the drawing starts; the others once their card has landed
      if (ev.type === 'draw') voiceForEvent(ev, 60);
      if (ev.type === 'deal') view.setRuleBadges?.(this.match.rules);
      await view.handle(ev);
      powerSfxForEvent(ev);
      // another player's wild: their pick shows on the colour diamond before play goes on
      if (ev.type === 'play' && ev.seat !== 0 && ev.color && ev.card.face.color === null) await ui.hud.showColorChoice?.(ev.color, isNightColor(ev.color) ? NIGHT_COLORS : COLORS);
      if (ev.type !== 'draw') voiceForEvent(ev, VOICE_DELAY_MS);
      if (this.frenzy) this.refreshRanks();
      this.refreshHud(ev.type === 'roundEnd');
    }
  }

  private refreshHud(bump = false): void {
    const { hud } = this.o.ui;
    const r = this.match.round;
    if (r) {
      hud.setPending(r.pendingDraw);
      hud.setRound(r.roundNo);
    }
    hud.setScores(this.scoreRows(), bump);
    this.refreshKu();
    this.revealPartner();
  }

  /** the human's partner (Parejas), or null */
  partnerSeat(): Seat | null {
    const team = this.match.teams?.find((t) => t.includes(0));
    return (team?.find((s) => s !== 0) as Seat | undefined) ?? null;
  }

  /** Parejas with partnerOpen (default on): the partner's hand is shown face up */
  private revealPartner(): void {
    const p = this.partnerSeat();
    const r = this.match.round;
    const view = this.o.view;
    if (!view.setOpenHand || !r) return;
    if (r.over) {
      // round over: the partner's hand stays face up and the opponents' cards turn face up too
      for (const st of this.match.seats) if (st !== 0 && r.hands[st].length) view.setOpenHand(st, r.hands[st].slice());
      return;
    }
    // during play: only the partner is shown (Parejas with partnerOpen); everyone else face down
    for (const st of this.match.seats) if (st !== 0 && st !== p) view.setOpenHand(st, null);
    if (p === null) return;
    const open = this.match.rules.partnerOpen !== false;
    view.setOpenHand(p, open ? r.hands[p].slice() : null);
  }

  scoreRows(): ScoreRow[] {
    const m = this.match;
    if (m.teams) {
      const mine = m.teams[0].includes(0) ? 0 : 1;
      return m.teams.map((team, i) => ({ label: this.o.ui.t(team.includes(0) ? 'team.a' : 'team.b'), value: m.scores[team[0]], me: i === mine, team: i as 0 | 1 }));
    }
    return m.seats.map((s) => ({ label: this.name(s), value: m.scores[s], me: s === 0 }));
  }

  // ───────────────────────── ¡Ku! ─────────────────────────

  private kuMoves(): { catchMv?: Move; callMv?: Move } {
    const legal = this.o.engine.legalMoves(this.match, 0);
    return { catchMv: legal.find((m) => m.kind === 'catchKu'), callMv: legal.find((m) => m.kind === 'callKu') };
  }

  private refreshKu(): void {
    const r = this.match.round;
    const { hud } = this.o.ui;
    if (!r || r.over || !this.match.rules.kuCall) {
      this.o.ui.catchable?.(null, () => {});
      return hud.setKu('hidden');
    }
    const { catchMv, callMv } = this.kuMoves();
    this.o.ui.catchable?.(catchMv && catchMv.kind === 'catchKu' ? catchMv.target : null, () => this.onKuTap());
    if (catchMv && catchMv.kind === 'catchKu') {
      const note = this.o.ui.t('game.catchHint', { name: this.name(catchMv.target) });
      if (note !== this.lastNotice) hud.notice((this.lastNotice = note));
    } else this.lastNotice = '';
    hud.setKu(catchMv || callMv ? 'armed' : r.hands[0].length <= 2 ? 'shown' : 'hidden');
  }

  private onKuTap(): void {
    const { catchMv, callMv } = this.kuMoves();
    const mv = catchMv ?? callMv;
    if (mv) void this.act(mv);
  }

  // ───────────────────────── rounds ─────────────────────────

  private async startRound(): Promise<void> {
    if (!this.match.clock) this.match = { ...this.match, clock: this.clock }; // kept in the save / rematch
    const res = this.o.engine.startRound(this.match);
    this.match = res.match;
    this.prevScores = this.match.seats.map((s) => this.match.scores[s]);
    const r = this.match.round!;
    this.o.view.setDeck?.([...r.deck, ...r.discard, ...r.hands.flat()]);
    const target = Number(this.match.rules.target) || 0;
    this.o.ui.hud.setTarget(target || null);
    this.persist(this.match);
    this.stopClock();
    await this.present(res.events);
    this.startClock();
  }

  // ───────────────────────── round clock ─────────────────────────

  /** the time a move gets right now (the final minute is shorter) */
  moveTime(): number {
    return this.o.turnMs ?? moveMs(this.clock, this.clockLeft);
  }

  /** ms left in the round (null = no limit or no round live) */
  /** save the match with the round time left, so a restored game continues the clock */
  private persist(m: MatchState): void {
    this.o.save?.(this.clockLeft === null ? m : { ...m, clockLeftMs: Math.round(this.clockLeft) }, this.o.lineup);
  }

  get roundLeft(): number | null {
    return this.clockLeft;
  }

  /** start the round countdown (ms: time left, default the full limit); public for tests */
  startClock(ms?: number): void {
    this.stopClock();
    if (!this.clock.roundMin || this.stopped) return;
    this.clockLeft = ms ?? this.clock.roundMin * 60_000;
    this.clockLast = Date.now();
    this.clockTimer = setInterval(() => this.tickClock(Date.now()), 250);
    this.tickClock(this.clockLast);
  }

  private stopClock(): void {
    if (this.clockTimer) clearInterval(this.clockTimer);
    this.clockTimer = null;
    this.clockLeft = null;
    this.abortWaiters = [];
    this.o.ui.hud.setClock?.(null, false);
    this.setFrenzy(false);
  }

  private setFrenzy(on: boolean): void {
    if (this.frenzy === on) return;
    this.frenzy = on;
    this.o.ui.musicMode?.(on ? 'frenzy' : 'normal');
    this.refreshRanks();
  }

  /** final minute: badge the seats (teams) with the fewest card points; off otherwise */
  private refreshRanks(): void {
    const set = this.o.ui.rank;
    if (!set) return;
    const ranks = new Map(this.frenzy ? finalRanks(this.match) : []);
    for (const s of this.match.seats) set(s, ranks.get(s) ?? null);
  }

  /** advance the round clock to `now` (time paused does not count); public for tests */
  tickClock(now: number): void {
    if (this.clockLeft === null) return;
    const dt = Math.max(0, now - this.clockLast);
    this.clockLast = now;
    if (!this.paused && this.match.round && !this.match.round.over) this.clockLeft = Math.max(0, this.clockLeft - dt);
    const final = inFinalMinute(this.clock, this.clockLeft);
    if (final && !this.frenzy) {
      this.setFrenzy(true);
      // a running human turn shrinks to the final-minute move time
      if (this.ringOn) {
        const ms = this.moveTime();
        if (this.pausedLeft !== null) this.pausedLeft = Math.min(this.pausedLeft, ms);
        else if (this.deadline > now + ms) {
          this.deadline = now + ms;
          this.turnTotal = ms;
          this.o.ui.setTimer?.(0, this.deadline, ms);
          if (this.timerHandle) clearTimeout(this.timerHandle);
          this.timerHandle = null;
          this.rearm?.();
        }
      }
    }
    this.o.ui.hud.setClock?.(this.clockLeft, final);
    if (this.clockLeft <= 0) {
      if (this.clockTimer) clearInterval(this.clockTimer);
      this.clockTimer = null;
      void this.onTimeUp();
    }
  }

  /** the round's time ran out: drop any prompt, show every hand for a beat, then the verdict */
  private onTimeUp(): Promise<void> {
    const { view, ui, engine } = this.o;
    this.gen++;
    this.disarm();
    view.cancelHumanPick();
    view.cancelPreview?.();
    ui.hud.closeAll();
    const w = this.abortWaiters;
    this.abortWaiters = [];
    w.forEach((f) => f());
    this.chain = this.chain.then(async () => {
      const r = this.match.round;
      if (this.stopped || !r || r.over) return;
      for (const s of this.match.seats) if (s !== 0 && r.hands[s].length) view.setOpenHand?.(s, r.hands[s].slice());
      await this.sleep(1100);
      if (this.stopped || this.match.round !== r) return;
      const { match, events } = engine.timeUp(this.match);
      this.match = match;
      this.persist(match);
      await this.present(events);
    });
    return this.chain;
  }

  /** summary after a round; false = the player left for the menu */
  private async afterRound(): Promise<boolean> {
    const m = this.match;
    const r = m.round!;
    const target = Number(m.rules.target) || 0;
    const winner = (r.endedBy === 'time' ? timeUpWinner(m, r) : r.discard.length ? this.roundWinner() : 0) as Seat;
    const prevScores = this.prevScores ?? m.seats.map(() => 0);
    const players = m.seats.map((s) => {
      const info = this.bySeat.get(s)!;
      const hand = r.hands[s];
      return {
        seat: s, name: info.name, face: info.face, cardsLeft: hand.length,
        handPoints: hand.reduce((t, c) => t + cardPoints(c.face), 0),
        prev: prevScores[m.seats.indexOf(s)] ?? 0, total: m.scores[s],
        team: m.teams ? ((m.teams[0].includes(s) ? 0 : 1) as 0 | 1) : undefined,
        eliminated: r.eliminated[s],
      };
    });
    const points = Math.max(0, m.scores[winner] - (players.find((p) => p.seat === winner)?.prev ?? 0));
    const teams: RoundSummaryCtx['teams'] = m.teams
      ? [0, 1].map((i) => {
          const p = players.find((x) => x.seat === m.teams![i][0])!;
          return { name: this.o.ui.t(m.teams![i].includes(0) ? 'team.a' : 'team.b'), prev: p.prev, total: p.total };
        }) as RoundSummaryCtx['teams']
      : undefined;
    this.o.ui.hud.setKu('hidden');
    const choice = await this.o.ui.roundSummary({ roundNo: r.roundNo, winner, points, players, teams, target: target || null, matchOver: m.over, byTime: r.endedBy === 'time' });
    if (this.stopped) return false;
    if (choice === 'menu') {
      this.leave();
      return false;
    }
    if (m.over) {
      const end = await this.o.ui.matchEnd({
        winner: m.winner, winnerTeam: m.winnerTeam ?? undefined, teams,
        players: players.map(({ seat, name, face, total, team }) => ({ seat, name, face, total, team })),
      });
      this.o.clearSave?.();
      if (end === 'rematch' && !this.stopped) {
        // Reuse the original setup: rebuilding it from m.mode (the custom mode's *base*) would turn a
        // custom side-by-side match into across seating and hand the human a different partner.
        const setup: MatchSetup = m.setup ?? {
          mode: m.mode,
          players: m.seats.length as 2 | 3 | 4,
          teams: !!m.teams,
          swappedSeats: false,
        };
        this.match = this.o.engine.createMatch(m.rules, setup, Date.now());
        if (m.clock) this.match.clock = { ...m.clock };
        this.o.view.reset();
        return true;
      }
      this.leave();
      return false;
    }
    return true;
  }

  private prevScores: number[] | null = null;

  /** the seat that won the round that just ended (no cards left, or the best hand when blocked) */
  private roundWinner(): Seat {
    const m = this.match;
    const r = m.round!;
    const active = m.seats.filter((s) => !r.eliminated[s]);
    const empty = active.find((s) => r.hands[s].length === 0);
    if (empty !== undefined) return empty;
    if (active.length === 1) return active[0];
    const pts = (s: Seat) => r.hands[s].reduce((t, c) => t + cardPoints(c.face), 0);
    return active.reduce((a, b) => (pts(b) < pts(a) ? b : a));
  }

  private leave(): void {
    this.stopped = true;
    this.stopClock();
    this.o.onExit();
  }

  // ───────────────────────── turns ─────────────────────────

  private async humanTurn(): Promise<void> {
    const m = this.match;
    const r = m.round!;
    if (!this.o.engine.legalMoves(m, 0).some(isTurnMove)) {
      // nothing on turn (e.g. a window waiting): let the timer close it
      await this.sleep(400);
      return this.closeWindow();
    }
    const g = ++this.gen;
    // a time-up drops the prompt (the picker's promise never resolves then)
    const aborted = new Promise<'abort'>((res) => this.abortWaiters.push(() => res('abort')));
    const ms = this.moveTime();
    if (ms <= 0) {
      await Promise.race([this.humanChoice(g), aborted]);
      return;
    }
    // one deadline per turn: a draw that keeps the turn does not restart it
    const key = `${r.roundNo}:${this.turnNo}`;
    if (key !== this.turnKey) {
      this.turnKey = key;
      this.deadline = Date.now() + ms;
      this.turnTotal = ms;
      this.pausedLeft = null;
    }
    this.ringOn = true;
    if (!this.paused) this.o.ui.setTimer?.(0, this.deadline, this.turnTotal);
    try {
      const res = await Promise.race([this.humanChoice(g).then(() => 'done' as const), this.timeout(g), aborted]);
      if (res === 'timeout' && !this.stopped && this.match === m) await this.onTimeout();
    } finally {
      if (this.gen === g) this.disarm();
    }
  }

  /** resolves when the human's deadline passes (time paused does not count) */
  private timeout(g: number): Promise<'timeout'> {
    return new Promise((resolve) => {
      const tick = () => {
        this.timerHandle = null;
        this.rearm = tick;
        if (g !== this.gen || this.stopped) return;
        if (this.paused) return void this.resumeWaiters.push(tick);
        const left = this.deadline - Date.now();
        if (left <= 0) return resolve('timeout');
        this.timerHandle = setTimeout(tick, left);
      };
      tick();
    });
  }

  private disarm(): void {
    if (this.timerHandle) clearTimeout(this.timerHandle);
    this.timerHandle = null;
    if (this.ringOn) this.o.ui.setTimer?.(null);
    this.ringOn = false;
  }

  /** the human's time ran out: drop the prompt and play for them */
  private async onTimeout(): Promise<void> {
    const { view, ui } = this.o;
    this.gen++;
    this.disarm();
    view.cancelHumanPick();
    view.cancelPreview?.();
    ui.hud.closeAll();
    const mv = timeoutMove(this.match, 0);
    if (!mv) return;
    await this.act(mv);
    // a draw made by the timer: the drawn card is played when it can be
    if (mv.kind === 'draw') {
      const next = afterAutoDraw(this.match, 0);
      if (next) await this.act(next);
    }
  }

  private async humanChoice(g: number): Promise<void> {
    const { engine, view, ui } = this.o;
    const m = this.match;
    const r = m.round!;
    const gone = () => this.stopped || this.match !== m || this.gen !== g;
    const legal = engine.legalMoves(m, 0).filter(isTurnMove);
    // a penalty aimed at the human that can be answered: shield / mirror / challenge / stack bar
    const responds = legal.filter((x): x is Extract<Move, { kind: 'respond' }> => x.kind === 'respond');
    const challenge = legal.find((x) => x.kind === 'challenge');
    const stackMoves = r.pendingDraw > 0 ? legal.filter((x): x is Extract<Move, { kind: 'play' }> => x.kind === 'play') : [];
    const stacks = [...new Set(stackMoves.map((p) => p.cardId))].map((cardId) => {
      const c = r.hands[0].find((x) => x.id === cardId)!;
      const color = c.face.color ? ` ${t(`color.${c.face.color}` as Key)}` : '';
      return { cardId, label: t('hud.stack', { card: `+${penaltyOf(c.face)}${color}` }), face: c.face };
    });
    let forcedStack: number | null = null;
    if (responds.length || challenge || stacks.length) {
      const kindOf = (id: number) => r.hands[0].find((c) => c.id === id)?.face.kind;
      const shield = responds.find((x) => kindOf(x.cardId) === 'shield');
      const mirror = responds.find((x) => kindOf(x.cardId) === 'mirror');
      // stacking is mandatory: when a stack is possible there is no draw button
      const acc = legal.find((x) => x.kind === 'acceptPenalty');
      const choice = await ui.hud.showResponse({ total: r.pendingDraw, canShield: !!shield, canMirror: !!mirror, canChallenge: !!challenge, stacks, canAccept: !!acc, ms: 8000 });
      if (gone()) return;
      if (typeof choice === 'object') {
        if (stacks.some((x) => x.cardId === choice.stack)) forcedStack = choice.stack;
      } else {
        const mv = choice === 'shield' ? shield : choice === 'mirror' ? mirror : choice === 'challenge' ? challenge : undefined;
        if (mv) return this.act(mv);
      }
      if (forcedStack === null && acc) return this.act(acc);
    }
    // a penalty the human cannot stack, challenge or answer: drawn for them after a short beat
    if (legal.length === 1 && legal[0].kind === 'acceptPenalty') {
      await this.sleep(AUTO_DRAW_MS);
      if (gone()) return;
      return this.act(legal[0]);
    }
    const plays = legal.filter((x): x is Extract<Move, { kind: 'play' }> => x.kind === 'play');
    const playable = [...new Set(plays.map((p) => p.cardId))];
    const drawLike = legal.find((x) => x.kind === 'draw' || x.kind === 'pass' || x.kind === 'acceptPenalty');
    // nothing playable: the pyramid over the deck is the only hint
    if (forcedStack === null && r.pendingDraw > 0 && playable.length) ui.hud.notice(ui.t('game.acceptHint', { n: r.pendingDraw }));
    // multiPlay: cards that other cards of the same number may join (a tap selects, a drag plays the group)
    const joinable = this.o.multiPlayOptions ? joinableFor(m, plays, this.o.multiPlayOptions) : null;
    let choice: number | 'draw' | { cardId: number; extra: number[] };
    const passMove = legal.find((x) => x.kind === 'pass');
    if (forcedStack !== null && playable.includes(forcedStack)) {
      // picked from the response bar: keep the colour/target prompts below
      choice = forcedStack;
    } else if (r.drewThisTurn && playable.length && passMove && ui.hud.askChoice) {
      // the drawn card can be played: it lifts and a question (no escape) asks; time up = it is played
      view.markCard?.(playable[0]);
      const ans = await ui.hud.askChoice({
        title: ui.t('hud.drawnPlayable'),
        options: [
          { id: 'play', label: ui.t('hud.drawnPlay'), cls: 'primary' },
          { id: 'pass', label: ui.t('hud.drawnPass'), cls: 'ghost' },
        ],
        ms: Math.max(3000, Math.min(this.moveTime() * 0.6, 10000)),
        onTimeout: 'play',
      });
      view.markCard?.(null);
      if (gone()) return;
      if (ans === 'pass') return this.act(passMove);
      choice = playable[0];
    } else {
      choice = joinable && view.requestHumanMultiPick ? await view.requestHumanMultiPick(playable, !!drawLike, joinable) : await view.requestHumanPick(playable, !!drawLike);
    }
    if (gone()) return;
    if (choice === 'draw') {
      if (drawLike) await this.act(drawLike);
      return;
    }
    const pick = typeof choice === 'number' ? choice : choice.cardId;
    const extra = typeof choice === 'number' ? [] : choice.extra;
    let variants = plays.filter((p) => p.cardId === pick);
    if (!variants.length) return;
    // swap: first the player, then the colour; wilds: the colour; 7-0: the player
    if (variants.some((v) => v.target !== undefined)) {
      const targets = [...new Set(variants.map((v) => v.target!))] as Seat[];
      const target = await ui.hud.pickTarget(targets, ui.t('hud.pickSwap'));
      if (gone()) return;
      variants = variants.filter((v) => v.target === target);
    }
    if (variants.some((v) => v.color) && r.hands[0].length === 1) {
      // the winning last card: red, no colour pane
      variants = variants.filter((v) => v.color === AUTO_COLOR || (!!v.color && colorSlot(v.color) === colorSlot(AUTO_COLOR)));
    } else if (variants.some((v) => v.color)) {
      // the card lands on the pile first, then the colour is asked
      await view.previewPlay?.(pick);
      if (gone()) return;
      const color = await ui.hud.pickColor([...new Set(variants.map((v) => v.color!).filter(Boolean))]);
      if (gone()) return;
      variants = variants.filter((v) => v.color === color);
    }
    // partnerPass: on a 7 the human may give one card to the partner
    let mv: Move | undefined = variants[0] && extra.length ? { ...variants[0], extra } : variants[0];
    const giveIds = mv && this.o.giveOptions ? this.o.giveOptions(m, mv) : [];
    if (mv && giveIds.length) {
      ui.hud.notice(ui.t('game.giveHint'));
      const gv = await view.requestHumanPick(giveIds, true);
      if (gone()) return;
      if (typeof gv === 'number') mv = { ...(mv as Extract<Move, { kind: 'play' }>), give: gv };
    }
    if (!mv || gone()) return;
    await this.act(mv);
  }

  private async cpuTurn(seat: Seat): Promise<void> {
    const { engine, view } = this.o;
    const m = this.match;
    const pace = this.o.pace ?? 1;
    // CPUs think well inside the move time (also the shorter final-minute one)
    const think = fitThink((520 + this.rnd() * 420) * pace, this.clock, this.clockLeft);

    // Parejas with partnerShield: the human may shield the partner from a penalty
    const myResponds = engine.legalMoves(m, 0).filter((x): x is Extract<Move, { kind: 'respond' }> => x.kind === 'respond');
    if (myResponds.length) {
      const r = m.round!;
      const kindOf = (id: number) => r.hands[0].find((c) => c.id === id)?.face.kind;
      const shield = myResponds.find((x) => kindOf(x.cardId) === 'shield');
      const mirror = myResponds.find((x) => kindOf(x.cardId) === 'mirror');
      const aborted = new Promise<null>((res) => this.abortWaiters.push(() => res(null)));
      const choice = await Promise.race([this.o.ui.hud.showResponse({ total: r.pendingDraw, canShield: !!shield, canMirror: !!mirror, canAccept: false, ms: Math.min(4000 * pace, this.moveTime() * 0.5) }), aborted]);
      const mv = choice === 'shield' ? shield : choice === 'mirror' ? mirror : undefined;
      if (mv && this.match === m) return this.act(mv);
    }

    // during the think time: the human may jump in with an identical card
    const jumps = engine.legalMoves(m, 0).filter((x) => x.kind === 'jumpIn');
    if (jumps.length) {
      const ids = jumps.map((j) => (j as Extract<Move, { kind: 'jumpIn' }>).cardId);
      const picked = await Promise.race([view.requestHumanPick(ids, false), this.sleep(think * 1.6).then(() => null)]);
      if (picked === null) view.cancelHumanPick();
      else if (typeof picked === 'number' && this.match === m) {
        const options = jumps.filter((j) => (j as Extract<Move, { kind: 'jumpIn' }>).cardId === picked) as Extract<Move, { kind: 'jumpIn' }>[];
        let mv = options[0];
        if (options.length > 1 && options.some((o) => o.target !== undefined)) {
          const target = await this.o.ui.hud.pickTarget(options.map((o) => o.target!) as Seat[], this.o.ui.t('hud.pickSwap'));
          mv = options.find((o) => o.target === target) ?? mv;
        }
        if (mv && this.match === m) return this.act(mv);
      }
    } else await this.sleep(think);
    if (this.stopped || this.match !== m) return;
    await this.waitResume();

    // other CPUs may react out of turn (catch a missed ¡Ku!, jump in, call ¡Ku!)
    const others = m.seats.filter((s) => s !== 0 && s !== seat);
    for (const s of this.shuffled(others)) {
      const mv = engine.chooseMove(this.match, s, this.bySeat.get(s)?.level ?? 'normal', this.bySeat.get(s)?.style);
      if (mv && !isTurnMove(mv)) return this.act(mv);
    }
    const mv = engine.chooseMove(this.match, seat, this.bySeat.get(seat)?.level ?? 'normal', this.bySeat.get(seat)?.style);
    if (mv) await this.act(mv);
    else await this.closeWindow();
  }

  /** a response window timed out (nobody acted) */
  private closeWindow(): Promise<void> {
    this.chain = this.chain.then(async () => {
      if (this.stopped || !this.match.round?.window) return;
      const { match, events } = this.o.engine.closeWindow(this.match);
      this.match = match;
      this.persist(match);
      await this.present(events);
    });
    return this.chain;
  }

  private shuffled<T>(xs: T[]): T[] {
    const a = xs.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.rnd() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
}
