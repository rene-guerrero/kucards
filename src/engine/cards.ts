import type { Card, CardFace, CardKind, Color, RuleSettings } from '../contracts';
import { COLORS } from '../contracts';

/** Points a card is worth in the hand of a player who did not win the round. */
export function cardPoints(face: CardFace): number {
  switch (face.kind) {
    case 'number':
      return face.value ?? 0;
    case 'skip':
    case 'reverse':
    case 'draw2':
    case 'skipAll':
    case 'draw6':
      return 20;
    default:
      return 50; // wilds, power cards, draw10, wildColor
  }
}

/** cards a penalty card makes the victim draw (0 = not a stackable penalty card) */
export const PENALTY_DRAW: Partial<Record<CardKind, number>> = { draw2: 2, wild4: 4, draw6: 6, draw10: 10 };

/**
 * Build the deck for a rule set (ids are positions in the returned array).
 * Classic: per colour one 0, two each of 1–9, skip, reverse, +2; plus 4 wild and 4 wild +4 (108).
 * Power cards (each behind its own `power.*` rule): swap ×2, shield / sweep / mirror ×1 per colour.
 * `deck: 'action'` thins the numbers (only 0 and 5–9) and doubles the action cards.
 * `deck: 'cyclone'` is the classic deck plus, per colour, one skipAll and one +6, plus 4 wild +10 and
 * 4 wild "draw until the colour" (124 before power cards).
 */
export function buildDeck(rules: RuleSettings): Card[] {
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
    if (cyclone) {
      add('skipAll', c, 1);
      add('draw6', c, 1);
    }
    if (rules['power.shield']) add('shield', c, 1);
    if (rules['power.sweep']) add('sweep', c, 1);
    if (rules['power.mirror']) add('mirror', c, 1);
  }
  add('wild', null, 4);
  add('wild4', null, 4);
  if (cyclone) {
    add('draw10', null, 4);
    add('wildColor', null, 4);
  }
  if (rules['power.swap']) add('swap', null, 2);
  return faces.map((face, id) => ({ id, face }));
}

/** cards without a colour of their own: the player picks the active colour */
export const isWildKind = (k: CardKind): boolean => k === 'wild' || k === 'wild4' || k === 'swap' || k === 'draw10' || k === 'wildColor';
/** penalty cards (stackable draw penalties) */
export const isPenaltyKind = (k: CardKind): boolean => (PENALTY_DRAW[k] ?? 0) > 0;
