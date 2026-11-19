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
 */
import type { Card, Color, Difficulty, EngineApi, GameEvent, Lineup, MatchState, Move, PlayStyle, Seat, TableView } from '../contracts';
import type { RoundSummaryCtx, MatchEndCtx } from '../ui/summary';
import type { HudPlayer, KuState, ResponseChoice, ResponseOpts, ScoreRow } from '../ui/hud';
import type { FaceSpec } from '../roster';
import { cardPoints } from '../engine/cards';

/** what the controller needs from the HUD (src/ui/hud.ts Hud implements it) */
export interface GameHud {
  onKu: (() => void) | null;
  setPlayers(list: HudPlayer[]): void;
  setRound(n: number): void;
  setTarget(n: number | null): void;
  setScores(rows: ScoreRow[], bump?: boolean): void;
  setActiveColor(c: Color | null): void;
  setDirection(d: 1 | -1): void;
  setPending(n: number): void;
  setKu(state: KuState): void;
  pickColor(): Promise<Color>;
  pickTarget(seats: Seat[], title?: string): Promise<Seat>;
  kuPop(name?: string): Promise<void>;
  showResponse(o: ResponseOpts): Promise<ResponseChoice>;
  notice(text: string): void;
  closeAll(): void;
}

export interface GameUi {
  hud: GameHud;
  /** speech bubble over a seat */
  say(seat: Seat, text: string, strong: boolean): void;
  /** card phrase for an event (plates.bubbleFor) */
  bubbleFor(ev: GameEvent): { seat: Seat; text: string; strong: boolean } | null;
  avatarEvent(ev: GameEvent): void;
  /** a seat that can be caught for a missed ¡Ku! (its avatar becomes the tap target); null = none */
  catchable?(seat: Seat | null, onCatch: () => void): void;
  roundSummary(ctx: RoundSummaryCtx): Promise<'next' | 'menu'>;
  matchEnd(ctx: MatchEndCtx): Promise<'rematch' | 'menu'>;
  t(key: 'game.passHint' | 'game.acceptHint' | 'game.catchHint' | 'game.giveHint' | 'game.pickSwapColor' | 'hud.pickSwap' | 'team.a' | 'team.b', p?: Record<string, string | number>): string;
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
  clearSave?(): void;
  /** the player chose Menú at a summary, or the match was quit */
  onExit(): void;
  sleep?(ms: number): Promise<void>;
  random?(): number;
}

const TURN_KINDS = new Set(['play', 'draw', 'pass', 'acceptPenalty', 'respond', 'challenge']);
const isTurnMove = (m: Move) => TURN_KINDS.has(m.kind);

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

  constructor(match: MatchState, o: ControllerOpts) {
    this.match = match;
    this.o = o;
    for (const p of o.players) this.bySeat.set(p.seat, p);
    this.prevScores = match.seats.map((s) => match.scores[s]);
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.rnd = o.random ?? Math.random;
    o.ui.hud.onKu = () => this.onKuTap();
  }

  /** play until the match ends or the player leaves. `restored`: the view already shows the saved round */
  async run(restored = false): Promise<void> {
    try {
      if (restored) this.refreshHud();
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
    this.o.view.cancelHumanPick();
    this.o.ui.hud.closeAll();
    this.setPaused(false);
  }

  setPaused(p: boolean): void {
    this.paused = p;
    this.o.view.setPaused(p);
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
    this.o.save?.(match, this.o.lineup);
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
      await view.handle(ev);
      this.refreshHud(ev.type === 'roundEnd');
    }
  }

  private refreshHud(bump = false): void {
    const { hud } = this.o.ui;
    const r = this.match.round;
    if (r) {
      hud.setActiveColor(r.activeColor);
      hud.setDirection(r.direction);
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
    if (p === null || !this.o.view.setOpenHand) return;
    const open = this.match.rules.partnerOpen !== false && !!r && !r.over;
    this.o.view.setOpenHand(p, open ? r!.hands[p].slice() : null);
  }

  scoreRows(): ScoreRow[] {
    const m = this.match;
    if (m.teams) {
      const mine = m.teams[0].includes(0) ? 0 : 1;
      return m.teams.map((team, i) => ({ label: this.o.ui.t(i === 0 ? 'team.a' : 'team.b'), value: m.scores[team[0]], me: i === mine, team: i as 0 | 1 }));
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
    const res = this.o.engine.startRound(this.match);
    this.match = res.match;
    this.prevScores = this.match.seats.map((s) => this.match.scores[s]);
    const r = this.match.round!;
    this.o.view.setDeck?.([...r.deck, ...r.discard, ...r.hands.flat()]);
    const target = Number(this.match.rules.target) || 0;
    this.o.ui.hud.setTarget(target || null);
    this.o.save?.(this.match, this.o.lineup);
    await this.present(res.events);
  }

  /** summary after a round; false = the player left for the menu */
  private async afterRound(): Promise<boolean> {
    const m = this.match;
    const r = m.round!;
    const target = Number(m.rules.target) || 0;
    const winner = (r.discard.length ? this.roundWinner() : 0) as Seat;
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
          return { name: this.o.ui.t(i === 0 ? 'team.a' : 'team.b'), prev: p.prev, total: p.total };
        }) as RoundSummaryCtx['teams']
      : undefined;
    this.o.ui.hud.setKu('hidden');
    const choice = await this.o.ui.roundSummary({ roundNo: r.roundNo, winner, points, players, teams, target: target || null, matchOver: m.over });
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
        const side = !!m.teams && (m.teams[0].includes(1) || m.teams[0].includes(3));
        this.match = this.o.engine.createMatch(
          m.rules,
          { mode: m.mode, players: m.seats.length as 2 | 3 | 4, seating: m.teams ? (side ? 'side' : 'across') : undefined, partnerSide: side ? (m.teams![0].includes(3) ? 'before' : 'after') : undefined },
          Date.now(),
        );
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
    this.o.onExit();
  }

  // ───────────────────────── turns ─────────────────────────

  private async humanTurn(): Promise<void> {
    const { engine, view, ui } = this.o;
    const m = this.match;
    const r = m.round!;
    const legal = engine.legalMoves(m, 0).filter(isTurnMove);
    if (!legal.length) {
      // nothing on turn (e.g. a window waiting): let the timer close it
      await this.sleep(400);
      return this.closeWindow();
    }
    // a penalty aimed at the human that can be answered: shield / mirror / challenge bar
    const responds = legal.filter((x): x is Extract<Move, { kind: 'respond' }> => x.kind === 'respond');
    const challenge = legal.find((x) => x.kind === 'challenge');
    if (responds.length || challenge) {
      const kindOf = (id: number) => r.hands[0].find((c) => c.id === id)?.face.kind;
      const shield = responds.find((x) => kindOf(x.cardId) === 'shield');
      const mirror = responds.find((x) => kindOf(x.cardId) === 'mirror');
      const choice = await ui.hud.showResponse({ total: r.pendingDraw, canShield: !!shield, canMirror: !!mirror, canChallenge: !!challenge, ms: 8000 });
      if (this.stopped || this.match !== m) return;
      const mv = choice === 'shield' ? shield : choice === 'mirror' ? mirror : choice === 'challenge' ? challenge : undefined;
      if (mv) return this.act(mv);
      // 'accept': unless a penalty card can still be stacked, take the cards now
      const acc = legal.find((x) => x.kind === 'acceptPenalty');
      if (acc && !legal.some((x) => x.kind === 'play')) return this.act(acc);
    }
    const plays = legal.filter((x): x is Extract<Move, { kind: 'play' }> => x.kind === 'play');
    const playable = [...new Set(plays.map((p) => p.cardId))];
    const drawLike = legal.find((x) => x.kind === 'draw' || x.kind === 'pass' || x.kind === 'acceptPenalty');
    if (r.drewThisTurn && drawLike?.kind === 'pass') ui.hud.notice(ui.t('game.passHint'));
    // nothing playable: the pyramid over the deck is the only hint
    if (r.pendingDraw > 0 && playable.length) ui.hud.notice(ui.t('game.acceptHint', { n: r.pendingDraw }));
    const pick = await view.requestHumanPick(playable, !!drawLike);
    if (this.stopped || this.match !== m) return;
    if (pick === 'draw') {
      if (drawLike) await this.act(drawLike);
      return;
    }
    let variants = plays.filter((p) => p.cardId === pick);
    if (!variants.length) return;
    // swap: first the player, then the colour; wilds: the colour; 7-0: the player
    if (variants.some((v) => v.target !== undefined)) {
      const targets = [...new Set(variants.map((v) => v.target!))] as Seat[];
      const target = await ui.hud.pickTarget(targets, ui.t('hud.pickSwap'));
      variants = variants.filter((v) => v.target === target);
    }
    if (variants.some((v) => v.color)) {
      // the card lands on the pile first, then the colour is asked
      await view.previewPlay?.(pick);
      if (this.stopped || this.match !== m) return;
      const color = await ui.hud.pickColor();
      if (this.stopped || this.match !== m) return;
      variants = variants.filter((v) => v.color === color);
    }
    // partnerPass: on a 7 the human may give one card to the partner
    let mv: Move | undefined = variants[0];
    const giveIds = mv && this.o.giveOptions ? this.o.giveOptions(m, mv) : [];
    if (mv && giveIds.length) {
      ui.hud.notice(ui.t('game.giveHint'));
      const g = await view.requestHumanPick(giveIds, true);
      if (typeof g === 'number') mv = { ...(mv as Extract<Move, { kind: 'play' }>), give: g };
    }
    if (!mv || this.stopped || this.match !== m) return;
    await this.act(mv);
  }

  private async cpuTurn(seat: Seat): Promise<void> {
    const { engine, view } = this.o;
    const m = this.match;
    const pace = this.o.pace ?? 1;
    const think = (520 + this.rnd() * 420) * pace;

    // Parejas with partnerShield: the human may shield the partner from a penalty
    const myResponds = engine.legalMoves(m, 0).filter((x): x is Extract<Move, { kind: 'respond' }> => x.kind === 'respond');
    if (myResponds.length) {
      const r = m.round!;
      const kindOf = (id: number) => r.hands[0].find((c) => c.id === id)?.face.kind;
      const shield = myResponds.find((x) => kindOf(x.cardId) === 'shield');
      const mirror = myResponds.find((x) => kindOf(x.cardId) === 'mirror');
      const choice = await this.o.ui.hud.showResponse({ total: r.pendingDraw, canShield: !!shield, canMirror: !!mirror, ms: 4000 * pace });
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
      this.o.save?.(match, this.o.lineup);
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
