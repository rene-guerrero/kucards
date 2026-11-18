/**
 * KuCards rules engine (phases 2 + 4). Pure: inputs are never mutated; every transition returns a new
 * MatchState plus the GameEvents to animate, in order. Randomness (reshuffles) comes only from
 * `MatchState.rng`, so a match replays exactly from its seed and its moves.
 *
 * DESIGN NOTES
 *
 * Turn flow. The seat in `round.turn` plays a matching card, or draws (`drawMode` 'one' |
 * 'untilPlayable'). If the drawn card is playable the seat stays on turn with `drewThisTurn` set and
 * `drawnCardId` = that card, and may play THAT card or `pass` (not with `forcePlay`). If it is not
 * playable the turn advances by itself. Drawing is always legal, even with playable cards in hand.
 *
 * Penalties (draw2 2, wild4 4, draw6 6, draw10 10). A penalty is aimed at the next seat (the victim).
 * The penalty stays pending (`pendingDraw`, `pendingFrom`, the victim on turn) when stacking is on, when
 * the victim may challenge it, or when someone may answer it with a shield / mirror; otherwise the
 * victim draws at once and loses the turn. A pending victim may: stack (stacking 'same' = same kind;
 * 'any' = any penalty card worth at least the top one, or a coloured one of the active colour on a wild
 * penalty), `respond`, `challenge`, or `acceptPenalty` (draws the whole stack, loses the turn).
 *
 * Response windows (`round.window`) are for things that may happen OUT of turn and need a timer:
 *  - 'ku': a seat went down to one card without calling ¡Ku! (no `ku: true` on the play and no earlier
 *    `callKu`). `window.victim` = the offender, `window.seats` = everyone else who may `catchKu`
 *    (offender draws 2). The offender may still `callKu` to close it. It also closes when the seat on
 *    turn plays / draws / passes / accepts / responds / challenges, when anybody jumps in, or on
 *    `closeWindow`.
 *  - 'penalty': a pending penalty whose victim holds a shield or mirror, or (rule `partnerShield`) whose
 *    victim's partner holds a shield (`penaltyResponders()`). `seats` = who may `respond`, `victim` = the
 *    seat on turn that draws if nobody does; `closeWindow` = the victim accepts.
 *  Only one window exists at a time (a ¡Ku! slip while a penalty window opens is forgiven).
 *
 * Shield (respond): the stack is cancelled, the shield goes UNDER the top card (top card and active
 *   colour unchanged), 'shield' event. The victim then keeps the turn as if no penalty had been played.
 * Mirror (respond, victim only): the whole stack goes back to `pendingFrom` ('mirror' event; the mirror
 *   goes under the top card); the mirroring seat becomes `pendingFrom`, so the new victim may mirror it
 *   back or shield it (no stacking, no challenge after a mirror), else draws at once. Once a penalty has
 *   been mirrored, whatever ends it (draw or shield), play resumes with the seat AFTER the original
 *   victim (`mirrorVictim`, engine-internal): the mirror used that seat's turn.
 * A response card that empties the responder's hand wins the round (a mirrored stack is drawn first).
 *
 * Challenge (`wild4Challenge`, wild4 and draw10): the victim of a pending wild penalty may `challenge`.
 *   If the player held a card of the active colour from before the wild (checked at play time, kept in
 *   the engine-internal `challenge` field), that player draws the whole pending stack and the victim
 *   keeps the turn as if no penalty; otherwise the challenger draws stack + 2 and loses the turn.
 *
 * Other power / Cyclone cards:
 *  - swap (wild): `color` + `target`; hands (and ¡Ku! flags) are swapped like a 7-0 seven.
 *  - sweep (coloured): every other card of its colour leaves the hand and goes UNDER the sweep card
 *    ('sweep' event). If that empties the hand the player wins the round outright (they never sat on one
 *    card, so no ¡Ku! is needed); if it leaves one card the ¡Ku! rules apply as for any play (`ku: true`
 *    on the sweep play is accepted whenever the sweep leaves ≤ 1 card).
 *  - skipAll: every other active seat is skipped (one 'skip' each); the player plays again.
 *  - wildColor (wild): the next seat draws one card at a time until it gets a card OF the chosen colour
 *    (wilds do not count), reshuffling as needed and stopping when nothing is left; it loses the turn.
 *    It is not a stackable penalty: no stacking, shield, mirror or challenge.
 *  - shield / mirror played on their turn are plain coloured cards.
 *  Going out on a penalty card or a wildColor still makes the next seat draw before scoring.
 *
 * Jump-in has NO window: when `jumpIn` is on, `legalMoves(match, seat)` lists a `jumpIn` for any
 * off-turn seat holding a card identical (kind + colour + number, never a wild) to the top of the pile,
 * whenever no penalty is pending. The controller polls off-turn seats; the first one applied wins and
 * play continues from the jumper as if it had played the card on its turn. A jumped-in 7 under the 7-0
 * rule swaps with its `target` (one jumpIn listed per target).
 *
 * partnerPass (Parejas, not with 7-0, which wins): a 7 play may carry `give` = one more card id that goes
 * to the partner's hand. Like `ku` it is a flag that `legalMoves` does not enumerate (see
 * `giveOptions()`); the giver must keep at least one card. Events: the 'play' of the 7, then
 * { type: 'draw', seat: partner, count: 1, cards: [given], reason: 'turn' } — the renderer takes the card
 * from the giver's hand (it directly follows that seat's 7).
 *
 * ¡Ku! flags travel with the hand (7 swap / swap card / 0 rotation) and reset when a hand grows past 2.
 * Elimination (`eliminateAt`): a seat holding N+ cards is out, its cards go under the deck; the last
 * seat (or team) standing wins the round and also scores what the eliminated seats held when they went
 * out (`round.outPoints`). A round where nobody can play and nothing can be drawn ends "blocked": the
 * seat with the fewest points in hand wins it.
 */
import type { Card, CardFace, Color, GameEvent, MatchSetup, MatchState, Move, ResponseWindow, RoundState, RuleSettings, Seat } from '../contracts';
import { COLORS } from '../contracts';
import { buildDeck, cardPoints, isWildKind, PENALTY_DRAW } from './cards';
import { Rng } from './rng';

const SEATS_FOR: Record<2 | 3 | 4, Seat[]> = { 2: [0, 2], 3: [0, 1, 3], 4: [0, 1, 2, 3] };

export function createMatch(rules: RuleSettings, setup: MatchSetup, seed = Date.now()): MatchState {
  const players = setup.mode === 'partners' ? 4 : setup.players;
  const seats = SEATS_FOR[players];
  const teams: MatchState['teams'] =
    setup.mode !== 'partners'
      ? undefined
      : (setup.seating ?? rules.seating) === 'side'
        ? setup.partnerSide === 'before'
          ? [[0, 3], [1, 2]] // Codo a codo, partner plays just before the human
          : [[0, 1], [2, 3]] // Codo a codo: A A B B, partner plays just after the human
        : [[0, 2], [1, 3]]; // Enfrente: A B A B
  return { rules: { ...rules }, mode: setup.mode, seats, scores: [0, 0, 0, 0, 0, 0], round: null, teams, over: false, winner: null, rng: seed | 0 };
}

export function shuffle<T>(xs: readonly T[], rng: Rng): T[] {
  const a = xs.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function startRound(match: MatchState): { match: MatchState; events: GameEvent[] } {
  const rng = new Rng(match.rng);
  const deck = shuffle(buildDeck(match.rules), rng);
  const handSize = Number(match.rules.handSize) || 7;
  const hands: Card[][] = [[], [], [], [], [], []];
  for (let i = 0; i < handSize; i++) for (const s of match.seats) hands[s].push(deck.pop()!);
  // the first card on the pile is a number card (others go back under the deck)
  let first = deck.pop()!;
  while (first.face.kind !== 'number') {
    deck.unshift(first);
    first = deck.pop()!;
  }
  const roundNo = (match.round?.roundNo ?? 0) + 1;
  const starter = match.seats[rng.int(match.seats.length)];
  const activeColor: Color = first.face.color ?? COLORS[0];
  const round: RoundState = {
    roundNo, seed: match.rng | 0, hands, deck, discard: [first], activeColor, turn: starter, direction: 1,
    pendingDraw: 0, pendingFrom: null, window: null, kuCalled: [false, false, false, false, false, false],
    drewThisTurn: false, drawnCardId: null, side: 'light', eliminated: [false, false, false, false, false, false], over: false,
  };
  const events: GameEvent[] = [
    { type: 'deal', counts: hands.map((h) => h.length), starter, firstCard: first, activeColor, hand: hands[0].slice(), deck: deck.length },
    { type: 'turn', seat: starter },
  ];
  return { match: { ...match, round, rng: rng.s }, events };
}

/** Can `card` go on the pile right now (turn play, no penalty pending)? */
export function matches(card: Card, top: Card, activeColor: Color): boolean {
  if (isWildKind(card.face.kind)) return true;
  if (card.face.color === activeColor) return true;
  if (card.face.kind === 'number') return top.face.kind === 'number' && card.face.value === top.face.value;
  return card.face.kind === top.face.kind;
}

/**
 * Engine-internal extra round state (optional, so a plain RoundState is still valid).
 * challenge: the last wild penalty (wild4 / draw10) under wild4Challenge: who played it, at whom, and
 *   whether its player held a card of the previous active colour.
 * mirrorVictim: once a pending penalty was mirrored, the seat it was first aimed at (play resumes after it).
 */
export interface EngineRound extends RoundState {
  challenge?: { from: Seat; victim: Seat; illegal: boolean } | null;
  mirrorVictim?: Seat | null;
}
const er = (r: RoundState): EngineRound => r as EngineRound;

// ───────────────────────── seats / teams ─────────────────────────

export const topCard = (r: RoundState): Card => r.discard[r.discard.length - 1];
export const activeSeats = (m: MatchState, r: RoundState): Seat[] => m.seats.filter((s) => !r.eliminated[s]);

/** the next non-eliminated seat after `from` in direction `dir` (from itself may be eliminated) */
export function stepSeat(m: MatchState, r: RoundState, from: Seat, dir: number = r.direction): Seat {
  const seats = m.seats;
  const n = seats.length;
  let i = seats.indexOf(from);
  for (let k = 0; k < n; k++) {
    i = (i + dir + n) % n;
    if (!r.eliminated[seats[i]]) return seats[i];
  }
  return from;
}

/** partners mode: team index of a seat; null outside partners */
export function teamOf(m: MatchState, s: Seat): 0 | 1 | null {
  if (!m.teams) return null;
  return m.teams[0].includes(s) ? 0 : 1;
}
/** partners mode: the seat's partner; null outside partners */
export function partnerOf(m: MatchState, s: Seat): Seat | null {
  const t = teamOf(m, s);
  if (t === null) return null;
  return m.teams![t].find((x) => x !== s) ?? null;
}
/** do these two seats play against each other? */
export const opponents = (m: MatchState, a: Seat, b: Seat): boolean => (m.teams ? teamOf(m, a) !== teamOf(m, b) : a !== b);

/** hands `seat` may look at: its own, plus its partner's in Parejas with `partnerOpen` (default on) */
export function visibleHands(m: MatchState, seat: Seat): Seat[] {
  const p = partnerOf(m, seat);
  return p !== null && m.rules.partnerOpen !== false ? [seat, p] : [seat];
}

export const handPoints = (hand: readonly Card[]): number => hand.reduce((t, c) => t + cardPoints(c.face), 0);

// ───────────────────────── card predicates ─────────────────────────

/** cards a penalty card makes the victim draw (0 for everything else) */
export const penaltyOf = (face: CardFace): number => face.draw ?? PENALTY_DRAW[face.kind] ?? 0;

/** stacking answer to a pending penalty (top card is the last penalty card) */
export function canStack(card: Card, r: RoundState, rules: RuleSettings): boolean {
  const mode = rules.stacking;
  if (mode !== 'same' && mode !== 'any') return false;
  if (er(r).mirrorVictim != null) return false; // a mirrored stack can only be answered with shield / mirror
  const top = topCard(r).face;
  const d = penaltyOf(card.face);
  const td = penaltyOf(top);
  if (!d || !td) return false;
  if (mode === 'same') return card.face.kind === top.kind;
  if (d >= td) return true;
  return isWildKind(top.kind) && card.face.color === r.activeColor;
}

/** may this card be played by the seat on turn right now? */
export function canPlay(card: Card, r: RoundState, rules: RuleSettings): boolean {
  if (r.pendingDraw > 0) return canStack(card, r, rules);
  return matches(card, topCard(r), r.activeColor);
}

/** jump-in: same kind, colour and number as the top card (wild-type cards never qualify) */
export function identical(card: Card, top: Card): boolean {
  const a = card.face;
  const b = top.face;
  if (isWildKind(a.kind) || a.color === null) return false;
  return a.kind === b.kind && a.color === b.color && (a.kind !== 'number' || a.value === b.value);
}

const isSevenZero = (rules: RuleSettings) => !!rules.sevenZero;
const isSeven = (c: Card) => c.face.kind === 'number' && c.face.value === 7;

function playVariants(m: MatchState, r: RoundState, seat: Seat, card: Card): Move[] {
  const base = { kind: 'play' as const, seat, cardId: card.id };
  const targets = () => activeSeats(m, r).filter((t) => t !== seat);
  if (card.face.kind === 'swap') return COLORS.flatMap((color) => targets().map((target) => ({ ...base, color, target })));
  if (isWildKind(card.face.kind)) return COLORS.map((color) => ({ ...base, color }));
  if (isSevenZero(m.rules) && isSeven(card)) return targets().map((target) => ({ ...base, target }));
  return [base];
}

function jumpInVariants(m: MatchState, r: RoundState, seat: Seat, card: Card): Move[] {
  const base = { kind: 'jumpIn' as const, seat, cardId: card.id };
  if (isSevenZero(m.rules) && isSeven(card)) {
    return activeSeats(m, r)
      .filter((t) => t !== seat)
      .map((target) => ({ ...base, target }));
  }
  return [base];
}

/** shield / mirror cards `seat` may answer the open penalty window with */
function responseCards(r: RoundState, s: Seat): Card[] {
  const w = r.window;
  if (w?.reason !== 'penalty' || !w.seats.includes(s)) return [];
  const victim = s === w.victim;
  return r.hands[s].filter((c) => c.face.kind === 'shield' || (victim && c.face.kind === 'mirror'));
}

function canChallenge(m: MatchState, r: RoundState, s: Seat): boolean {
  const c = er(r).challenge;
  return !!m.rules.wild4Challenge && !!c && c.victim === s && r.pendingDraw > 0 && er(r).mirrorVictim == null;
}

// ───────────────────────── legal moves ─────────────────────────

/**
 * Moves for `seat` (default: the seat on turn). Off-turn seats get jump-ins, ¡Ku! calls and catches,
 * and (partnerShield) shield responses. A play move may also carry `ku: true` (calling ¡Ku! with the
 * play) and, with partnerPass, `give` (see `giveOptions`); legalMoves lists neither flag.
 */
export function legalMoves(match: MatchState, seat?: Seat): Move[] {
  const r = match.round;
  if (!r || r.over || match.over) return [];
  const s = seat ?? r.turn;
  if (!match.seats.includes(s) || r.eliminated[s]) return [];
  const rules = match.rules;
  const hand = r.hands[s];
  const w = r.window;
  const out: Move[] = [];

  if (w?.reason === 'ku' && w.victim !== undefined && w.seats.includes(s)) out.push({ kind: 'catchKu', seat: s, target: w.victim });
  if (rules.kuCall && hand.length >= 1 && hand.length <= 2 && !r.kuCalled[s]) out.push({ kind: 'callKu', seat: s });

  if (s === r.turn) {
    if (r.pendingDraw > 0) {
      for (const c of hand) if (canStack(c, r, rules)) out.push(...playVariants(match, r, s, c));
      for (const c of responseCards(r, s)) out.push({ kind: 'respond', seat: s, cardId: c.id });
      if (canChallenge(match, r, s)) out.push({ kind: 'challenge', seat: s });
      out.push({ kind: 'acceptPenalty', seat: s });
    } else if (r.drewThisTurn) {
      const drawn = r.drawnCardId != null ? hand.find((c) => c.id === r.drawnCardId) : hand[hand.length - 1];
      const playable = !!drawn && canPlay(drawn, r, rules);
      if (playable) out.push(...playVariants(match, r, s, drawn));
      if (!(playable && rules.forcePlay)) out.push({ kind: 'pass', seat: s });
    } else {
      for (const c of hand) if (canPlay(c, r, rules)) out.push(...playVariants(match, r, s, c));
      out.push({ kind: 'draw', seat: s });
    }
  } else if (w?.reason === 'penalty') {
    for (const c of responseCards(r, s)) out.push({ kind: 'respond', seat: s, cardId: c.id });
  } else if (rules.jumpIn && r.pendingDraw === 0) {
    const top = topCard(r);
    for (const c of hand) if (identical(c, top)) out.push(...jumpInVariants(match, r, s, c));
  }
  return out;
}

/**
 * partnerPass: the card ids that may go to the partner with this play move as `give` (empty when the
 * move cannot carry one: not Parejas, rule off, 7-0 on, not a 7, or fewer than 3 cards in hand).
 */
export function giveOptions(match: MatchState, move: Move): number[] {
  const r = match.round;
  if (!r || move.kind !== 'play') return [];
  const rules = match.rules;
  if (!rules.partnerPass || isSevenZero(rules)) return [];
  const partner = partnerOf(match, move.seat);
  if (partner === null || r.eliminated[partner]) return [];
  const hand = r.hands[move.seat];
  const card = hand.find((c) => c.id === move.cardId);
  if (!card || !isSeven(card) || hand.length < 3) return [];
  return hand.filter((c) => c !== card).map((c) => c.id);
}

/** structural move equality, ignoring the optional `ku` / `give` flags on plays */
export function sameMove(a: Move, b: Move): boolean {
  if (a.kind !== b.kind || a.seat !== b.seat) return false;
  const x = a as Partial<Record<'cardId' | 'color' | 'target', unknown>>;
  const y = b as Partial<Record<'cardId' | 'color' | 'target', unknown>>;
  return x.cardId === y.cardId && x.color === y.color && x.target === y.target;
}

export function isLegal(match: MatchState, move: Move): boolean {
  if (!legalMoves(match, move.seat).some((l) => sameMove(l, move))) return false;
  if (move.kind === 'play' && move.give !== undefined) return giveOptions(match, move).includes(move.give);
  return true;
}

// ───────────────────────── transitions ─────────────────────────

interface St {
  m: MatchState;
  r: RoundState;
  rng: Rng;
  ev: GameEvent[];
}

function begin(match: MatchState): St {
  const src = match.round!;
  const r: RoundState = {
    ...src,
    hands: src.hands.map((h) => h.slice()),
    deck: src.deck.slice(),
    discard: src.discard.slice(),
    kuCalled: src.kuCalled.slice(),
    eliminated: src.eliminated.slice(),
    window: src.window ? { ...src.window, seats: src.window.seats.slice() } : null,
  };
  const m: MatchState = { ...match, scores: match.scores.slice(), round: r };
  return { m, r, rng: new Rng(match.rng), ev: [] };
}

function finish(st: St): { match: MatchState; events: GameEvent[] } {
  const { r } = st;
  for (let s = 0; s < r.hands.length; s++) if (r.hands[s].length > 2) r.kuCalled[s] = false;
  st.m.rng = st.rng.s;
  return { match: st.m, events: st.ev };
}

const next = (st: St, from: Seat): Seat => stepSeat(st.m, st.r, from);

function setTurn(st: St, seat: Seat): void {
  st.r.turn = seat;
  st.r.drewThisTurn = false;
  st.r.drawnCardId = null;
  st.ev.push({ type: 'turn', seat });
}

function setWindow(st: St, w: ResponseWindow | null): void {
  st.r.window = w;
  st.ev.push({ type: 'window', window: w });
}

/** discard pile (minus its top card) shuffled back into the deck; false when there is nothing to reuse */
function reshuffle(st: St): boolean {
  const { r } = st;
  if (r.discard.length <= 1) return false;
  const top = r.discard.pop()!;
  const rest = r.discard;
  r.deck = shuffle(rest, st.rng).concat(r.deck);
  r.discard = [top];
  st.ev.push({ type: 'reshuffle', count: rest.length });
  return true;
}

type DrawReason = 'turn' | 'penalty' | 'ku' | 'catch';

/**
 * draw `n` cards, or with `until` one at a time until a card satisfies it, reshuffling when the deck
 * runs out (stops when nothing is left); returns the cards
 */
function drawCards(st: St, seat: Seat, n: number, reason: DrawReason, until?: (c: Card) => boolean): Card[] {
  const { r } = st;
  const drawn: Card[] = [];
  let chunk: Card[] = [];
  const flush = () => {
    if (chunk.length) st.ev.push({ type: 'draw', seat, count: chunk.length, cards: chunk, reason });
    chunk = [];
  };
  while (until || drawn.length < n) {
    if (r.deck.length === 0) {
      flush();
      if (!reshuffle(st)) break;
    }
    const c = r.deck.pop()!;
    r.hands[seat].push(c);
    drawn.push(c);
    chunk.push(c);
    if (until?.(c)) break;
  }
  flush();
  return drawn;
}

function endRound(st: St, winner: Seat): void {
  const { m, r } = st;
  r.over = true;
  r.window = null;
  r.pendingDraw = 0;
  r.pendingFrom = null;
  er(r).challenge = null;
  er(r).mirrorVictim = null;
  const team = teamOf(m, winner);
  const winners: Seat[] = team === null ? [winner] : m.teams![team];
  let total = 0;
  const out = r.outPoints;
  for (const s of m.seats) if (!winners.includes(s)) total += handPoints(r.hands[s]) + (out?.[s] ?? 0);
  const points = [0, 0, 0, 0, 0, 0];
  for (const s of winners) {
    points[s] = total;
    m.scores[s] += total;
  }
  st.ev.push({ type: 'roundEnd', winner, points });
  const target = Number(m.rules.target) || 0;
  if (target === 0 || winners.some((s) => m.scores[s] >= target)) {
    m.over = true;
    m.winner = winner;
    if (team !== null) m.winnerTeam = team;
    st.ev.push(team === null ? { type: 'matchEnd', winner } : { type: 'matchEnd', winner, winnerTeam: team });
  }
}

/** a blocked round goes to the seat holding the fewest points */
function endBlocked(st: St): void {
  const act = activeSeats(st.m, st.r);
  let best = act[0];
  for (const s of act) if (handPoints(st.r.hands[s]) < handPoints(st.r.hands[best])) best = s;
  endRound(st, best);
}

/** nobody can play and nothing can be drawn */
function isStuck(st: St): boolean {
  const { m, r } = st;
  if (r.deck.length > 0 || r.discard.length > 1 || r.pendingDraw > 0) return false;
  const top = topCard(r);
  return !activeSeats(m, r).some((s) => r.hands[s].some((c) => matches(c, top, r.activeColor)));
}

/** elimination check after a seat's hand grew; may end the round */
function checkEliminated(st: St, seat: Seat): void {
  const { m, r } = st;
  const at = Number(m.rules.eliminateAt) || 0;
  if (at <= 0 || r.eliminated[seat] || r.hands[seat].length < at) return;
  r.eliminated[seat] = true;
  const out = r.outPoints?.slice() ?? [0, 0, 0, 0, 0, 0];
  out[seat] += handPoints(r.hands[seat]);
  r.outPoints = out;
  r.deck = r.hands[seat].concat(r.deck); // under the deck (we draw from the end)
  r.hands[seat] = [];
  r.kuCalled[seat] = false;
  st.ev.push({ type: 'eliminated', seat });
  if (r.window) {
    if (r.window.victim === seat) setWindow(st, null);
    else r.window.seats = r.window.seats.filter((s) => s !== seat);
  }
  const left = activeSeats(m, r);
  const oneTeam = m.teams ? new Set(left.map((s) => teamOf(m, s))).size <= 1 : false;
  if (left.length <= 1 || oneTeam) endRound(st, left[0] ?? seat);
}

/** opens a ¡Ku! catch window when `seat` sits on one card without having called */
function kuCheck(st: St, seat: Seat): void {
  const { m, r } = st;
  if (!m.rules.kuCall || r.window || r.over || r.eliminated[seat] || r.hands[seat].length !== 1 || r.kuCalled[seat]) return;
  setWindow(st, { reason: 'ku', seats: activeSeats(m, r).filter((s) => s !== seat), victim: seat });
}

// ───────────────────────── penalties ─────────────────────────

/**
 * Seats that may answer the pending penalty aimed at `victim`: the victim with a shield or mirror,
 * and (partnerShield) the victim's partner with a shield, unless that partner played the penalty.
 */
function penaltyResponders(st: St, victim: Seat): Seat[] {
  const { m, r } = st;
  const out: Seat[] = [];
  if (r.hands[victim].some((c) => c.face.kind === 'shield' || c.face.kind === 'mirror')) out.push(victim);
  if (m.rules.partnerShield) {
    const p = partnerOf(m, victim);
    if (p !== null && !r.eliminated[p] && p !== r.pendingFrom && r.hands[p].some((c) => c.face.kind === 'shield')) out.push(p);
  }
  return out;
}

/** the pending penalty now targets `victim`: it waits on them (window if someone may respond) or is drawn */
function aimPenalty(st: St, victim: Seat, keep: boolean): void {
  const { r } = st;
  const responders = penaltyResponders(st, victim);
  if (!responders.length && !keep) {
    takePenalty(st, victim);
    return;
  }
  setTurn(st, victim);
  const w: ResponseWindow | null = responders.length ? { reason: 'penalty', seats: responders, victim } : null;
  if (w || r.window) setWindow(st, w);
}

function penalty(st: St, from: Seat, n: number, challenge: { illegal: boolean } | null): void {
  const { m, r } = st;
  const victim = next(st, from);
  const stacking = m.rules.stacking === 'same' || m.rules.stacking === 'any';
  r.pendingDraw += n;
  r.pendingFrom = from;
  er(r).challenge = challenge ? { from, victim, illegal: challenge.illegal } : null;
  if (stacking) st.ev.push({ type: 'stack', total: r.pendingDraw });
  aimPenalty(st, victim, stacking || !!challenge);
}

/** the pending penalty is over: clear it (and its window) */
function clearPenalty(st: St): void {
  const { r } = st;
  r.pendingDraw = 0;
  r.pendingFrom = null;
  er(r).challenge = null;
  er(r).mirrorVictim = null;
  if (r.window?.reason === 'penalty') setWindow(st, null);
}

function takePenalty(st: St, seat: Seat): void {
  const { r } = st;
  const n = r.pendingDraw;
  const resumeAfter = er(r).mirrorVictim ?? seat;
  clearPenalty(st);
  drawCards(st, seat, n, 'penalty');
  checkEliminated(st, seat);
  if (r.over) return;
  setTurn(st, next(st, resumeAfter));
}

/** shield / mirror played out of the normal turn flow against the pending penalty */
function respond(st: St, seat: Seat, card: Card): void {
  const { r } = st;
  const hand = r.hands[seat];
  hand.splice(hand.indexOf(card), 1);
  r.discard.splice(r.discard.length - 1, 0, card); // under the top card: pile and active colour unchanged
  if (card.face.kind === 'shield') {
    const mv = er(r).mirrorVictim;
    st.ev.push({ type: 'shield', seat });
    clearPenalty(st);
    if (hand.length === 0) {
      endRound(st, seat);
      return;
    }
    if (mv != null) setTurn(st, next(st, mv));
    // else the victim keeps the turn as if no penalty had been played
  } else {
    const to = r.pendingFrom!;
    const total = r.pendingDraw;
    if (er(r).mirrorVictim == null) er(r).mirrorVictim = seat;
    er(r).challenge = null;
    r.pendingFrom = seat;
    st.ev.push({ type: 'mirror', from: seat, to, total });
    if (hand.length === 0) {
      drawCards(st, to, total, 'penalty');
      endRound(st, seat);
      return;
    }
    aimPenalty(st, to, false);
  }
  if (!r.over) kuCheck(st, seat);
}

function challenge(st: St, seat: Seat): void {
  const { r } = st;
  const c = er(r).challenge!;
  const total = r.pendingDraw;
  clearPenalty(st);
  if (c.illegal) {
    // caught: the player draws the stack, the victim plays on as if nothing happened
    drawCards(st, c.from, total, 'penalty');
    checkEliminated(st, c.from);
  } else {
    drawCards(st, seat, total + 2, 'penalty');
    checkEliminated(st, seat);
    if (!r.over) setTurn(st, next(st, seat));
  }
}

// ───────────────────────── card effects ─────────────────────────

function skipNext(st: St, from: Seat): void {
  const skipped = next(st, from);
  st.ev.push({ type: 'skip', seat: skipped });
  setTurn(st, next(st, skipped));
}

function swapHands(st: St, a: Seat, b: Seat): void {
  const { r } = st;
  [r.hands[a], r.hands[b]] = [r.hands[b], r.hands[a]];
  [r.kuCalled[a], r.kuCalled[b]] = [r.kuCalled[b], r.kuCalled[a]];
  // cards = seat 0's view (offline perspective; online redaction rewrites it per player)
  st.ev.push({ type: 'swapHands', a, b, ...(a === 0 || b === 0 ? { cards: r.hands[0].slice() } : {}) });
}

/** every active hand moves to the next active seat in play direction; returns where each hand went */
function rotateHands(st: St): Partial<Record<Seat, Seat>> {
  const { m, r } = st;
  const act = activeSeats(m, r);
  const dest: Partial<Record<Seat, Seat>> = {};
  const hands = r.hands.slice();
  const ku = r.kuCalled.slice();
  for (const s of act) {
    const to = next(st, s);
    dest[s] = to;
    hands[to] = r.hands[s];
    ku[to] = r.kuCalled[s];
  }
  r.hands = hands;
  r.kuCalled = ku;
  st.ev.push({ type: 'rotateHands', direction: r.direction, ...(act.includes(0) ? { cards: r.hands[0].slice() } : {}) });
  return dest;
}

/** wildColor: `seat` draws until it gets a card of the active colour */
function drawUntilColor(st: St, seat: Seat): void {
  const color = st.r.activeColor;
  drawCards(st, seat, 0, 'penalty', (c) => c.face.color === color);
}

interface PlayOpts {
  color?: Color;
  target?: Seat;
  ku?: boolean;
  give?: number;
}

/** a card leaves `seat`'s hand for the pile (turn play or jump-in) and its effect resolves */
function resolvePlay(st: St, seat: Seat, card: Card, opts: PlayOpts): void {
  const { m, r } = st;
  const rules = m.rules;
  const hand = r.hands[seat];
  const kind = card.face.kind;
  const prevColor = r.activeColor;
  const swept = kind === 'sweep' ? hand.filter((c) => c !== card && c.face.color === card.face.color) : [];
  const given = opts.give !== undefined ? hand.find((c) => c.id === opts.give && c !== card) : undefined;
  const remaining = hand.length - 1 - swept.length - (given ? 1 : 0);
  if (opts.ku && rules.kuCall && (hand.length <= 2 || remaining <= 1) && !r.kuCalled[seat]) {
    r.kuCalled[seat] = true;
    st.ev.push({ type: 'ku', seat });
  }
  // wild4Challenge: did the player hold a card of the colour in play before this wild penalty?
  const challengeInfo =
    rules.wild4Challenge && (kind === 'wild4' || kind === 'draw10') ? { illegal: hand.some((c) => c !== card && c.face.color === prevColor) } : null;

  hand.splice(hand.indexOf(card), 1);
  r.discard.push(card);
  const wild = isWildKind(kind);
  r.activeColor = card.face.color ?? opts.color ?? r.activeColor;
  st.ev.push(wild ? { type: 'play', seat, card, color: r.activeColor } : { type: 'play', seat, card });
  r.drewThisTurn = false;
  r.drawnCardId = null;

  if (swept.length) {
    for (const c of swept) hand.splice(hand.indexOf(c), 1);
    r.discard.splice(r.discard.length - 1, 0, ...swept); // under the sweep card
    st.ev.push({ type: 'sweep', seat, cardIds: swept.map((c) => c.id) });
  }
  if (given) {
    const partner = partnerOf(m, seat)!;
    hand.splice(hand.indexOf(given), 1);
    r.hands[partner].push(given);
    st.ev.push({ type: 'draw', seat: partner, count: 1, cards: [given], reason: 'turn' });
    checkEliminated(st, partner);
    if (r.over) return;
  }

  const draw = penaltyOf(card.face);
  if (hand.length === 0) {
    // going out: a final penalty card (or wildColor) still makes the victim draw (it counts for scoring)
    if (draw > 0) {
      const total = r.pendingDraw + draw;
      r.pendingDraw = 0;
      drawCards(st, next(st, seat), total, 'penalty');
    } else if (kind === 'wildColor') drawUntilColor(st, next(st, seat));
    endRound(st, seat);
    return;
  }

  let kuSeat: Seat | null = rules.kuCall && hand.length === 1 && !r.kuCalled[seat] ? seat : null;

  switch (kind) {
    case 'number': {
      if (isSevenZero(rules) && card.face.value === 7 && opts.target !== undefined) {
        swapHands(st, seat, opts.target);
        if (kuSeat === seat) kuSeat = opts.target;
      } else if (isSevenZero(rules) && card.face.value === 0) {
        const dest = rotateHands(st);
        if (kuSeat !== null) kuSeat = dest[kuSeat] ?? kuSeat;
      }
      setTurn(st, next(st, seat));
      break;
    }
    case 'swap':
      if (opts.target !== undefined) {
        swapHands(st, seat, opts.target);
        if (kuSeat === seat) kuSeat = opts.target;
      }
      setTurn(st, next(st, seat));
      break;
    case 'skip':
      skipNext(st, seat);
      break;
    case 'skipAll': {
      for (let s = next(st, seat); s !== seat; s = next(st, s)) st.ev.push({ type: 'skip', seat: s });
      setTurn(st, seat);
      break;
    }
    case 'reverse':
      if (activeSeats(m, r).length === 2) skipNext(st, seat);
      else {
        r.direction = r.direction === 1 ? -1 : 1;
        st.ev.push({ type: 'reverse', direction: r.direction });
        setTurn(st, next(st, seat));
      }
      break;
    case 'draw2':
    case 'wild4':
    case 'draw6':
    case 'draw10':
      penalty(st, seat, draw, challengeInfo);
      break;
    case 'wildColor': {
      const victim = next(st, seat);
      drawUntilColor(st, victim);
      checkEliminated(st, victim);
      if (!r.over) setTurn(st, next(st, victim));
      break;
    }
    // wild, sweep (cards already swept), shield / mirror on their turn, flip (later phase): plain cards
    default:
      setTurn(st, next(st, seat));
      break;
  }
  if (r.over) return;
  if (kuSeat !== null) kuCheck(st, kuSeat);
}

export function applyMove(match: MatchState, move: Move): { match: MatchState; events: GameEvent[] } {
  const r0 = match.round;
  if (!r0 || r0.over || match.over) throw new Error('engine.applyMove: no round in progress');
  if (!isLegal(match, move)) throw new Error(`engine.applyMove: illegal move ${JSON.stringify(move)}`);
  const st = begin(match);
  const { r } = st;
  const seat = move.seat;

  // a pending ¡Ku! catch window closes as soon as the game moves on
  if (r.window?.reason === 'ku') {
    const turnMove = move.kind === 'play' || move.kind === 'draw' || move.kind === 'pass' || move.kind === 'acceptPenalty' || move.kind === 'challenge';
    const progress = move.kind === 'jumpIn' || move.kind === 'respond' || (seat === r.turn && turnMove);
    if (progress) setWindow(st, null);
  }

  switch (move.kind) {
    case 'play': {
      const card = r.hands[seat].find((c) => c.id === move.cardId)!;
      resolvePlay(st, seat, card, move);
      break;
    }
    case 'jumpIn': {
      const card = r.hands[seat].find((c) => c.id === move.cardId)!;
      resolvePlay(st, seat, card, { target: move.target });
      break;
    }
    case 'draw': {
      const got = drawCards(st, seat, 1, 'turn', match.rules.drawMode === 'untilPlayable' ? (c) => canPlay(c, r, match.rules) : undefined);
      checkEliminated(st, seat);
      if (r.over) break;
      if (r.eliminated[seat]) {
        setTurn(st, next(st, seat));
        break;
      }
      const last = got[got.length - 1];
      if (last && canPlay(last, r, match.rules)) {
        r.drewThisTurn = true;
        r.drawnCardId = last.id;
        break;
      }
      if (isStuck(st)) {
        endBlocked(st);
        break;
      }
      setTurn(st, next(st, seat));
      break;
    }
    case 'pass':
      setTurn(st, next(st, seat));
      break;
    case 'acceptPenalty':
      takePenalty(st, seat);
      break;
    case 'callKu':
      r.kuCalled[seat] = true;
      st.ev.push({ type: 'ku', seat });
      if (r.window?.reason === 'ku' && r.window.victim === seat) setWindow(st, null);
      break;
    case 'catchKu': {
      const target = move.target;
      setWindow(st, null);
      st.ev.push({ type: 'kuCaught', by: seat, target });
      drawCards(st, target, 2, 'catch');
      checkEliminated(st, target);
      if (!r.over && r.eliminated[r.turn]) setTurn(st, next(st, r.turn));
      break;
    }
    case 'respond': {
      const card = r.hands[seat].find((c) => c.id === move.cardId)!;
      respond(st, seat, card);
      break;
    }
    case 'challenge':
      challenge(st, seat);
      break;
  }
  return finish(st);
}

/** the response timer ran out */
export function closeWindow(match: MatchState): { match: MatchState; events: GameEvent[] } {
  const w = match.round?.window;
  if (!w || match.round!.over) return { match, events: [] };
  const st = begin(match);
  if (w.reason === 'penalty' && w.victim !== undefined) takePenalty(st, w.victim);
  else setWindow(st, null);
  return finish(st);
}

/** total cards in play (hands + deck + pile): must always equal the deck size */
export function cardCount(r: RoundState): number {
  return r.hands.reduce((t, h) => t + h.length, 0) + r.deck.length + r.discard.length;
}
