import type { Card, CardFace, CardKind, Color, MatchState, RuleSettings } from '../contracts';
import { COLORS, isNightColor, NIGHT_COLORS } from '../contracts';
import { Rng } from './rng';
import { DAY_SIDE_DECK, deckSpecForRules, NIGHT_SIDE_DECK, TWO_SIDED_KINDS, type DeckEntry, type DeckSpec } from './modes';

/** Points a card is worth in the hand of a player who did not win the round. */
export function cardPoints(face: CardFace): number {
  switch (face.kind) {
    case 'number':
      return face.value ?? 0;
    case 'skip':
    case 'reverse':
    case 'draw2':
    case 'flip':
      return 20;
    case 'skipAll':
    case 'draw6':
      // Día y Noche: the stronger night action cards are worth more
      return isNightColor(face.color) ? 30 : 20;
    default:
      return 50; // wilds, power cards, draw10, wildColor
  }
}

/** cards a penalty card makes the victim draw (0 = not a stackable penalty card) */
export const PENALTY_DRAW: Partial<Record<CardKind, number>> = { draw2: 2, wild4: 4, draw6: 6, draw10: 10 };

/**
 * Build the deck for a rule set (ids are positions in the returned array).
 * Classic: per colour one 0, two each of 1–9, skip, reverse, +2; plus 4 wild and 4 wild +4 (108).
 * Power cards (each behind its own `power.*` rule): swap ×2, sweep ×1 per colour (×2 in the cyclone and
 * sideBySide decks); shield / mirror ×1 per colour are retired: no preset or setting turns them on any more.
 * `deck: 'action'` thins the numbers (only 0 and 5–9) and doubles the action cards.
 * `deck: 'cyclone'` is the classic deck plus one +6 per colour, plus 6 wild +10 and 2 more wild +4
 * (120 before power cards). The wild "draw until the colour" (wildColor) is dealt in no deck any more
 * (the engine still plays it).
 * `deck: 'sideBySide'` is the classic deck plus one +6 per colour. Per-mode totals: see rules.ts.
 * skipAll (salto a todos) is in no built-in deck any more, day or night (the engine still plays it).
 * `deck: 'dayNight'` is two-sided: `spec` is the day side and `night` the night side (each defaults to
 * the Día y Noche list: modes.ts DAY_SIDE_DECK / NIGHT_SIDE_DECK).
 * Player-made decks pass their list as `spec` (and `night`).
 */
export function buildDeck(rules: RuleSettings, spec?: DeckSpec, night?: DeckSpec): Card[] {
  if (rules.deck === 'dayNight') return buildTwoSidedDeck(spec ?? DAY_SIDE_DECK, night ?? NIGHT_SIDE_DECK);
  return buildDeckFromSpec(spec ?? deckSpecForRules(rules));
}

/** the deck a match plays with (its rules plus a player-made mode's lists) */
export const matchDeck = (m: Pick<MatchState, 'rules' | 'deckSpec' | 'nightSpec'>): Card[] => buildDeck(m.rules, m.deckSpec, m.nightSpec);

/** a one-sided deck from its card list (modes.ts: DeckSpec), in the list's order; Eclipses are left out (they need a second side) */
export function buildDeckFromSpec(spec: DeckSpec): Card[] {
  const faces: CardFace[] = [];
  const add = (kind: CardKind, color: Color | null, n: number, extra: Partial<CardFace> = {}) => {
    if (TWO_SIDED_KINDS.includes(kind)) return;
    const draw = PENALTY_DRAW[kind];
    for (let i = 0; i < n; i++) faces.push({ kind, color, ...(draw ? { draw } : {}), ...extra });
  };
  for (const c of COLORS) {
    add('number', c, spec.numbers.zero, { value: 0 });
    for (let v = Math.max(1, spec.numbers.minValue); v <= 9; v++) add('number', c, spec.numbers.each, { value: v });
    for (const x of spec.perColor) add(x.kind, c, x.n);
  }
  for (const x of spec.wild) add(x.kind, null, x.n);
  return faces.map((face, id) => ({ id, face }));
}

/** cards without a colour of their own: the player picks the active colour */
export const isWildKind = (k: CardKind): boolean =>
  k === 'wild' || k === 'wild4' || k === 'swap' || k === 'draw10' || k === 'wildColor' || k === 'wildFlip' || k === 'sweepWild';
/** penalty cards (stackable draw penalties) */
export const isPenaltyKind = (k: CardKind): boolean => (PENALTY_DRAW[k] ?? 0) > 0;

/** Día y Noche: the night +5 (a 'draw6' kind card that makes the victim draw 5) */
export const NIGHT_DRAW = 5;
/** Día y Noche: the night Comodín +6 (a 'wild4' kind card that makes the victim draw 6) */
export const NIGHT_WILD_DRAW = 6;
/** night-side penalties that differ from the day ones (the rest draw what PENALTY_DRAW says) */
const NIGHT_PENALTY: Partial<Record<CardKind, number>> = { draw6: NIGHT_DRAW, wild4: NIGHT_WILD_DRAW };

/**
 * a list's entries dealt round-robin, the entries lined up at the end: an entry of n cards takes part in
 * the last n rounds. [skip 2, reverse 2, draw2 2, flip 1] → skip reverse draw2 skip reverse draw2 flip.
 */
function roundRobin(entries: readonly DeckEntry[]): CardKind[] {
  const max = entries.reduce((m, x) => Math.max(m, x.n), 0);
  const out: CardKind[] = [];
  for (let k = 0; k < max; k++) for (const x of entries) if (k >= max - x.n) out.push(x.kind);
  return out;
}

/**
 * the faces of one side of a two-sided deck: per colour (day or night colours) the numbers, then the
 * coloured entries round-robin; then the colourless ones round-robin. Night side: +5 / Comodín +6 for
 * draw6 / wild4, and colourless faces carry `night`.
 */
export function sideFaces(spec: DeckSpec, night: boolean): CardFace[] {
  const out: CardFace[] = [];
  const face = (kind: CardKind, color: Color | null, extra: Partial<CardFace> = {}): CardFace => {
    const draw = kind === 'number' ? 0 : ((night ? NIGHT_PENALTY[kind] : undefined) ?? PENALTY_DRAW[kind] ?? 0);
    return { kind, color, ...extra, ...(draw ? { draw } : {}), ...(night && color === null ? { night: true } : {}) };
  };
  const perColor = roundRobin(spec.perColor);
  for (const c of night ? NIGHT_COLORS : COLORS) {
    for (let i = 0; i < spec.numbers.zero; i++) out.push(face('number', c, { value: 0 }));
    for (let v = Math.max(1, spec.numbers.minValue); v <= 9; v++) for (let i = 0; i < spec.numbers.each; i++) out.push(face('number', c, { value: v }));
    for (const k of perColor) out.push(face(k, c));
  }
  for (const k of roundRobin(spec.wild)) out.push(face(k, null));
  return out;
}

/** Día y Noche, day side (112): per colour one 0, two of 1–9, two Salto / Vuelta / +2, one Eclipse; 4 Comodín, 4 +4 */
export const dayFaces = (): CardFace[] => sideFaces(DAY_SIDE_DECK, false);

/**
 * Día y Noche, night side (112): per colour one 0, two of 1–9, two +5, two Vuelta, two Salto, one
 * Eclipse; 4 Comodín, 4 Comodín +6 (a 'wild4' kind card with draw 6).
 */
export const nightFaces = (): CardFace[] => sideFaces(NIGHT_SIDE_DECK, true);

const special = (f: CardFace): boolean => f.color === null || f.kind === 'flip';

/**
 * Two-sided decks: day face i is paired with night face pairing[i]. A fixed shuffle (so ids stay a pure
 * function of the deck lists, like every deck) that is then repaired so no card is special on both sides
 * (a wild or Eclipse behind a wild or Eclipse) where a plain pair can take its place: a card's back says
 * nothing about its front beyond the plain odds (every day colour spreads over every night colour).
 * Both lists must be the same length.
 */
export function dayNightPairing(day: readonly CardFace[] = dayFaces(), night: readonly CardFace[] = nightFaces()): number[] {
  const rng = new Rng(0x6e0c7e);
  const p = night.map((_, i) => i);
  for (let i = p.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [p[i], p[j]] = [p[j], p[i]];
  }
  for (let i = 0; i < p.length; i++) {
    if (!(special(day[i]) && special(night[p[i]]))) continue;
    // swap with a pair whose day face is plain and whose night face is plain too
    for (let k = 1; k < p.length; k++) {
      const j = (i + k * 7) % p.length;
      if (!special(day[j]) && !special(night[p[j]])) {
        [p[i], p[j]] = [p[j], p[i]];
        break;
      }
    }
  }
  return p;
}

/** `faces` spread evenly over `size` slots (a shorter side repeats some of its faces, in order) */
function stretch(faces: CardFace[], size: number): CardFace[] {
  if (faces.length === size) return faces;
  return Array.from({ length: size }, (_, i) => faces[Math.floor((i * faces.length) / size)]);
}

const twoSidedCache = new Map<string, Card[]>();
/**
 * a two-sided deck from its day and night lists. The two sides hold the same number of cards: when the
 * lists differ, the shorter side repeats some of its faces, spread evenly (an empty side takes its
 * Día y Noche default).
 */
export function buildTwoSidedDeck(daySpec: DeckSpec, nightSpec: DeckSpec): Card[] {
  const key = JSON.stringify([daySpec, nightSpec]);
  let deck = twoSidedCache.get(key);
  if (!deck) {
    let day = sideFaces(daySpec, false);
    let night = sideFaces(nightSpec, true);
    if (!day.length) day = dayFaces();
    if (!night.length) night = nightFaces();
    const size = Math.max(day.length, night.length);
    day = stretch(day, size);
    night = stretch(night, size);
    const p = dayNightPairing(day, night);
    const nf = night;
    deck = day.map((face, id) => ({ id, face, other: nf[p[id]] }));
    if (twoSidedCache.size > 16) twoSidedCache.clear();
    twoSidedCache.set(key, deck);
  }
  return deck.map((c) => ({ id: c.id, face: { ...c.face }, other: { ...c.other! } }));
}

/** Día y Noche: the card turned over (face and other swapped); cards without another side stay */
export const turnOver = (c: Card): Card => (c.other ? { id: c.id, face: c.other, other: c.face } : c);

/** the colour on the other side that takes the place of `c` (same slot) */
export const otherSideColor = (c: Color): Color => {
  const i = (COLORS as readonly Color[]).indexOf(c);
  return i >= 0 ? NIGHT_COLORS[i] : COLORS[Math.max(0, (NIGHT_COLORS as readonly Color[]).indexOf(c))];
};
