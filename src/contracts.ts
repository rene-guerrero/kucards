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

/** day colours (every mode) */
export type DayColor = 'sol' | 'mar' | 'palma' | 'coral';
/** Día y Noche: the four night colours (the dark side of every card) */
export type NightColor = 'naranja' | 'celeste' | 'rosa' | 'morado';
export type Color = DayColor | NightColor;
/** the day colours: the only colours of every mode but Día y Noche */
export const COLORS: readonly DayColor[] = ['sol', 'mar', 'palma', 'coral'];
/** Día y Noche: the night colours, slot for slot (index i of COLORS ↔ index i of NIGHT_COLORS) */
export const NIGHT_COLORS: readonly NightColor[] = ['naranja', 'celeste', 'rosa', 'morado'];
export type Side = 'light' | 'dark';
/** the colours in play on a side */
export const sideColors = (side: Side | undefined): readonly Color[] => (side === 'dark' ? NIGHT_COLORS : COLORS);
/** a colour's slot 0–3 within its side's palette (sol / naranja 0 … coral / morado 3) */
export const colorSlot = (c: Color): number => {
  const i = (COLORS as readonly Color[]).indexOf(c);
  return i >= 0 ? i : (NIGHT_COLORS as readonly Color[]).indexOf(c);
};
export const isNightColor = (c: Color | null | undefined): c is NightColor => !!c && (NIGHT_COLORS as readonly Color[]).includes(c);

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
  | 'flip' // Eclipse (Día y Noche only): every card in play turns over
  // Ciclón (harsh) extra cards, only in decks built with rules.deck === 'cyclone' (phase 4)
  | 'skipAll' // coloured: everyone else loses a turn, you play again
  | 'draw6' // coloured: next player draws 6 (stackable)
  | 'draw10' // wild: choose a colour, next player draws 10 (stackable)
  | 'wildColor' // wild "draw until the colour": next player draws until they get the colour you chose
  // player-made decks only (the editor offers them; no built-in deck holds them)
  | 'wildFlip' // Eclipse comodín (two-sided decks): turns every card over, the player picks the new side's colour
  | 'sweepWild'; // Barrida comodín: the player picks a colour and discards every card of it from their hand

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
  /** Día y Noche: a night face (only needed on colourless ones; night colours say it themselves) */
  night?: boolean;
}

/** id = stable index into the deck the match was created with */
export interface Card {
  id: number;
  /** the face in play (Día y Noche: the face of the side in play, `round.side`) */
  face: CardFace;
  /**
   * Día y Noche only: the face of the OTHER side. It is what everybody else sees of the card (the "back"
   * of a card in someone's hand or on the deck). A flip swaps `face` and `other` on every card.
   */
  other?: CardFace;
}

// ───────────────────────── Seats & modes ─────────────────────────

/** 0 = human (bottom of the screen). v1 ships 2–4 players; 4 and 5 are reserved for 5–6 players. */
export type Seat = 0 | 1 | 2 | 3 | 4 | 5;
export type Direction = 1 | -1;

/** 'sideBySide' = Codo a codo: always 2 vs 2, partners side by side (A A B B), stacking always on */
/** 'dayNight' = Día y Noche: double-sided cards, an Eclipse card turns the whole game over */
export type GameMode = 'classic' | 'action' | 'cyclone' | 'sideBySide' | 'dayNight';

/** team seating: 'across' = A B A B (2 vs 2 "Enfrente", any mode), 'side' = A A B B (Codo a codo mode). */
export type Seating = 'across' | 'side';

export interface MatchSetup {
  mode: GameMode;
  players: 2 | 3 | 4;
  /** 2 vs 2 with partners across (4 players; Codo a codo is always 2 vs 2 side by side) */
  teams?: boolean;
  /**
   * Side seating only: "Cambiar de lado" swaps the human's seat with their partner's. Teams stay
   * [[0,1],[2,3]] (the partner is always the next seat); only the two avatars/identities change places,
   * so the rivals keep their seats. Picked in the lobby and kept for the rematch.
   */
  swappedSeats?: boolean;
  /** a player-made mode's deck list (engine/modes: DeckSpec); built-in modes build theirs from the rules */
  deck?: import('./engine/modes').DeckSpec;
  /** a two-sided deck's night side (with `deck` as its day side) */
  night?: import('./engine/modes').DeckSpec;
  /** a player-made mode: its whole definition (seating, teams, deck, rules); `mode` is then its base */
  custom?: import('./engine/modes').ModeDef;
}

// ───────────────────────── Moves ─────────────────────────

export type Move =
  /**
   * color: required for wild-type cards; target: required for swap (and 7 with the 7-0 rule).
   * give: partnerPass (Parejas, not with 7-0): with a 7, the id of one more card handed to the partner.
   */
  /**
   * extra: multiPlay rule, more number cards of the same value played with `cardId` in this order (card
   * ids); multiDraw2 / multiReverse / multiSkip: more +2 / reverse / skip cards (one kind, never mixed).
   * The last one lands on top and sets the colour (engine multiPlayOptions lists the candidates).
   */
  | { kind: 'play'; seat: Seat; cardId: number; color?: Color; target?: Seat; ku?: boolean; give?: number; extra?: number[] }
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
  /** Día y Noche: the side in play ('light' = Día, 'dark' = Noche); always 'light' in other modes */
  side: Side;
  eliminated: boolean[];
  over: boolean;
  /** the round ended because its time limit ran out (engine `timeUp`) */
  endedBy?: 'time';
}

export interface MatchState {
  rules: RuleSettings;
  /** the setup that created the match, kept so a rematch keeps the same mode, seating, seat swap and deck */
  setup?: MatchSetup;
  mode: GameMode;
  /** a player-made mode's deck list (MatchSetup.deck; the day side of a two-sided deck); absent = built from the rules */
  deckSpec?: import('./engine/modes').DeckSpec;
  /** a player-made two-sided deck: the night side's list (MatchSetup.night); absent = the Día y Noche default */
  nightSpec?: import('./engine/modes').DeckSpec;
  /** a player-made mode being played (id, name, icon for the screens) */
  custom?: { id: string; name: string; icon: string };
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
  /** match clocks (round limit, move times); absent = no round limit, default move time */
  clock?: import('./engine/clock').ClockSettings;
  /** round time left (ms) when the match was saved, so a restored game continues the clock */
  clockLeftMs?: number;
}

/** What the renderer/UI animate. The engine returns them in order from every transition. */
export type GameEvent =
  /** hand: the viewer's own cards (seat 0 offline; the server fills each player's); deck: cards left in the deck */
  /** backs (Día y Noche): by seat, the backs of every hand (public); deckBack: the deck top's back */
  | { type: 'deal'; counts: number[]; starter: Seat; firstCard: Card; activeColor: Color; hand?: Card[]; deck?: number; backs?: CardFace[][]; deckBack?: CardFace | null }
  /**
   * more: a multi-play (rules multiPlay, multiDraw2, multiReverse, multiSkip) puts several cards down in one move, one 'play' event per card in
   * order; every one but the last carries `more: true` (the renderer starts the next card's flight before
   * this one lands). The colour in play follows the last one.
   */
  | { type: 'play'; seat: Seat; card: Card; color?: Color; more?: boolean }
  /** cards: the faces, only present for whoever may see them (the engine fills them; redaction strips them) */
  | { type: 'draw'; seat: Seat; count: number; cards?: Card[]; reason: 'turn' | 'penalty' | 'ku' | 'catch'; backs?: CardFace[]; deckBack?: CardFace | null }
  | { type: 'skip'; seat: Seat }
  | { type: 'reverse'; direction: Direction }
  | { type: 'stack'; total: number }
  | { type: 'shield'; seat: Seat; card?: Card }
  | { type: 'mirror'; from: Seat; to: Seat; total: number; card?: Card }
  /** cards: the viewer's new hand when it changed (seat 0 offline; the server fills it per player) */
  | { type: 'swapHands'; a: Seat; b: Seat; cards?: Card[] }
  | { type: 'rotateHands'; direction: Direction; cards?: Card[] }
  | { type: 'sweep'; seat: Seat; cardIds: number[] }
  | { type: 'ku'; seat: Seat }
  | { type: 'kuCaught'; by: Seat; target: Seat }
  /** a +4 / +10 challenge: `by` challenged `target` (who played it); caught = it was a bluff */
  /** hand: the target's whole hand, shown to everyone (public by the rule); proof: the cards in it that could have been played instead of the wild (empty = a fair play); draw: the cards the loser now draws */
  | { type: 'challenge'; by: Seat; target: Seat; caught: boolean; hand?: Card[]; proof?: Card[]; draw?: number }
  | { type: 'window'; window: ResponseWindow | null }
  /**
   * Día y Noche: every card turned over (the engine has already swapped face / other on every card).
   * color: the active colour now (the new top face's, or the same slot of the other side for a wild);
   * hand: the viewer's own hand after the flip (seat 0 offline); backs: by seat, the faces everyone now
   * sees on the backs of that seat's cards (public), in hand order; deckBack: the deck top's back.
   */
  | { type: 'flip'; side: Side; color: Color; seat: Seat; hand?: Card[]; backs?: CardFace[][]; deckBack?: CardFace | null }
  | { type: 'eliminated'; seat: Seat }
  | { type: 'reshuffle'; count: number }
  /** deckBack (Día y Noche): the back of the deck's top card (public: it is the other side's face) */
  | { type: 'turn'; seat: Seat; deckBack?: CardFace | null }
  | { type: 'roundEnd'; winner: Seat; points: number[]; byTime?: boolean }
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
  /** set on a saved rule profile (its id); built-in presets have none */
  profile?: string;
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
  /** the round's time limit ran out: it ends now, the fewest card points in hand wins */
  timeUp(match: MatchState): { match: MatchState; events: GameEvent[] };
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
  | 'thump' // low thump for a big penalty (+4 and up)
  // power-card stingers (they sit under the voice callouts)
  | 'skip' // descending zap and a soft thud
  | 'reverse' // a whoosh that swirls up and back
  | 'hit2' // short brassy hit (+2)
  | 'hit4' // bigger hit (a penalty of 4 or 5)
  | 'hit6' // heavy impact with a riser (6 and up)
  | 'wild' // sparkle chord tinted by the chosen colour
  | 'sweep' // cascading shuffle-whoosh
  | 'flip' // Eclipse: a deep swell
  | 'swap' // two crossing whooshes
  // the +4 challenge's verdict
  | 'chalWin' // short bright rise
  | 'chalLose'; // short sour fall

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
  /** a skip mark lands on a seat: the plates draw it over the avatar (img: data URL, tint: CSS colour) */
  onSeatMark?: (seat: Seat, img: string, tint: string) => void;
  /** the +4 challenge sequence, step by step: the HTML layer draws the beam, the shown hand and the verdict stamp */
  onChallenge?: (step: ChallengeStep) => void;
  onFrameStats?: (stats: FrameStats) => void;
  onError?: (err: unknown) => void;
}

/**
 * The +4 challenge on screen (the renderer keeps the time, the plates layer draws): `call` = the beam from
 * the challenger to the wild's player and the lettering; `reveal` = that player's hand face up (proof = the
 * ids of the cards that could have been played instead), absent when the faces are unknown; `verdict` =
 * the stamp on the loser. ms = how long the step stays up.
 */
export type ChallengeStep =
  | { step: 'call'; by: Seat; target: Seat; ms: number }
  | { step: 'reveal'; target: Seat; hand: Card[]; proof: number[]; ms: number }
  | { step: 'verdict'; loser: Seat; winner: Seat; caught: boolean; draw: number; ms: number };

/** Everything needed to put a saved round on the table in one frame. */
export interface RestoreState {
  round: RoundState;
  seats: Seat[];
}

/** multiPlay: the human's group pick (the card that opens the play, then the others in the order picked) */
export interface MultiPick {
  cardId: number;
  extra: number[];
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
  /**
   * multiPlay: requestHumanPick where a tap selects a playable card that others may join (`joinable`: by
   * card id, the ids that may go down with it, engine multiPlayOptions). Tapping those adds them in order;
   * dragging any selected card to the pile resolves with the whole group. A plain drag resolves a number.
   */
  requestHumanMultiPick?(playable: number[], canDraw: boolean, joinable: Record<number, number[]>): Promise<number | 'draw' | MultiPick>;
  /** drop a pending requestHumanPick (its promise never resolves) */
  cancelHumanPick(): void;
  /** lift one of the human's cards as if tapped (null = drop it): the drawn-card question points at it */
  markCard?(cardId: number | null): void;
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
  /** English voice callouts for power cards (Voces) */
  voice: boolean;
  music: boolean;
  vibration: boolean;
  animationSpeed: 'normal' | 'fast';
  playerName: string;
  rules: RuleSettings;
  mode?: GameMode;
  /** a player-made mode picked for new games (its id); `mode` is then its base */
  customMode?: string;
  reducedMotion?: boolean;
  rulesVersion?: number;
  /** rules per mode (the Rules tab edits the selected mode's set) */
  rulesByMode?: Partial<Record<GameMode, RuleSettings>>;
  players?: 2 | 3 | 4;
  /** new-game screen: 2 vs 2 (partners across) with 4 players in Clásico / Pura acción / Ciclón */
  teamPlay?: boolean;
  lineup?: Lineup;
  avatars?: boolean;
  /** the player's face (KuAvatars FaceSpec from the editor; older saves hold a HUMAN_FACES index) */
  avatarFace?: number | import('kuavatars/faces').FaceSpec;
  /** up to 5 gestures in the in-game chat button (KuAvatars gesture names) */
  gestures?: string[];
  tableStyle?: TableStyle;
  cardBack?: CardBack;
  settingsTab?: 'game' | 'rules' | 'av';
  /** last clocks picked on the new-game screen (not rules) */
  clock?: import('./engine/clock').ClockSettings;
}
