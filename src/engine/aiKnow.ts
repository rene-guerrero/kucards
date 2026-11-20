/**
 * What a CPU seat may legitimately know (hard / master levels): public information only.
 *
 *  - unseen cards: everything that is not in its own hand, on the discard pile or (Parejas with
 *    `partnerOpen`) in its partner's face-up hand. Counted per colour / kind. The multiset is read from
 *    the hidden zones of the state, which is exactly "deck minus what this seat has seen".
 *  - voids: colours a seat could not follow (it drew on its turn and the turn moved on).
 *  - likes: colours a seat chose after a wild (it probably holds more of them).
 *
 * Voids and likes need history, which MatchState does not keep. A small module-level tracker diffs the
 * successive states CPU seats are asked about (all CPU seats feed the same public log). Tracks are keyed
 * per round (RoundState.seed, the RNG state the round was dealt from, plus the round number and seats),
 * so two matches in one process (online: many rooms in one server) never share a track; within a key the
 * discard-pile lineage must still match. The cache is a small LRU (MAX_TRACKS rounds), so a long-running
 * server does not grow. It only ever reads public data (hand counts, the pile, the active colour, whose
 * turn it was), so sharing a track between the seats of one match leaks nothing.
 */
import type { Card, CardKind, Color, MatchState, RoundState, Seat } from '../contracts';
import { colorSlot } from '../contracts';

/** a colour's slot 0–3 (Día y Noche: night colours share the slots of the day ones; one side is in play) */
export const colorIdx = (c: Color): number => colorSlot(c);
export const bit = (c: Color): number => 1 << colorIdx(c);

/** wild-type card (no colour of its own): wild, wild4, swap, draw10, wildColor… */
export const isWildCard = (c: Card): boolean => c.face.color === null && c.face.kind !== 'flip';

/** cards a penalty card makes the victim draw (0 for non-penalties; wildColor counts as ~3) */
export function drawOf(c: Card): number {
  const f = c.face;
  if (f.draw) return f.draw;
  switch (f.kind) {
    case 'draw2':
      return 2;
    case 'wild4':
      return 4;
    case 'draw6':
      return 6;
    case 'draw10':
      return 10;
    case 'wildColor':
      return 3;
    default:
      return 0;
  }
}
export const PENALTY_KINDS: readonly CardKind[] = ['draw2', 'wild4', 'draw6', 'draw10', 'wildColor'];
export const isPenaltyCard = (c: Card): boolean => PENALTY_KINDS.includes(c.face.kind);

export function partnerOf(m: MatchState, seat: Seat): Seat | null {
  if (!m.teams) return null;
  const team = m.teams[0].includes(seat) ? m.teams[0] : m.teams[1];
  return team.find((s) => s !== seat) ?? null;
}

/** Parejas with partnerOpen (default on): the partner's hand is face up for this seat */
export function partnerHand(m: MatchState, r: RoundState, seat: Seat): Card[] | null {
  const p = partnerOf(m, seat);
  if (p === null || m.rules.partnerOpen === false || r.eliminated[p]) return null;
  return r.hands[p];
}

export interface Knowledge {
  seat: Seat;
  partner: Seat | null;
  /** the partner's exact hand when it is face up */
  pHand: Card[] | null;
  /** unseen cards per colour index (coloured cards only) */
  unseen: number[];
  unseenTotal: number;
  /** unseen number cards per value 0–9 */
  unseenVal: number[];
  /** unseen wild-type cards, penalty wilds (+4 / +10), shields, mirrors */
  unseenWild: number;
  unseenWildPenalty: number;
  unseenShield: number;
  unseenMirror: number;
  /** by seat: colour bitmask the seat could not follow */
  voids: number[];
  /** by seat: colour bitmask the seat chose after a wild */
  likes: number[];
  /** active colour before the last card went on the pile (null when unknown) */
  prevColor: Color | null;
}

export function knowledge(m: MatchState, r: RoundState, seat: Seat, track: Track | null): Knowledge {
  const partner = partnerOf(m, seat);
  const pHand = partnerHand(m, r, seat);
  const unseen = [0, 0, 0, 0];
  const unseenVal = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  let unseenTotal = 0;
  let unseenWild = 0;
  let unseenWildPenalty = 0;
  let unseenShield = 0;
  let unseenMirror = 0;
  const add = (c: Card) => {
    unseenTotal++;
    const col = c.face.color;
    if (col) {
      unseen[colorIdx(col)]++;
      if (c.face.kind === 'number') unseenVal[c.face.value ?? 0]++;
    } else if (isWildCard(c)) {
      unseenWild++;
      if (drawOf(c) >= 4) unseenWildPenalty++;
    }
    if (c.face.kind === 'shield') unseenShield++;
    else if (c.face.kind === 'mirror') unseenMirror++;
  };
  for (const s of m.seats) {
    if (s === seat || (pHand && s === partner)) continue;
    for (const c of r.hands[s]) add(c);
  }
  for (const c of r.deck) add(c);
  return {
    seat, partner, pHand, unseen, unseenTotal, unseenVal, unseenWild, unseenWildPenalty, unseenShield, unseenMirror,
    voids: track ? track.voids.slice() : [0, 0, 0, 0, 0, 0],
    likes: track ? track.likes.slice() : [0, 0, 0, 0, 0, 0],
    prevColor: track ? track.prevColor : null,
  };
}

// ───────────────────────── public-history tracker ─────────────────────────

interface Snap {
  roundNo: number;
  seatsKey: string;
  pile: number[];
  counts: number[];
  turn: Seat;
  active: Color;
  pending: number;
  drew: boolean;
  penaltyWindow: boolean;
}

export interface Track {
  snap: Snap;
  voids: number[];
  likes: number[];
  /** active colour before the current top card (for +4 challenges) */
  prevColor: Color | null;
}

/** rounds remembered at once (LRU); a server with more live CPU rooms only loses some void inferences */
export const MAX_TRACKS = 32;
/** at most this many lineages per key (only rounds without a seed, or identical seeds, share a key) */
const MAX_PER_KEY = 4;
/** key -> tracks; Map order is the LRU order (least recently used first) */
const TRACKS = new Map<string, Track[]>();

function trackKey(m: MatchState, r: RoundState): string {
  // older saves / hand-built rounds have no seed: they fall back to the pile lineage inside one bucket
  return `${r.seed ?? 'x'}:${r.roundNo}:${m.seats.join(',')}`;
}

/** tests: number of rounds tracked */
export const trackerSize = (): number => TRACKS.size;

function snapOf(m: MatchState, r: RoundState): Snap {
  return {
    roundNo: r.roundNo,
    seatsKey: m.seats.join(','),
    pile: r.discard.map((c) => c.id),
    counts: r.hands.map((h) => h.length),
    turn: r.turn,
    active: r.activeColor,
    pending: r.pendingDraw,
    drew: r.drewThisTurn,
    penaltyWindow: r.window?.reason === 'penalty',
  };
}

const isPrefix = (a: number[], b: number[]) => a.length <= b.length && a.every((x, i) => b[i] === x);

/** after a reshuffle the pile restarts with the old top card */
const afterReshuffle = (prev: number[], cur: number[]) => cur.length > 0 && cur.length < prev.length + 8 && prev.includes(cur[0]) && !isPrefix(prev, cur);

/** feed the tracker with the state a CPU is asked about; returns the round's track */
export function observe(m: MatchState): Track | null {
  const r = m.round;
  if (!r) return null;
  const cur = snapOf(m, r);
  const key = trackKey(m, r);
  const bucket = TRACKS.get(key) ?? [];
  // most recently used last
  TRACKS.delete(key);
  TRACKS.set(key, bucket);
  let t: Track | undefined;
  let reshuffled = false;
  for (let i = bucket.length - 1; i >= 0; i--) {
    const x = bucket[i];
    if (isPrefix(x.snap.pile, cur.pile)) t = x;
    else if (afterReshuffle(x.snap.pile, cur.pile)) {
      t = x;
      reshuffled = true;
    } else continue;
    bucket.splice(i, 1);
    bucket.push(t);
    break;
  }
  if (!t) {
    t = { snap: cur, voids: [0, 0, 0, 0, 0, 0], likes: [0, 0, 0, 0, 0, 0], prevColor: null };
    bucket.push(t);
    if (bucket.length > MAX_PER_KEY) bucket.shift();
    while (TRACKS.size > MAX_TRACKS) TRACKS.delete(TRACKS.keys().next().value as string);
    return t;
  }
  if (!reshuffled) infer(t, t.snap, cur, r, m);
  else {
    // counts are still comparable; plays in between are unknown: only forget what drawing invalidates
    for (let s = 0; s < cur.counts.length; s++) if (cur.counts[s] > t.snap.counts[s]) t.voids[s] = 0;
    t.prevColor = null;
  }
  t.snap = cur;
  return t;
}

function infer(t: Track, prev: Snap, cur: Snap, r: RoundState, m: MatchState): void {
  const k = cur.pile.length - prev.pile.length;
  if (k === 0) {
    if (cur.active !== prev.active) t.prevColor = null;
    for (let s = 0; s < cur.counts.length; s++) {
      if (cur.counts[s] <= prev.counts[s]) continue;
      const turnDraw = s === prev.turn && prev.pending === 0 && !prev.drew && !prev.penaltyWindow && cur.counts[s] === prev.counts[s] + 1;
      if (turnDraw && cur.turn !== s) {
        // drew on its turn and could not play the drawn card either: no card of the active colour
        t.voids[s] |= bit(prev.active);
        t.likes[s] &= ~bit(prev.active);
      } else if (!(turnDraw && cur.turn === s)) t.voids[s] = 0; // penalty / catch cards: unknown colours
    }
    return;
  }
  const added = r.discard.slice(prev.pile.length);
  // hands moved around (7 / 0 / swap): per-seat knowledge no longer applies
  const seven = !!m.rules.sevenZero;
  if (added.some((c) => c.face.kind === 'swap' || (seven && c.face.kind === 'number' && (c.face.value === 7 || c.face.value === 0)))) {
    t.voids = [0, 0, 0, 0, 0, 0];
    t.likes = [0, 0, 0, 0, 0, 0];
    t.prevColor = k === 1 ? prev.active : null;
    return;
  }
  t.prevColor = k === 1 ? prev.active : null;
  const droppers: number[] = [];
  for (let s = 0; s < cur.counts.length; s++) {
    if (cur.counts[s] > prev.counts[s]) t.voids[s] = 0;
    else if (cur.counts[s] < prev.counts[s]) droppers.push(s);
  }
  if (droppers.length === 1) {
    const s = droppers[0];
    for (const c of added) if (c.face.color) t.voids[s] &= ~bit(c.face.color);
    if (k === 1 && isWildCard(added[0])) t.likes[s] |= bit(cur.active);
  }
}

/** tests: forget everything */
export function resetTracker(): void {
  TRACKS.clear();
}
