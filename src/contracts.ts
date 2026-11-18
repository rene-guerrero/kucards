/**
 * SHARED CONTRACTS — the single source of truth between the modules:
 *   src/engine  (pure rules + CPU, no DOM, no three.js, deterministic from a seed)
 *   src/render  (three.js card table + animations + card input)
 *   src/ui      (HTML overlay: menus, settings, HUD, audio, i18n) and src/app (controller)
 *   server/     (online rooms, phase 8: runs the same engine)
 *
 * Do NOT change exported shapes without telling the coordinator; modules are built in parallel against
 * this file. Adding optional fields is OK. See PLAN.md §3.
 */

// ───────────────────────── Cards ─────────────────────────

export type Color = 'sol' | 'mar' | 'palma' | 'coral';
export const COLORS: readonly Color[] = ['sol', 'mar', 'palma', 'coral'];

export type CardKind =
  | 'number'
  | 'skip' // Salto
  | 'reverse' // Vuelta
  | 'draw2' // +2
  | 'wild' // Comodín
  | 'wild4' // Comodín +4
  | 'swap' // Cambio (power, wild): swap hands with a chosen player
  | 'shield' // Escudo (power): cancels a pending draw penalty, also out of turn
  | 'sweep' // Barrida (power): discard every other card of its colour from your hand
  | 'mirror' // Espejo (power): sends the pending penalty back to whoever played the last card
  | 'flip' // Eclipse (Día y Noche only, optional later phase)
  // Ciclón (harsh) extra cards, only in decks built with rules.deck === 'cyclone' (phase 4)
  | 'skipAll' // coloured: everyone else loses a turn, you play again
  | 'draw6' // coloured: next player draws 6 (stackable)
  | 'draw10' // wild: choose a colour, next player draws 10 (stackable)
  | 'wildColor'; // wild "draw until the colour": next player draws until they get the colour you chose

export const POWER_KINDS: readonly CardKind[] = ['swap', 'shield', 'sweep', 'mirror'];
export const CYCLONE_KINDS: readonly CardKind[] = ['skipAll', 'draw6', 'draw10', 'wildColor'];

export interface CardFace {
  kind: CardKind;
  /** null for wild-type cards (wild, wild4, swap) */
  color: Color | null;
  /** 0–9 for 'number' */
  value?: number;
  /** cards a penalty card makes the victim draw (draw2 = 2, wild4 = 4, harsh mode adds bigger ones) */
  draw?: number;
}

/** id = stable index into the deck the match was created with */
export interface Card {
  id: number;
  face: CardFace;
  /** Día y Noche only: the dark face */
  dark?: CardFace;
}

// ───────────────────────── Seats & modes ─────────────────────────

/** 0 = human (bottom of the screen). v1 ships 2–4 players; 4 and 5 are reserved for 5–6 players. */
export type Seat = 0 | 1 | 2 | 3 | 4 | 5;
export type Direction = 1 | -1;

export type GameMode = 'classic' | 'action' | 'cyclone' | 'partners';

/** Parejas seating: 'across' = A B A B (partners opposite), 'side' = A A B B (Codo a codo). */
export type Seating = 'across' | 'side';

export interface MatchSetup {
  mode: GameMode;
  players: 2 | 3 | 4;
  /** partners mode only */
  seating?: Seating;
  /**
   * side seating only: is the human's partner the neighbour who plays right AFTER them (seat 1, teams
   * [[0,1],[2,3]], default) or right BEFORE them (seat 3, teams [[0,3],[1,2]])? The app picks at random.
   */
  partnerSide?: 'after' | 'before';
}

// ───────────────────────── Moves ─────────────────────────

export type Move =
  /**
   * color: required for wild-type cards; target: required for swap (and 7 with the 7-0 rule).
   * give: partnerPass (Parejas, not with 7-0): with a 7, the id of one more card handed to the partner.
   */
  | { kind: 'play'; seat: Seat; cardId: number; color?: Color; target?: Seat; ku?: boolean; give?: number }
  | { kind: 'draw'; seat: Seat }
  /** after drawing a playable card the player may keep it (unless forcePlay) */
  | { kind: 'pass'; seat: Seat }
  | { kind: 'acceptPenalty'; seat: Seat }
  | { kind: 'callKu'; seat: Seat }
  | { kind: 'catchKu'; seat: Seat; target: Seat }
  /** out of turn: an identical card (same colour and face) */
  | { kind: 'jumpIn'; seat: Seat; cardId: number; target?: Seat }
  /** out of turn during a penalty window: shield or mirror */
  | { kind: 'respond'; seat: Seat; cardId: number }
  /** wild4Challenge: the victim of a +4 says it was played illegally (the player held the active colour) */
  | { kind: 'challenge'; seat: Seat };

/**
 * A response window: a short moment after a move where some seats may act out of turn (shield / mirror
 * against a penalty, jump-in, catching a missed ¡Ku!). The engine opens it; the controller (offline) or
 * the server (online) closes it with EngineApi.closeWindow after the timeout if nobody acted.
 */
export interface ResponseWindow {
  reason: 'penalty' | 'jumpIn' | 'ku';
  /** seats that may act */
  seats: Seat[];
  /** penalty windows: the seat that has to draw if nobody responds */
  victim?: Seat;
}

// ───────────────────────── Game state ─────────────────────────

export interface RoundState {
  roundNo: number; // 1-based
  /**
   * The match RNG state the round was dealt from: a stable per-round identity. The CPU's public-history
   * tracker keys on it, so matches running in one process (online rooms) never share history.
   * Older saves lack it.
   */
  seed?: number;
  /** by seat. Hidden information: only the engine and the seat's owner may see a hand. */
  hands: Card[][];
  /** face down, drawn from the END. Hidden information. */
  deck: Card[];
  /** top = last */
  discard: Card[];
  activeColor: Color;
  turn: Seat;
  direction: Direction;
  /** stacked penalty waiting to be drawn, 0 = none */
  pendingDraw: number;
  /** the seat that played the last penalty card (mirror target) */
  pendingFrom: Seat | null;
  window: ResponseWindow | null;
  /** by seat: has called ¡Ku! for their current last card */
  kuCalled: boolean[];
  /** by seat: drew this turn (may then play the drawn card or pass) */
  drewThisTurn: boolean;
  /** the card drawn this turn (may be played right away) */
  drawnCardId?: number | null;
  /** engine-internal: points eliminated seats held when they went out */
  outPoints?: number[];
  side: 'light' | 'dark';
  eliminated: boolean[];
  over: boolean;
}

export interface MatchState {
  rules: RuleSettings;
  mode: GameMode;
  /** seats in play, in turn order for direction 1 */
  seats: Seat[];
  /** by seat (partners: both partners carry the team score) */
  scores: number[];
  round: RoundState | null;
  /** partners mode: the two teams as seat lists */
  teams?: [Seat[], Seat[]];
  over: boolean;
  winner: Seat | null;
  /** partners mode: the winning team index */
  winnerTeam?: 0 | 1 | null;
  /** opaque RNG state so matches are reproducible from a seed */
  rng: number;
}

/** What the renderer/UI animate. The engine returns them in order from every transition. */
export type GameEvent =
  /** hand: the viewer's own cards (seat 0 offline; the server fills each player's); deck: cards left in the deck */
  | { type: 'deal'; counts: number[]; starter: Seat; firstCard: Card; activeColor: Color; hand?: Card[]; deck?: number }
  | { type: 'play'; seat: Seat; card: Card; color?: Color }
  /** cards: the faces, only present for whoever may see them (the engine fills them; redaction strips them) */
  | { type: 'draw'; seat: Seat; count: number; cards?: Card[]; reason: 'turn' | 'penalty' | 'ku' | 'catch' }
  | { type: 'skip'; seat: Seat }
  | { type: 'reverse'; direction: Direction }
  | { type: 'stack'; total: number }
  | { type: 'shield'; seat: Seat }
  | { type: 'mirror'; from: Seat; to: Seat; total: number }
  /** cards: the viewer's new hand when it changed (seat 0 offline; the server fills it per player) */
  | { type: 'swapHands'; a: Seat; b: Seat; cards?: Card[] }
  | { type: 'rotateHands'; direction: Direction; cards?: Card[] }
  | { type: 'sweep'; seat: Seat; cardIds: number[] }
  | { type: 'ku'; seat: Seat }
  | { type: 'kuCaught'; by: Seat; target: Seat }
  | { type: 'window'; window: ResponseWindow | null }
  | { type: 'flip'; side: 'light' | 'dark' }
  | { type: 'eliminated'; seat: Seat }
  | { type: 'reshuffle'; count: number }
  | { type: 'turn'; seat: Seat }
  | { type: 'roundEnd'; winner: Seat; points: number[] }
  | { type: 'matchEnd'; winner: Seat | null; winnerTeam?: 0 | 1 | null };

// ───────────────────────── Settings (data-driven) ─────────────────────────

/**
 * Rule settings are a flat record. The ENGINE owns the descriptors (`RULE_SETTINGS`) and presets; the
 * settings screen renders them generically, so new variants need no UI work.
 */
export type SettingValue = string | number | boolean;
export type RuleSettings = Record<string, SettingValue>;

export type Loc = { es: string; en: string };

export interface SettingDescriptor {
  key: string;
  /** grouping header in the settings screen, e.g. 'turn', 'penalties', 'power', 'match' */
  group: string;
  type: 'toggle' | 'select';
  options?: { value: SettingValue; label: Loc; short?: Loc }[];
  default: SettingValue;
  label: Loc;
  short?: Loc;
  help?: Loc;
  /** only shown for these modes (missing = all) */
  modes?: GameMode[];
}

export interface RulePreset {
  id: GameMode;
  label: Loc;
  /** one-line pitch on the new-game screen */
  blurb: Loc;
  rules: RuleSettings;
}

export type Difficulty = 'easy' | 'normal' | 'hard' | 'master';

/** Card-game play styles: light biases on top of a CPU level (see src/roster.ts for who has which). */
export type PlayStyle =
  | 'carefree' // plays the first card that fits
  | 'impulsive' // dumps high numbers fast, forgets ¡Ku! now and then
  | 'beginner' // the basics only
  | 'balanced' // keeps a colour of each
  | 'byTheBook' // numbers first, actions when needed
  | 'chatty' // calls ¡Ku! early, catches others
  | 'aggressive' // penalties first, aims at the leader
  | 'hoarder' // keeps wilds and +4 for the end
  | 'teamPlayer' // partners: protects the partner, holds penalties for opponents
  | 'perfect'; // counts every card

export interface EngineApi {
  RULE_SETTINGS: SettingDescriptor[];
  DEFAULT_RULES: RuleSettings;
  RULE_PRESETS: RulePreset[];
  createMatch(rules: RuleSettings, setup: MatchSetup, seed?: number): MatchState;
  startRound(match: MatchState): { match: MatchState; events: GameEvent[] };
  /** moves for `seat` (default: the seat whose turn it is). During a window, out-of-turn moves too. */
  legalMoves(match: MatchState, seat?: Seat): Move[];
  applyMove(match: MatchState, move: Move): { match: MatchState; events: GameEvent[] };
  /** the response timer ran out: resolve the window (e.g. the victim draws the penalty) */
  closeWindow(match: MatchState): { match: MatchState; events: GameEvent[] };
  /** null = no reaction (window moves are optional) */
  chooseMove(match: MatchState, seat: Seat, level: Difficulty, style?: PlayStyle): Move | null;
}

// ───────────────────────── Renderer / app ─────────────────────────

/** Phase 1 keeps the Kudominoes names so the synth carries over; phase 3 adds card sounds. */
export type SfxName =
  | 'shuffle'
  | 'deal'
  | 'clack' // card lands on the pile
  | 'slam' // emphatic play (penalty / last card)
  | 'pass'
  | 'select'
  | 'invalid'
  | 'winHand'
  | 'loseHand'
  | 'winMatch'
  | 'loseMatch'
  | 'tranque'
  | 'charge'
  // phase 4/5 card sounds
  | 'draw' // a card slides off the deck
  | 'ku' // bright two-note sting
  | 'shield' // metallic clang
  | 'mirror' // glassy whoosh
  | 'thump'; // low thump for a big penalty (+4 and up)

export type Quality = 'low' | 'medium' | 'high';

export interface FrameStats {
  avgFrameMs: number;
  frames: number;
  quality: Quality;
}

export type TableStyle = 'teal' | 'navy' | 'wine' | 'charcoal' | 'wood' | 'sand';
export const TABLE_STYLES: TableStyle[] = ['teal', 'navy', 'wine', 'charcoal', 'wood', 'sand'];
export type CardBack = 'ku' | 'weave' | 'sun' | 'night';
export const CARD_BACKS: CardBack[] = ['ku', 'weave', 'sun', 'night'];

/** The characters in the CPU seats (roster ids), by seat. Missing seats are free. */
export type Lineup = Partial<Record<1 | 2 | 3, string>>;

/** One HTML name plate box, in CSS px relative to the view container (y down). Same idea as Kudominoes. */
export interface SeatPlate {
  seat: Seat;
  /** box centre */
  x: number;
  y: number;
  w: number;
  h: number;
  /** avatar diameter */
  d: number;
  layout: 'row' | 'stack';
  scale: number;
  visible: boolean;
  active: boolean;
  winner: boolean;
  /** cards in hand */
  count: number;
  /** partners mode: team index for a colour badge */
  team?: 0 | 1;
  /** where a speech bubble attaches (see Kudominoes contract) */
  bubble?: { x: number; y: number; dir: 'left' | 'right' | 'up' | 'down' };
}

export interface TableViewOptions {
  container: HTMLElement; // the renderer creates and owns its <canvas> inside
  quality: Quality;
  language?: 'es' | 'en';
  reducedMotion?: boolean;
  /** animation speed multiplier (1 = normal) */
  speed?: number;
  tableStyle?: TableStyle;
  cardBack?: CardBack;
  /** seats in play (turn order for direction 1); default [0, 1, 2, 3] */
  seats?: Seat[];
  onSfx?: (name: SfxName) => void;
  /** every layout change / turn change: the HTML plates (avatars, names, counts) follow these boxes */
  onPlates?: (plates: readonly SeatPlate[]) => void;
  onFrameStats?: (stats: FrameStats) => void;
  onError?: (err: unknown) => void;
}

/** Everything needed to put a saved round on the table in one frame. */
export interface RestoreState {
  round: RoundState;
  seats: Seat[];
}

/**
 * Public renderer API — `createTableView(opts): TableView` exported from src/render/index.ts.
 * The HUD (src/ui) draws the colour picker, target picker, ¡Ku! button and response buttons; the view
 * only handles the 3D table and card input. The controller (src/app, phase 3) glues them.
 */
export interface TableView {
  /** animate an engine event; resolves when the next event may start */
  handle(event: GameEvent): Promise<void>;
  /**
   * The human (seat 0) picks a card to play or taps the deck to draw. Resolves with the chosen card id
   * or 'draw'. Playable cards (`playable`) lift and glow; others are dimmed and shake on tap.
   * The controller turns the choice into a Move (asking the HUD for colour / target when needed).
   */
  requestHumanPick(playable: number[], canDraw: boolean): Promise<number | 'draw'>;
  /** drop a pending requestHumanPick (its promise never resolves) */
  cancelHumanPick(): void;
  setTurn(seat: Seat | null): void;
  /** clear the table (between rounds / back to menu); an idle attract animation is welcome */
  reset(): void;
  restore?(state: RestoreState): Promise<void>;
  setQuality(q: Quality): void;
  setPaused(paused: boolean): void;
  setSpeed?(x: number): void;
  setReducedMotion?(r: boolean): void;
  setTableStyle?(s: TableStyle): void;
  setCardBack?(b: CardBack): void;
  /**
   * Show another seat's hand face up (Parejas with partnerOpen: your partner's cards), or null to hide it
   * again. Called after every change to that hand; the fan stays where it is, cards just turn face up.
   */
  setOpenHand?(seat: Seat, cards: Card[] | null): void;
  dispose(): void;
}

export interface AppSettings {
  language: 'es' | 'en';
  quality: Quality;
  qualityMode?: 'auto' | 'manual';
  autoQuality?: Quality;
  sound: boolean;
  music: boolean;
  vibration: boolean;
  animationSpeed: 'normal' | 'fast';
  playerName: string;
  rules: RuleSettings;
  mode?: GameMode;
  reducedMotion?: boolean;
  rulesVersion?: number;
  /** rules per mode (the Rules tab edits the selected mode's set) */
  rulesByMode?: Partial<Record<GameMode, RuleSettings>>;
  players?: 2 | 3 | 4;
  lineup?: Lineup;
  avatars?: boolean;
  /** the player's face (KuAvatars FaceSpec from the editor; older saves hold a HUMAN_FACES index) */
  avatarFace?: number | import('kuavatars/faces').FaceSpec;
  tableStyle?: TableStyle;
  cardBack?: CardBack;
  settingsTab?: 'game' | 'rules' | 'av';
}
