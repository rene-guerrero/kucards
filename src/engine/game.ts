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
 * 'any' = any penalty card worth at least the top one, never a lower one), `respond`, `challenge`, or
 * `acceptPenalty` (draws the whole stack, loses the turn).
 * Stacking is MANDATORY: while the victim holds a card that can be stacked, `acceptPenalty` is not
 * legal (closeWindow then only closes the window). Shield / mirror (`respond`) and `challenge` are not
 * stacks and stay available, so on a wild +4 / +10 the victim must stack OR challenge (OR respond), and
 * may accept only when nothing can be stacked.
 *
 * Response windows (`round.window`) are for things that may happen OUT of turn and need a timer:
 *  - 'ku': a seat went down to one card without calling ¡Ku! (no `ku: true` on the play and no earlier
 *    `callKu`). `window.victim` = the offender, `window.seats` = everyone else who may `catchKu`
 *    (offender draws 2). The offender may still `callKu` to close it. It also closes when the seat on
 *    turn plays / draws / passes / accepts / responds / challenges, when anybody jumps in, or on
 *    `closeWindow`.
 *  - 'penalty': a pending penalty whose victim can answer (shield, mirror, challenge or, when stacking is
 *    on, a playable +N), plus (rule `partnerShield`) a partner holding a shield (`penaltyResponders()`).
 *    `seats` = who may `respond`, `victim` = the seat on turn; `closeWindow` = the victim accepts when no
 *    stack is possible.
 *  Only one window exists at a time (a ¡Ku! slip while a penalty window opens is forgiven).
 *
 * Shield (respond): the stack is cancelled, the shield is played ON TOP of the pile and becomes the new
 *   top card (setting the colour in play), 'shield' event. The victim then keeps the turn as if no
 *   penalty had been played.
 * Mirror (respond, victim only): the whole stack goes back to `pendingFrom` ('mirror' event; the mirror
 *   goes under the top card) and the direction reverses ('reverse' event). The mirroring seat becomes
 *   `pendingFrom`, so the new victim may answer with a shield, another mirror or (if stacking is on) a
 *   playable +N, else draws at once (no challenge after a mirror). Whatever ends it (draw or shield),
 *   play resumes with the seat AFTER the original victim (`mirrorVictim`, engine-internal) in the NEW
 *   direction: the mirror used that seat's turn.
 * A response card that empties the responder's hand wins the round (a mirrored stack is drawn first).
 *
 * Challenge (always on, every mode; wild4 and draw10): the victim of a pending wild penalty may
 *   `challenge` (only a wild played with no penalty pending: one stacked on a +2 / +4 cannot be
 *   challenged). Standard rule: the +4 may only be played when its player holds no card matching the
 *   colour in play. If the player held a card of the colour in play before the wild that could have been
 *   played instead (checked at play time, kept in the engine-internal `challenge` field), the challenge
 *   succeeds: that player draws the whole pending stack (4 for a lone +4) and the challenger draws
 *   nothing and keeps the turn as if no penalty; otherwise the challenger draws stack + 2 (6 for a lone
 *   +4) and loses the turn. The `wild4Challenge` rule flag is ignored (kept for old saves).
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
 *  - sweepWild (wild, player-made decks): `color`; every other card of the chosen colour leaves the hand
 *    like a sweep's, and the chosen colour is in play.
 *  - wildFlip (wild, two-sided decks): an Eclipse whose player picks the colour in play after the turn
 *    over: `color` is one of the OTHER side's colours (the side it turns to), and it wins over the colour of
 *    the face the Eclipse turns up. In a one-sided deck (never dealt there) it is a plain wild.
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
 *
 * Día y Noche (mode 'dayNight', deck 'dayNight'): every card has a day face and a night face
 * (`Card.face` = the face of the side in play, `Card.other` = the other one, which is what everybody
 * else sees of it). The round starts on the day side ('light'). An Eclipse ('flip', coloured, on both
 * sides) is a plain card that, once on the pile, turns over every card in play: hands, deck and pile
 * (each card keeps its place; face and other swap) and `round.side` changes. The active colour becomes
 * the colour of the new top face (the Eclipse's other side), or the same slot of the other side's
 * palette when that face is a wild. The new top face's effect does not trigger. Wild colour choices are
 * always the colours of the side in play. Going out on an Eclipse ends the round without a flip.
 */
import type { Card, CardFace, Color, GameEvent, MatchSetup, MatchState, Move, ResponseWindow, RoundState, RuleSettings, Seat } from '../contracts';
import { COLORS, sideColors } from '../contracts';
import { cardPoints, isWildKind, matchDeck, otherSideColor, PENALTY_DRAW, turnOver } from './cards';
import { Rng } from './rng';
import { modeRules } from './rules';
import { modeDef } from './modes';
import { sideSeating } from '../modes/core';

const SEATS_FOR: Record<2 | 3 | 4, Seat[]> = { 2: [0, 2], 3: [0, 1, 3], 4: [0, 1, 2, 3] };

export function createMatch(rules: RuleSettings, setup: MatchSetup, seed = Date.now()): MatchState {
  // seating and teams come from the mode's definition: teams 'always' forces 4 players in 2 vs 2,
  // 'optional' follows the setup (4 players), 'off' never; seating 'side' = Codo a codo, 'across' = Enfrente
  const md = setup.custom ?? modeDef(setup.mode);
  const players = md.teams === 'always' ? 4 : setup.players;
  const seats = SEATS_FOR[players];
  const teamsOn = players === 4 && (md.teams === 'always' || (md.teams === 'optional' && !!setup.teams));
  const teams: MatchState['teams'] = !teamsOn
    ? undefined
    : sideSeating(md, players, teamsOn)
      ? [[0, 1], [2, 3]] // side by side: A A B B, the partner is always the next seat
      : [[0, 2], [1, 3]]; // across: A B A B
  // a player-made mode plays its own rules (nothing forced on top) and its own deck (two-sided: its day
  // list `deck` and its night list `night`)
  const c = setup.custom;
  const mrules = c ? { ...rules, ...c.rules, deck: c.twoSided ? 'dayNight' : (c.rules.deck === 'dayNight' ? 'classic' : (c.rules.deck ?? 'classic')) } : modeRules(setup.mode, rules);
  const deck = c ? c.deck : setup.deck;
  const night = c ? (c.twoSided ? c.night : undefined) : setup.night;
  return {
    rules: mrules,
    setup: { ...setup },
    mode: c ? c.base : setup.mode,
    ...(deck ? { deckSpec: deck } : {}),
    ...(night ? { nightSpec: night } : {}),
    ...(c ? { custom: { id: c.id, name: c.name, icon: c.icon } } : {}),
    seats, scores: [0, 0, 0, 0, 0, 0], round: null, teams, over: false, winner: null, rng: seed | 0,
  };
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
  const deck = shuffle(matchDeck(match), rng);
  const handSize = Number(match.rules.handSize) || 7;
  const hands: Card[][] = [[], [], [], [], [], []];
  for (let i = 0; i < handSize; i++) for (const s of match.seats) hands[s].push(deck.pop()!);
  // the first card on the pile is a number card (others go back under the deck)
  // (a player-made deck may hold no number card: then any coloured card, else whatever comes)
  let first = deck.pop()!;
  for (let tries = 0; first.face.kind !== 'number' && tries < deck.length; tries++) {
    deck.unshift(first);
    first = deck.pop()!;
  }
  for (let tries = 0; first.face.color === null && tries < deck.length; tries++) {
    deck.unshift(first);
    first = deck.pop()!;
  }
  const roundNo = (match.round?.roundNo ?? 0) + 1;
  const twoSided = !!first.other;
  const starter = match.seats[rng.int(match.seats.length)];
  const activeColor: Color = first.face.color ?? COLORS[0];
  const round: RoundState = {
    roundNo, seed: match.rng | 0, hands, deck, discard: [first], activeColor, turn: starter, direction: 1,
    pendingDraw: 0, pendingFrom: null, window: null, kuCalled: [false, false, false, false, false, false],
    drewThisTurn: false, drawnCardId: null, side: 'light', eliminated: [false, false, false, false, false, false], over: false,
  };
  const deal: GameEvent = { type: 'deal', counts: hands.map((h) => h.length), starter, firstCard: first, activeColor, hand: hands[0].slice(), deck: deck.length };
  if (twoSided) Object.assign(deal, { backs: backsOf(hands), deckBack: deckBackOf(deck) });
  const events: GameEvent[] = [deal, twoSided ? { type: 'turn', seat: starter, deckBack: deckBackOf(deck) } : { type: 'turn', seat: starter }];
  return { match: { ...match, round, rng: rng.s }, events };
}

/** Día y Noche: by seat, the faces everybody sees on the backs of the hands */
const backsOf = (hands: readonly Card[][]): CardFace[][] => hands.map((h) => h.map((c) => c.other ?? c.face));
/** Día y Noche: the back of the deck's top card (null when the deck is empty) */
const deckBackOf = (deck: readonly Card[]): CardFace | null => deck[deck.length - 1]?.other ?? null;

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
  challenge?: { from: Seat; victim: Seat; illegal: boolean; proof?: number[] } | null;
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
  const top = topCard(r).face;
  const d = penaltyOf(card.face);
  const td = penaltyOf(top);
  if (!d || !td) return false;
  if (mode === 'same') return card.face.kind === top.kind;
  return d >= td; // same or higher, never lower
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
const isNumber = (c: Card) => c.face.kind === 'number';

/**
 * numberFinish: a move that takes `removed` out of `hand` may empty it only when every card it puts down
 * is a number (a sweep, a power card or any other special card can never be the winning play).
 */
function finishOk(rules: RuleSettings, hand: readonly Card[], removed: readonly Card[]): boolean {
  if (!rules.numberFinish || removed.length < hand.length) return true;
  return removed.every(isNumber);
}

/** the cards a turn play takes out of the hand: the card, what a sweep discards with it, multi-play extras */
function playRemoves(hand: readonly Card[], card: Card, color?: Color, extra?: readonly number[]): Card[] {
  const out = [card];
  const sweepColor = card.face.kind === 'sweep' ? card.face.color : card.face.kind === 'sweepWild' ? (color ?? null) : null;
  if (sweepColor) for (const c of hand) if (c !== card && c.face.color === sweepColor) out.push(c);
  if (extra) for (const id of extra) {
    const c = hand.find((x) => x.id === id);
    if (c && !out.includes(c)) out.push(c);
  }
  return out;
}

/** a play / jump-in / respond move allowed by numberFinish */
function finishMoveOk(rules: RuleSettings, hand: readonly Card[], mv: Move): boolean {
  if (!rules.numberFinish) return true;
  if (mv.kind !== 'play' && mv.kind !== 'jumpIn' && mv.kind !== 'respond') return true;
  const card = hand.find((c) => c.id === mv.cardId);
  if (!card) return false;
  // (a jumped-in sweep sweeps its colour too)
  return finishOk(rules, hand, mv.kind === 'play' ? playRemoves(hand, card, mv.color, mv.extra) : mv.kind === 'jumpIn' ? playRemoves(hand, card) : [card]);
}

/** the seat on turn could put this card down now (matching, and numberFinish allows it) */
function turnPlayable(rules: RuleSettings, r: RoundState, hand: readonly Card[], c: Card): boolean {
  return matches(c, topCard(r), r.activeColor) && finishOk(rules, hand, playRemoves(hand, c));
}

function playVariants(m: MatchState, r: RoundState, seat: Seat, card: Card): Move[] {
  const base = { kind: 'play' as const, seat, cardId: card.id };
  const targets = () => activeSeats(m, r).filter((t) => t !== seat);
  // wildFlip in a two-sided deck: the colours of the side it turns to
  const flipTo = card.face.kind === 'wildFlip' && !!topCard(r).other;
  const colors = (r.side === 'dark') !== flipTo ? sideColors('dark') : COLORS;
  if (card.face.kind === 'swap') return colors.flatMap((color) => targets().map((target) => ({ ...base, color, target })));
  if (isWildKind(card.face.kind)) return colors.map((color) => ({ ...base, color }));
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
  return !!c && c.victim === s && r.pendingDraw > 0 && er(r).mirrorVictim == null;
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
  // ¡Ku! (added at the end): only when it matters
  const kuOpen = hand.length === 1 && w?.reason === 'ku' && w.victim === s;
  // numberFinish: moves that would win with a special card are left out
  const ok = (mvs: Move[]): Move[] => (rules.numberFinish ? mvs.filter((mv) => finishMoveOk(rules, hand, mv)) : mvs);

  if (s === r.turn) {
    if (r.pendingDraw > 0) {
      for (const c of hand) if (canStack(c, r, rules)) out.push(...ok(playVariants(match, r, s, c)));
      out.push(...ok(responseCards(r, s).map((c) => ({ kind: 'respond' as const, seat: s, cardId: c.id }))));
      const stacks = out.some((x) => x.kind === 'play');
      if (canChallenge(match, r, s)) out.push({ kind: 'challenge', seat: s });
      if (!stacks) out.push({ kind: 'acceptPenalty', seat: s }); // stacking is mandatory
    } else if (r.drewThisTurn) {
      const drawn = r.drawnCardId != null ? hand.find((c) => c.id === r.drawnCardId) : hand[hand.length - 1];
      const plays = drawn && canPlay(drawn, r, rules) ? ok(playVariants(match, r, s, drawn)) : [];
      out.push(...plays);
      if (!(plays.length && rules.forcePlay)) out.push({ kind: 'pass', seat: s });
    } else {
      for (const c of hand) if (canPlay(c, r, rules)) out.push(...ok(playVariants(match, r, s, c)));
      out.push({ kind: 'draw', seat: s });
    }
  } else if (w?.reason === 'penalty') {
    out.push(...ok(responseCards(r, s).map((c) => ({ kind: 'respond' as const, seat: s, cardId: c.id }))));
  } else if (rules.jumpIn && r.pendingDraw === 0) {
    const top = topCard(r);
    for (const c of hand) if (identical(c, top)) out.push(...ok(jumpInVariants(match, r, s, c)));
  }
  // with two cards about to play the second-to-last (your turn or a jump-in), or with one card while the
  // catch window is open against you; multiPlay: with more cards when one play could leave just one
  const kuNow =
    (hand.length === 2 && out.some((m) => m.kind === 'play' || m.kind === 'jumpIn')) ||
    kuOpen ||
    (hand.length > 2 && anyMulti(rules) && out.some((m) => m.kind === 'play' && multiPlayOptions(match, m).length >= hand.length - 2));
  if (rules.kuCall && kuNow && !r.kuCalled[s]) out.push({ kind: 'callKu', seat: s });
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
  // multiPlay extras leave with the 7 too: the giver must still keep a card
  const extra = move.extra ?? [];
  if (!card || !isSeven(card) || hand.length - extra.length < 3) return [];
  return hand.filter((c) => c !== card && !extra.includes(c.id)).map((c) => c.id);
}

/** is any multi-play rule on (multiPlay, multiDraw2, multiReverse, multiSkip)? */
const anyMulti = (rules: RuleSettings): boolean => !!(rules.multiPlay || rules.multiDraw2 || rules.multiReverse || rules.multiSkip);

/** the multi-play rule that lets more cards of this card's kind go down with it is on */
function multiKind(rules: RuleSettings, card: Card): boolean {
  switch (card.face.kind) {
    case 'number':
      return !!rules.multiPlay;
    case 'draw2':
      return !!rules.multiDraw2;
    case 'reverse':
      return !!rules.multiReverse;
    case 'skip':
      return !!rules.multiSkip;
    default:
      return false;
  }
}

/** cards of one multi-play group: the same number (multiPlay), or the same action kind (+2, reverse, skip) */
const sameGroup = (a: Card, b: Card): boolean => a.face.kind === b.face.kind && (a.face.kind !== 'number' || a.face.value === b.face.value);

/**
 * The card ids that may join this play move as `extra` (any of them, in any order), never mixing kinds:
 * multiPlay: the other number cards with the same value; multiDraw2 / multiReverse / multiSkip: the other
 * +2 / reverse / skip cards, of any colour. Empty when the move cannot carry any: rule off, not a turn play
 * (the card just drawn and out-of-turn moves never do), a stack on a penalty other than +2s, or no such
 * card. A `give` card on the move is left out. numberFinish: an action group may not empty the hand, so
 * one card fewer is offered when all of them would.
 */
export function multiPlayOptions(match: MatchState, move: Move): number[] {
  const r = match.round;
  if (!r || r.over || match.over || move.kind !== 'play' || !anyMulti(match.rules)) return [];
  if (move.seat !== r.turn || r.drewThisTurn) return [];
  const hand = r.hands[move.seat];
  const card = hand.find((c) => c.id === move.cardId);
  if (!card || !multiKind(match.rules, card)) return [];
  // multiDraw2: several +2s may also answer a pending penalty together, when the first one may stack
  if (r.pendingDraw > 0 && card.face.kind !== 'draw2') return [];
  if (!canPlay(card, r, match.rules)) return [];
  const out = hand.filter((c) => c !== card && sameGroup(c, card) && c.id !== move.give).map((c) => c.id);
  if (match.rules.numberFinish && !isNumber(card) && out.length >= hand.length - 1) out.length = Math.max(0, hand.length - 2);
  return out;
}

/** structural move equality, ignoring the optional `ku` / `give` / `extra` flags on plays */
export function sameMove(a: Move, b: Move): boolean {
  if (a.kind !== b.kind || a.seat !== b.seat) return false;
  const x = a as Partial<Record<'cardId' | 'color' | 'target', unknown>>;
  const y = b as Partial<Record<'cardId' | 'color' | 'target', unknown>>;
  return x.cardId === y.cardId && x.color === y.color && x.target === y.target;
}

export function isLegal(match: MatchState, move: Move): boolean {
  if (!legalMoves(match, move.seat).some((l) => sameMove(l, move))) return false;
  if (move.kind !== 'play') return true;
  if (move.extra !== undefined) {
    const extra = move.extra;
    if (!Array.isArray(extra)) return false;
    if (extra.length) {
      const opts = multiPlayOptions(match, { ...move, extra: undefined });
      if (new Set(extra).size !== extra.length || !extra.every((id) => opts.includes(id))) return false;
      if (!finishMoveOk(match.rules, match.round!.hands[move.seat], move)) return false;
    }
  }
  if (move.give !== undefined) return giveOptions(match, move).includes(move.give);
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

function finish(st: St, keepKu: Seat | null = null): { match: MatchState; events: GameEvent[] } {
  const { r } = st;
  // keepKu: a ¡Ku! called early for a multi-play that will leave one card stays until that play
  for (let s = 0; s < r.hands.length; s++) if (r.hands[s].length > 2 && s !== keepKu) r.kuCalled[s] = false;
  st.m.rng = st.rng.s;
  return { match: st.m, events: st.ev };
}

const next = (st: St, from: Seat): Seat => stepSeat(st.m, st.r, from);

function setTurn(st: St, seat: Seat): void {
  st.r.turn = seat;
  st.r.drewThisTurn = false;
  st.r.drawnCardId = null;
  st.ev.push(st.r.discard[0]?.other ? { type: 'turn', seat, deckBack: deckBackOf(st.r.deck) } : { type: 'turn', seat });
}

/**
 * Día y Noche: an Eclipse turns every card in play over (see DESIGN NOTES). `color` (wildFlip) is the
 * colour its player picked from the new side. A one-sided deck has nothing to turn over: nothing happens.
 */
function flipAll(st: St, seat: Seat, color?: Color): void {
  const { r } = st;
  if (!topCard(r).other) return;
  r.hands = r.hands.map((h) => h.map(turnOver));
  r.deck = r.deck.map(turnOver);
  r.discard = r.discard.map(turnOver);
  r.side = r.side === 'dark' ? 'light' : 'dark';
  r.activeColor = color ?? topCard(r).face.color ?? otherSideColor(r.activeColor);
  er(r).challenge = null;
  st.ev.push({ type: 'flip', side: r.side, color: r.activeColor, seat, hand: r.hands[0].slice(), backs: backsOf(r.hands), deckBack: deckBackOf(r.deck) });
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
  // a one-card "reshuffle" draws no random number: step the RNG anyway, so a near-empty table where
  // every card sits in the hands can never replay the same state (and the same CPU choices) forever
  if (rest.length < 2) st.rng.next();
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
    // Día y Noche: the deck's new top shows its other side at once (not only at the next turn)
    if (chunk.length) st.ev.push(chunk[0].other ? { type: 'draw', seat, count: chunk.length, cards: chunk, reason, deckBack: deckBackOf(r.deck) } : { type: 'draw', seat, count: chunk.length, cards: chunk, reason });
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

function endRound(st: St, winner: Seat, byTime = false): void {
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
  st.ev.push(byTime ? { type: 'roundEnd', winner, points, byTime } : { type: 'roundEnd', winner, points });
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

/**
 * The time-up verdict: the fewest card points in hand wins (Parejas: the team with the lower combined
 * points; the team's seat holding fewer points is named winner). Ties: fewer cards (combined for teams),
 * then the seat (team) that would play soonest from the seat on turn, in play order, the player on turn
 * first. Eliminated seats do not take part (their team plays on with the partner).
 */
export function timeUpWinner(m: MatchState, r: RoundState): Seat {
  const act = activeSeats(m, r);
  const order: Seat[] = [];
  let s = r.turn;
  for (let i = 0; i < m.seats.length && !order.includes(s); i++) {
    if (act.includes(s)) order.push(s);
    s = stepSeat(m, r, s);
  }
  for (const x of act) if (!order.includes(x)) order.push(x);
  const group = (x: Seat): Seat[] => {
    const t = teamOf(m, x);
    return t === null ? [x] : m.teams![t].filter((y) => act.includes(y));
  };
  const key = (x: Seat): [number, number] => {
    const g = group(x);
    return [g.reduce((t: number, y) => t + handPoints(r.hands[y]), 0), g.reduce((t: number, y) => t + r.hands[y].length, 0)];
  };
  let best = order[0];
  for (const x of order) {
    const [p, c] = key(x);
    const [bp, bc] = key(best);
    if (p < bp || (p === bp && c < bc)) best = x;
  }
  // a team: name the partner holding fewer points (the score goes to both anyway)
  const g = group(best);
  return g.reduce((a, b) => (handPoints(r.hands[b]) < handPoints(r.hands[a]) ? b : a), best);
}

/** the round's time limit ran out: the round ends now (scored as any round end, the time-up verdict) */
export function timeUp(match: MatchState): { match: MatchState; events: GameEvent[] } {
  if (!match.round || match.round.over) return { match, events: [] };
  const st = begin(match);
  st.r.endedBy = 'time';
  endRound(st, timeUpWinner(st.m, st.r), true);
  return finish(st);
}

/** nobody can play and nothing can be drawn */
function isStuck(st: St): boolean {
  const { m, r } = st;
  if (r.deck.length > 0 || r.discard.length > 1 || r.pendingDraw > 0) return false;
  return !activeSeats(m, r).some((s) => r.hands[s].some((c) => turnPlayable(m.rules, r, r.hands[s], c)));
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
  // only rivals can catch a missed ¡Ku!: never the player's own partner
  const team = m.teams?.find((t) => t.includes(seat)) ?? [seat];
  setWindow(st, { reason: 'ku', seats: activeSeats(m, r).filter((s) => !team.includes(s)), victim: seat });
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

/** the pending penalty now targets `victim`: it waits on them (window if they can answer) or is drawn */
function aimPenalty(st: St, victim: Seat, keep: boolean): void {
  const { m, r } = st;
  const responders = penaltyResponders(st, victim);
  const canAnswer = responders.length > 0 || r.hands[victim].some((c) => canStack(c, r, m.rules)) || canChallenge(m, r, victim);
  if (!canAnswer) {
    if (!keep) takePenalty(st, victim);
    else {
      setTurn(st, victim);
      if (r.window) setWindow(st, null);
    }
    return;
  }
  setTurn(st, victim);
  const w: ResponseWindow = { reason: 'penalty', seats: responders.length ? responders : [victim], victim };
  setWindow(st, w);
}

function penalty(st: St, from: Seat, n: number, challenge: { illegal: boolean; proof?: number[] } | null): void {
  const { m, r } = st;
  const victim = next(st, from);
  const stacking = m.rules.stacking === 'same' || m.rules.stacking === 'any';
  // only a wild penalty played with nothing pending may be challenged (never one stacked on a penalty)
  const stacked = r.pendingDraw > 0;
  r.pendingDraw += n;
  r.pendingFrom = from;
  er(r).challenge = challenge && !stacked ? { from, victim, illegal: challenge.illegal, proof: challenge.proof } : null;
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
  const shield = card.face.kind === 'shield';
  hand.splice(hand.indexOf(card), 1);
  if (shield) {
    r.discard.push(card); // the shield is the new top card and sets the colour in play
    r.activeColor = card.face.color ?? r.activeColor;
  } else {
    r.discard.splice(r.discard.length - 1, 0, card); // mirror: under the top card, colour unchanged
  }
  if (shield) {
    const mv = er(r).mirrorVictim;
    st.ev.push({ type: 'shield', seat, card });
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
    st.ev.push({ type: 'mirror', from: seat, to, total, card });
    // a mirror turns the table around as well as bouncing the penalty back
    r.direction = r.direction === 1 ? -1 : 1;
    st.ev.push({ type: 'reverse', direction: r.direction });
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
  // the +4's player shows the hand (public from here on): `proof` = the cards that could have been played instead
  const shown = r.hands[c.from].map((x) => ({ ...x, face: { ...x.face } }));
  const proofIds = new Set(c.proof ?? []);
  st.ev.push({ type: 'challenge', by: seat, target: c.from, caught: c.illegal, hand: shown, proof: shown.filter((x) => proofIds.has(x.id)), draw: c.illegal ? total : total + 2 });
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

/** `n` seats after `from` lose their turn (multiSkip: one per skip, round the table, possibly `from` itself) */
function skipNext(st: St, from: Seat, n = 1): void {
  let s = from;
  for (let i = 0; i < n; i++) {
    s = next(st, s);
    st.ev.push({ type: 'skip', seat: s });
  }
  setTurn(st, next(st, s));
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
  extra?: number[];
}

/** a card leaves `seat`'s hand for the pile (turn play or jump-in) and its effect resolves */
function resolvePlay(st: St, seat: Seat, card: Card, opts: PlayOpts): void {
  const { m, r } = st;
  const rules = m.rules;
  const hand = r.hands[seat];
  const kind = card.face.kind;
  const prevColor = r.activeColor;
  const sweepColor = kind === 'sweep' ? card.face.color : kind === 'sweepWild' ? (opts.color ?? null) : null;
  const swept = sweepColor ? hand.filter((c) => c !== card && c.face.color === sweepColor) : [];
  const given = opts.give !== undefined ? hand.find((c) => c.id === opts.give && c !== card) : undefined;
  // multi-play: the other cards of the group (same number, or same +2 / reverse / skip kind), in the order
  // they go down (the last sets the colour)
  const extras = (opts.extra ?? []).map((id) => hand.find((c) => c.id === id && c !== card)).filter((c): c is Card => !!c);
  const remaining = hand.length - 1 - swept.length - (given ? 1 : 0) - extras.length;
  if (opts.ku && rules.kuCall && (hand.length <= 2 || remaining <= 1) && !r.kuCalled[seat]) {
    r.kuCalled[seat] = true;
    st.ev.push({ type: 'ku', seat });
  }
  // challenge: did the player hold a card of the colour in play that could have been played instead?
  const challengeInfo =
    kind === 'wild4' || kind === 'draw10' ? { illegal: hand.some((c) => c !== card && c.face.color === prevColor && canPlay(c, r, rules)), proof: hand.filter((c) => c !== card && c.face.color === prevColor && canPlay(c, r, rules)).map((c) => c.id) } : null;

  hand.splice(hand.indexOf(card), 1);
  r.discard.push(card);
  const wild = isWildKind(kind);
  // wildFlip (two-sided): the colour is one of the other side's; the turn over below keeps it in play
  const flipColor = kind === 'wildFlip' && card.other ? opts.color : undefined;
  r.activeColor = card.face.color ?? opts.color ?? r.activeColor;
  const more = extras.length ? { more: true } : {};
  st.ev.push(wild ? { type: 'play', seat, card, color: r.activeColor, ...more } : { type: 'play', seat, card, ...more });
  r.drewThisTurn = false;
  r.drawnCardId = null;
  extras.forEach((c, i) => {
    hand.splice(hand.indexOf(c), 1);
    r.discard.push(c);
    r.activeColor = c.face.color ?? r.activeColor;
    st.ev.push(i < extras.length - 1 ? { type: 'play', seat, card: c, more: true } : { type: 'play', seat, card: c });
  });

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

  // multiDraw2: every +2 of the group adds its penalty
  const draw = extras.reduce((t, c) => t + penaltyOf(c.face), penaltyOf(card.face));
  // multiSkip / multiReverse: each card of the group acts once
  const times = 1 + extras.length;
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

  // a ¡Ku! called early (for a multi-play) does not outlive a play that still leaves two or more cards
  if (hand.length >= 2) r.kuCalled[seat] = false;
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
      skipNext(st, seat, times);
      break;
    case 'skipAll': {
      for (let s = next(st, seat); s !== seat; s = next(st, s)) st.ev.push({ type: 'skip', seat: s });
      setTurn(st, seat);
      break;
    }
    case 'reverse':
      // two players: a reverse acts as a skip; else each one turns the direction (an even count keeps it)
      if (activeSeats(m, r).length === 2) skipNext(st, seat, times);
      else {
        for (let i = 0; i < times; i++) {
          r.direction = r.direction === 1 ? -1 : 1;
          st.ev.push({ type: 'reverse', direction: r.direction });
        }
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
    case 'flip':
      flipAll(st, seat);
      setTurn(st, next(st, seat));
      break;
    case 'wildFlip':
      flipAll(st, seat, flipColor);
      setTurn(st, next(st, seat));
      break;
    // wild, sweep / sweepWild (cards already swept), shield / mirror on their turn: plain cards
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
      // multiPlay: called with more cards, ahead of a play that leaves one
      if (r.hands[seat].length > 2) return finish(st, seat);
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
  // mandatory stacking: a victim who can stack keeps the turn (only the window closes)
  if (w.reason === 'penalty' && w.victim !== undefined && !legalMoves(match, w.victim).some((x) => x.kind === 'play')) takePenalty(st, w.victim);
  else setWindow(st, null);
  return finish(st);
}

/** total cards in play (hands + deck + pile): must always equal the deck size */
export function cardCount(r: RoundState): number {
  return r.hands.reduce((t, h) => t + h.length, 0) + r.deck.length + r.discard.length;
}
