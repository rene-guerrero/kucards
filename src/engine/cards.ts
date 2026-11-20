import type { Card, CardFace, CardKind, Color, RuleSettings } from '../contracts';
import { COLORS, isNightColor, NIGHT_COLORS } from '../contracts';
import { Rng } from './rng';

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
 * skipAll (salto a todos) is in no deck any more, day or night (the engine still plays it).
 */
export function buildDeck(rules: RuleSettings): Card[] {
  if (rules.deck === 'dayNight') return buildDayNightDeck();
  const faces: CardFace[] = [];
  const action = rules.deck === 'action';
  const cyclone = rules.deck === 'cyclone';
  const add = (kind: CardKind, color: Color | null, n: number, extra: Partial<CardFace> = {}) => {
    const draw = PENALTY_DRAW[kind];
    for (let i = 0; i < n; i++) faces.push({ kind, color, ...(draw ? { draw } : {}), ...extra });
  };
  for (const c of COLORS) {
    add('number', c, 1, { value: 0 });
    for (let v = 1; v <= 9; v++) if (!action || v >= 5) add('number', c, 2, { value: v });
    add('skip', c, action ? 4 : 2);
    add('reverse', c, action ? 4 : 2);
    add('draw2', c, action ? 4 : 2);
    if (cyclone || rules.deck === 'sideBySide') add('draw6', c, 1);
    if (rules['power.shield']) add('shield', c, 1);
    if (rules['power.sweep']) add('sweep', c, cyclone || rules.deck === 'sideBySide' ? 2 : 1);
    if (rules['power.mirror']) add('mirror', c, 1);
  }
  add('wild', null, 4);
  add('wild4', null, 4);
  if (cyclone) {
    add('draw10', null, 6);
    add('wild4', null, 2);
  }
  if (rules['power.swap']) add('swap', null, 2);
  return faces.map((face, id) => ({ id, face }));
}

/** cards without a colour of their own: the player picks the active colour */
export const isWildKind = (k: CardKind): boolean => k === 'wild' || k === 'wild4' || k === 'swap' || k === 'draw10' || k === 'wildColor';
/** penalty cards (stackable draw penalties) */
export const isPenaltyKind = (k: CardKind): boolean => (PENALTY_DRAW[k] ?? 0) > 0;

/** Día y Noche: the night +5 (a 'draw6' kind card that makes the victim draw 5) */
export const NIGHT_DRAW = 5;
/** Día y Noche: the night Comodín +6 (a 'wild4' kind card that makes the victim draw 6) */
export const NIGHT_WILD_DRAW = 6;

/** Día y Noche, day side (112): per colour one 0, two of 1–9, two Salto / Vuelta / +2, one Eclipse; 4 Comodín, 4 +4 */
export function dayFaces(): CardFace[] {
  const out: CardFace[] = [];
  for (const c of COLORS) {
    out.push({ kind: 'number', color: c, value: 0 });
    for (let v = 1; v <= 9; v++) out.push({ kind: 'number', color: c, value: v }, { kind: 'number', color: c, value: v });
    for (let i = 0; i < 2; i++) out.push({ kind: 'skip', color: c }, { kind: 'reverse', color: c }, { kind: 'draw2', color: c, draw: 2 });
    out.push({ kind: 'flip', color: c });
  }
  for (let i = 0; i < 4; i++) out.push({ kind: 'wild', color: null }, { kind: 'wild4', color: null, draw: 4 });
  return out;
}

/**
 * Día y Noche, night side (112): per colour one 0, two of 1–9, two +5, two Vuelta, two Salto total
 * (everyone else loses a turn), one Eclipse; 4 Comodín, 4 Comodín +6 (a 'wild4' kind card with draw 6).
 */
export function nightFaces(): CardFace[] {
  const out: CardFace[] = [];
  for (const c of NIGHT_COLORS) {
    out.push({ kind: 'number', color: c, value: 0 });
    for (let v = 1; v <= 9; v++) out.push({ kind: 'number', color: c, value: v }, { kind: 'number', color: c, value: v });
    for (let i = 0; i < 2; i++) out.push({ kind: 'draw6', color: c, draw: NIGHT_DRAW }, { kind: 'reverse', color: c }, { kind: 'skip', color: c });
    out.push({ kind: 'flip', color: c });
  }
  for (let i = 0; i < 4; i++) out.push({ kind: 'wild', color: null, night: true }, { kind: 'wild4', color: null, draw: NIGHT_WILD_DRAW, night: true });
  return out;
}

const special = (f: CardFace): boolean => f.color === null || f.kind === 'flip';

/**
 * Día y Noche: day face i is paired with night face pairing[i]. A fixed shuffle (so ids stay a pure
 * function of the rules, like every deck) that is then repaired so no card is special on both sides
 * (a wild or Eclipse behind a wild or Eclipse): a card's back says nothing about its front beyond the
 * plain odds (every day colour spreads over every night colour).
 */
export function dayNightPairing(): number[] {
  const day = dayFaces();
  const night = nightFaces();
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

let dayNightCache: Card[] | null = null;
function buildDayNightDeck(): Card[] {
  if (!dayNightCache) {
    const day = dayFaces();
    const night = nightFaces();
    const p = dayNightPairing();
    dayNightCache = day.map((face, id) => ({ id, face, other: night[p[id]] }));
  }
  return dayNightCache.map((c) => ({ id: c.id, face: { ...c.face }, other: { ...c.other! } }));
}

/** Día y Noche: the card turned over (face and other swapped); cards without another side stay */
export const turnOver = (c: Card): Card => (c.other ? { id: c.id, face: c.other, other: c.face } : c);

/** the colour on the other side that takes the place of `c` (same slot) */
export const otherSideColor = (c: Color): Color => {
  const i = (COLORS as readonly Color[]).indexOf(c);
  return i >= 0 ? NIGHT_COLORS[i] : COLORS[Math.max(0, (NIGHT_COLORS as readonly Color[]).indexOf(c))];
};
