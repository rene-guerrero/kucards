/** Test helpers: hand-built rounds. Not used by the game itself. */
import type { Card, CardKind, Color, GameMode, MatchState, RoundState, RuleSettings, Seat, Seating } from '../contracts';
import { PENALTY_DRAW } from './cards';
import { createMatch } from './game';
import { DEFAULT_RULES } from './rules';

let nextId = 1000;

export function card(kind: CardKind, color: Color | null = null, value?: number): Card {
  const face: Card['face'] = { kind, color };
  if (value !== undefined) face.value = value;
  const draw = PENALTY_DRAW[kind];
  if (draw) face.draw = draw;
  return { id: nextId++, face };
}
export const num = (color: Color, value: number) => card('number', color, value);

export interface Scenario {
  rules?: RuleSettings;
  mode?: GameMode;
  players?: 2 | 3 | 4;
  seating?: Seating;
  hands: Partial<Record<Seat, Card[]>>;
  top: Card;
  activeColor?: Color;
  deck?: Card[];
  discardUnder?: Card[];
  turn?: Seat;
  direction?: 1 | -1;
  pendingDraw?: number;
}

/** a match mid-round with exactly these hands / pile / deck */
export function scenario(s: Scenario): MatchState {
  const mode = s.mode ?? 'classic';
  const m = createMatch({ ...DEFAULT_RULES, ...(s.rules ?? {}) }, { mode, players: s.players ?? 4, seating: s.seating }, 7);
  const hands: Card[][] = [[], [], [], [], [], []];
  for (const seat of m.seats) hands[seat] = (s.hands[seat] ?? []).slice();
  const round: RoundState = {
    roundNo: 1,
    hands,
    deck: (s.deck ?? Array.from({ length: 20 }, () => num('coral', 9))).slice(),
    discard: [...(s.discardUnder ?? []), s.top],
    activeColor: s.activeColor ?? s.top.face.color ?? 'sol',
    turn: s.turn ?? m.seats[0],
    direction: s.direction ?? 1,
    pendingDraw: s.pendingDraw ?? 0,
    pendingFrom: null,
    window: null,
    kuCalled: [false, false, false, false, false, false],
    drewThisTurn: false,
    drawnCardId: null,
    side: 'light',
    eliminated: [false, false, false, false, false, false],
    over: false,
  };
  return { ...m, round };
}
