/**
 * Hidden information, both ways. Pure; shared by the room server (server/src), the dev mock server and
 * the client, so the rule "a client never learns a card it may not see, nor the deck order" lives in
 * one tested place.
 *
 * Server side (what one seat may see):
 *  - hands: its own, plus the ones engine `visibleHands` allows (Parejas with partnerOpen: the partner's);
 *    every other hand only as a COUNT. Once the round is over every hand is public (cards are counted).
 *  - the deck: only its size. MatchState.rng and round.seed are removed (both are the deterministic
 *    source of the deal).
 *  - card ids are an index into the deterministic deck (buildDeck), so an id reveals the face: hidden
 *    cards never carry their id (placeholders have negative ids), and `drawnCardId` of a seat the
 *    receiver may not see is dropped.
 *  - engine internals that reveal hands: the +4 challenge's `illegal` flag, `outPoints` (the points of
 *    hands that went back under the deck), and the response window's `seats` (who holds a shield /
 *    mirror: each seat only learns whether it may act itself).
 *  - events: 'draw' carries `cards` only for a seat the receiver may see; 'deal' carries the receiver's
 *    own `hand`; 'swapHands' / 'rotateHands' carry `cards` only when the receiver's own hand changed.
 *    'challenge' keeps `hand` / `proof` for everyone: challenging a +4 shows its player's hand to the table.
 * Client side: withPlaceholders turns a SeatView back into a full-shaped MatchState whose unknown cards
 * are placeholders (what the renderer's restore and the HUD expect).
 */
import type { Card, GameEvent, MatchState, Move, ResponseWindow, RoundState, Seat } from '../contracts';
import { visibleHands } from '../engine/game';
import { HIDDEN_FACE, type SeatView, type Snapshot } from './protocol';

let hiddenSeq = 0;
/** a face-down card the receiver may not see (negative id, never a real deck index) */
export const hiddenCard = (): Card => ({ id: -1 - (hiddenSeq++ % 1_000_000), face: { ...HIDDEN_FACE } });
export const hiddenCards = (n: number): Card[] => Array.from({ length: Math.max(0, n) }, hiddenCard);
export const isHidden = (c: Card | undefined | null): boolean => !c || c.id < 0;

const copyCards = (cs: readonly Card[]): Card[] => cs.map((c) => ({ ...c, face: { ...c.face } }));

/** the seats whose hands `seat` may see in this match (null seat: none) */
export function seenBy(match: MatchState, seat: Seat | null): Seat[] {
  if (seat === null) return [];
  return visibleHands(match, seat);
}

function redactWindow(w: ResponseWindow | null, seat: Seat | null): ResponseWindow | null {
  if (!w) return null;
  const out: ResponseWindow = { reason: w.reason, seats: seat !== null && w.seats.includes(seat) ? [seat] : [] };
  if (w.victim !== undefined) out.victim = w.victim;
  return out;
}

/**
 * Redact one engine batch for `seat`. `after` = the match right after the batch (where the hands for
 * deal / swapHands / rotateHands come from: nothing changes hands after those events within a batch).
 */
export function redactEvents(events: readonly GameEvent[], seat: Seat | null, after: MatchState): GameEvent[] {
  const seen = seenBy(after, seat);
  const hand = (): Card[] => (seat !== null && after.round ? copyCards(after.round.hands[seat] ?? []) : []);
  return events.map((ev): GameEvent => {
    switch (ev.type) {
      case 'deal': {
        const { hand: _h, ...rest } = ev;
        return seat === null ? rest : { ...rest, hand: hand() };
      }
      case 'flip': {
        // Día y Noche: each player gets their own hand, turned over (the engine's event carries seat 0's)
        const { hand: _h, ...rest } = ev;
        return seat === null ? rest : { ...rest, hand: hand() };
      }
      case 'draw': {
        const { cards, ...rest } = ev;
        return cards && seen.includes(ev.seat) ? { ...rest, cards: copyCards(cards) } : rest;
      }
      case 'swapHands': {
        const { cards: _c, ...rest } = ev;
        return seat !== null && (ev.a === seat || ev.b === seat) ? { ...rest, cards: hand() } : rest;
      }
      case 'rotateHands': {
        const { cards: _c, ...rest } = ev;
        return seat !== null && !after.round?.eliminated[seat] ? { ...rest, cards: hand() } : rest;
      }
      case 'challenge':
        // the challenged player's hand is shown to the whole table (the rule makes it public): kept for every seat
        return ev.hand ? { ...ev, hand: copyCards(ev.hand), ...(ev.proof ? { proof: copyCards(ev.proof) } : {}) } : ev;
      case 'window':
        return { type: 'window', window: redactWindow(ev.window, seat) };
      default:
        return ev;
    }
  });
}

/** the authoritative counts + visible hands after a batch (every hand once the round is over) */
export function snapshotFor(match: MatchState, seat: Seat | null): Snapshot {
  const r = match.round;
  if (!r) return { counts: [], deck: 0, pending: 0, hands: [] };
  const seats = r.over ? match.seats : seenBy(match, seat);
  return {
    counts: r.hands.map((h) => h.length),
    deck: r.deck.length,
    pending: r.pendingDraw,
    hands: seats.map((s) => ({ seat: s, cards: copyCards(r.hands[s] ?? []) })),
  };
}

/** the redacted MatchState + counts one seat may know (see SeatView) */
export function seatView(match: MatchState, seat: Seat, legal: Move[], turnDeadline: number | null, windowEnds: number | null): SeatView {
  const r = match.round;
  const handCounts = r ? r.hands.map((h) => h.length) : [];
  const deckCount = r ? r.deck.length : 0;
  let round: unknown = null;
  if (r) {
    const seen = r.over ? match.seats : seenBy(match, seat);
    const out: Record<string, unknown> = {
      ...r,
      hands: r.hands.map((h, s) => (seen.includes(s as Seat) ? copyCards(h) : [])),
      deck: [],
      discard: copyCards(r.discard),
      window: redactWindow(r.window, seat),
      drawnCardId: seen.includes(r.turn) ? (r.drawnCardId ?? null) : null,
    };
    delete out.outPoints;
    delete out.challenge;
    // the pre-deal RNG state, with the deck spec and rules, reconstructs every hidden hand
    delete out.seed;
    round = JSON.parse(JSON.stringify(out));
  }
  const m = JSON.parse(JSON.stringify({ ...match, round: null })) as Record<string, unknown>;
  m.rng = 0;
  m.round = round;
  return { seat, match: m, handCounts, deckCount, legal: legal.map((x) => ({ ...x })), turnDeadline, windowEnds };
}

/** client: a SeatView's match with every unknown card as a placeholder (other hands, the deck) */
export function withPlaceholders(view: SeatView): MatchState {
  const m = view.match as MatchState;
  const r = m.round;
  if (!r) return m;
  const hands = r.hands.map((h, s) => {
    const known = (h ?? []).filter((c) => !isHidden(c));
    const n = view.handCounts[s] ?? known.length;
    return known.length >= n ? known : [...known, ...hiddenCards(n - known.length)];
  });
  const round: RoundState = { ...r, hands, deck: hiddenCards(view.deckCount) };
  return { ...m, round };
}
