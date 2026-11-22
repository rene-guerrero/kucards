/**
 * The client's copy of the match during online play, kept in step by applying the (redacted, local
 * perspective) events in order, then correcting it with the batch Snapshot. The server owns the real
 * state; this copy only feeds what the local UI reads (HUD, plates, partner reveal, summaries, the
 * renderer's restore): cards the player may not see are placeholders (negative ids).
 */
import type { Card, GameEvent, GameMode, MatchState, RoundState, RuleSettings, Seat } from '../contracts';
import { hiddenCard, hiddenCards, isHidden } from './redact';
import type { Snapshot } from './protocol';

export function emptyMatch(rules: RuleSettings, mode: GameMode, seats: Seat[], teams?: [Seat[], Seat[]]): MatchState {
  return { rules, mode, seats: seats.slice(), scores: [0, 0, 0, 0, 0, 0], round: null, teams, over: false, winner: null, rng: 0 };
}

const six = <T>(v: T): T[] => [v, v, v, v, v, v];

/** take one card out of a hand: by id, else one of that kind, else a placeholder, else the last */
function takeOut(hand: Card[], id: number | null, kind?: string): Card | null {
  let i = id !== null ? hand.findIndex((c) => c.id === id) : -1;
  if (i < 0 && kind) i = hand.findIndex((c) => !isHidden(c) && c.face.kind === kind);
  if (i < 0) i = hand.findIndex((c) => isHidden(c));
  if (i < 0) i = hand.length - 1;
  return i >= 0 ? hand.splice(i, 1)[0] : null;
}

/** after hands moved: cards that left this player become anonymous (the snapshot restores a visible partner hand) */
function anonymize(r: RoundState): void {
  for (let s = 1; s < r.hands.length; s++) if (r.hands[s].some((c) => !isHidden(c))) r.hands[s] = hiddenCards(r.hands[s].length);
}

/** cards under the top of the pile (mirror / sweep go under it; the top stays) */
function underTop(discard: Card[], cards: Card[]): void {
  discard.splice(Math.max(0, discard.length - 1), 0, ...cards);
}

/**
 * apply one event (pure: returns a new state). `faceOf` gives the face of a real card id (the deck is
 * public: buildDeck(rules)), for swept cards whose faces the event does not carry.
 */
export function applyEvent(m: MatchState, ev: GameEvent, faceOf: (id: number) => Card | null = () => null): MatchState {
  if (ev.type === 'deal') {
    const hands = six<Card[]>([]).map((_, s) => (s === 0 ? (ev.hand ?? []).slice() : hiddenCards(ev.counts[s] ?? 0)));
    const round: RoundState = {
      roundNo: (m.round?.roundNo ?? 0) + 1,
      hands,
      deck: hiddenCards(ev.deck ?? 0),
      discard: [ev.firstCard],
      activeColor: ev.activeColor,
      turn: ev.starter,
      direction: 1,
      pendingDraw: 0,
      pendingFrom: null,
      window: null,
      kuCalled: six(false),
      drewThisTurn: false,
      drawnCardId: null,
      side: 'light',
      eliminated: six(false),
      over: false,
    };
    return { ...m, round };
  }
  if (ev.type === 'matchEnd') return { ...m, over: true, winner: ev.winner, winnerTeam: ev.winnerTeam ?? m.winnerTeam };
  const src = m.round;
  if (!src) return m;
  const r: RoundState = {
    ...src,
    hands: src.hands.map((h) => h.slice()),
    deck: src.deck.slice(),
    discard: src.discard.slice(),
    kuCalled: src.kuCalled.slice(),
    eliminated: src.eliminated.slice(),
  };
  let scores = m.scores;
  switch (ev.type) {
    case 'play': {
      takeOut(r.hands[ev.seat], ev.card.id);
      r.discard.push(ev.card);
      r.activeColor = ev.card.face.color ?? ev.color ?? r.activeColor;
      r.drewThisTurn = false;
      r.drawnCardId = null;
      break;
    }
    case 'draw': {
      const got = ev.cards && ev.cards.length === ev.count ? ev.cards.slice() : hiddenCards(ev.count);
      r.hands[ev.seat].push(...got);
      r.deck.splice(Math.max(0, r.deck.length - ev.count), ev.count);
      // a penalty draw settles the pending penalty (else the stale +N lingers into the next turns)
      if (ev.reason === 'penalty') {
        r.pendingDraw = 0;
        r.pendingFrom = null;
      }
      break;
    }
    case 'reverse':
      r.direction = ev.direction;
      break;
    case 'stack':
      r.pendingDraw = ev.total;
      break;
    case 'shield': {
      const c = takeOut(r.hands[ev.seat], null, 'shield');
      const top = ev.card ?? (c && !isHidden(c) ? c : { ...hiddenCard(), face: { kind: 'shield', color: null } });
      r.discard.push(top); // the shield is the new top card and sets the colour in play
      r.activeColor = top.face.color ?? r.activeColor;
      r.pendingDraw = 0;
      r.pendingFrom = null;
      break;
    }
    case 'mirror': {
      const c = takeOut(r.hands[ev.from], null, 'mirror');
      underTop(r.discard, [c && !isHidden(c) ? c : { ...hiddenCard(), face: { kind: 'mirror', color: null } }]);
      r.pendingDraw = ev.total;
      r.pendingFrom = ev.from;
      break;
    }
    case 'swapHands': {
      [r.hands[ev.a], r.hands[ev.b]] = [r.hands[ev.b], r.hands[ev.a]];
      [r.kuCalled[ev.a], r.kuCalled[ev.b]] = [r.kuCalled[ev.b], r.kuCalled[ev.a]];
      if (ev.cards && (ev.a === 0 || ev.b === 0)) r.hands[0] = ev.cards.slice();
      anonymize(r);
      break;
    }
    case 'rotateHands': {
      const live = m.seats.filter((s) => !r.eliminated[s]);
      const hands = r.hands.slice();
      const ku = r.kuCalled.slice();
      live.forEach((s, i) => {
        const to = live[(i + ev.direction + live.length) % live.length];
        hands[to] = r.hands[s];
        ku[to] = r.kuCalled[s];
      });
      r.hands = hands;
      r.kuCalled = ku;
      if (ev.cards && live.includes(0)) r.hands[0] = ev.cards.slice();
      anonymize(r);
      break;
    }
    case 'sweep': {
      const swept: Card[] = [];
      for (const id of ev.cardIds) {
        const c = takeOut(r.hands[ev.seat], id);
        swept.push(c && !isHidden(c) ? c : (faceOf(id) ?? { ...hiddenCard() }));
      }
      underTop(r.discard, swept);
      break;
    }
    case 'ku':
      r.kuCalled[ev.seat] = true;
      break;
    case 'window':
      r.window = ev.window;
      break;
    case 'flip':
      // everything turns over: my hand (sent turned), the discard pile, the colour in play
      r.side = ev.side;
      r.activeColor = ev.color;
      if (ev.hand) r.hands[0] = ev.hand.slice();
      r.discard = r.discard.map((c) => (c.other ? { ...c, face: c.other, other: c.face } : c));
      break;
    case 'eliminated': {
      r.eliminated[ev.seat] = true;
      r.deck = hiddenCards(r.hands[ev.seat].length).concat(r.deck);
      r.hands[ev.seat] = [];
      r.kuCalled[ev.seat] = false;
      break;
    }
    case 'reshuffle': {
      const top = r.discard[r.discard.length - 1];
      r.discard = top ? [top] : [];
      r.deck = hiddenCards(ev.count).concat(r.deck);
      break;
    }
    case 'turn':
      r.turn = ev.seat;
      r.drewThisTurn = false;
      r.drawnCardId = null;
      break;
    case 'roundEnd': {
      r.over = true;
      r.window = null;
      r.pendingDraw = 0;
      r.pendingFrom = null;
      scores = m.scores.map((v, s) => v + (ev.points[s] ?? 0));
      break;
    }
    default:
      break;
  }
  // (multiPlay: a ¡Ku! called with more cards, and the cards of a multi-play still landing, keep the flag)
  const keep = ev.type === 'ku' || (ev.type === 'play' && ev.more) ? ev.seat : -1;
  for (let s = 0; s < r.hands.length; s++) if (r.hands[s].length > 2 && s !== keep) r.kuCalled[s] = false;
  return { ...m, scores, round: r };
}

/** correct the copy with the batch snapshot (already in local perspective) */
export function applySnapshot(m: MatchState, snap: Snapshot): MatchState {
  const src = m.round;
  if (!src || !snap.counts.length) return m;
  const hands = src.hands.map((h, s) => {
    const known = snap.hands.find((x) => x.seat === s);
    if (known) return known.cards.slice();
    const n = snap.counts[s] ?? h.length;
    const out = h.filter((c) => !isHidden(c)).length > n ? hiddenCards(n) : h.slice();
    while (out.length > n) {
      const i = out.findIndex(isHidden);
      out.splice(i >= 0 ? i : out.length - 1, 1);
    }
    while (out.length < n) out.push(hiddenCard());
    return out;
  });
  const deck = src.deck.length === snap.deck ? src.deck : hiddenCards(snap.deck);
  return { ...m, round: { ...src, hands, deck, pendingDraw: snap.pending } };
}
