/**
 * Game modes as data (step 1 of player-made modes).
 *
 * A mode is a plain JSON object (`ModeDef`, schema `v`): who plays (teams, seating), whether the deck is
 * two-sided (Día y Noche), which cards the deck holds (an ordered list of kinds and counts, so new
 * power-ups need no format change), and its rule settings. Stored modes go through `sanitizeModeDef`,
 * which keeps what it knows, fills every missing field from the defaults and drops nonsense, so a mode
 * saved today still loads after new rules or cards are added (they just take their defaults).
 *
 * The five built-in modes are ModeDefs too (read-only); their decks reproduce the historical decks card
 * for card, in the same order (seeded shuffles stay the same).
 */
import type { CardKind, GameMode, RuleSettings } from '../contracts';
import { applyForced as applyForcedBase, MODE_SCHEMA, sanitizeModeBase, type ModeBase } from '../modes/core';

export { MODE_SCHEMA };

/** one entry of a deck list: `n` cards of a kind (per colour in `perColor`, in total in `wild`) */
export interface DeckEntry {
  kind: CardKind;
  n: number;
}

/**
 * the cards of one side of a deck, per colour and colourless, in deal-table order. A one-sided deck is
 * one DeckSpec (`ModeDef.deck`); a two-sided deck is two: `deck` (day, the day colours) and `night`
 * (the night colours). On the night side a `draw6` is the night +5 and a `wild4` the Comodín +6, and
 * colourless faces are night faces. `flip` / `wildFlip` (Eclipse) only exist in two-sided decks: a
 * one-sided build leaves them out.
 */
export interface DeckSpec {
  /** number cards per colour: how many 0s, and how many of each value from `minValue` to 9 */
  numbers: { zero: number; each: number; minValue: number };
  /** coloured action / power cards, per colour, in order */
  perColor: DeckEntry[];
  /** colourless cards, in total, in order (a kind may appear twice: the order is kept) */
  wild: DeckEntry[];
}

/** a KuCards mode: the shared mode fields (modes/core) plus the deck */
export interface ModeDef extends ModeBase {
  /** the built-in mode it started from (music, how-to and other per-mode touches follow it) */
  base: GameMode;
  /** a two-sided deck (Día y Noche): `deck` is the day side and `night` the night side */
  twoSided: boolean;
  deck: DeckSpec;
  /** the night side of a two-sided deck (absent when one-sided; sanitizing fills the default when two-sided) */
  night?: DeckSpec;
}

const e = (kind: CardKind, n: number): DeckEntry => ({ kind, n });

/** Clásico (108): per colour one 0, two of 1–9, two Salto / Vuelta / +2; 4 Comodín, 4 +4 */
const CLASSIC_DECK: DeckSpec = {
  numbers: { zero: 1, each: 2, minValue: 1 },
  perColor: [e('skip', 2), e('reverse', 2), e('draw2', 2)],
  wild: [e('wild', 4), e('wild4', 4)],
};

/**
 * Día y Noche's day side (112): per colour one 0, two of 1–9, two Salto / Vuelta / +2, one Eclipse;
 * 4 Comodín, 4 +4. Two-sided decks deal their lists round-robin (cards.ts: sideFaces), so these
 * lists rebuild the historical deck card for card.
 */
export const DAY_SIDE_DECK: DeckSpec = {
  numbers: { zero: 1, each: 2, minValue: 1 },
  perColor: [e('skip', 2), e('reverse', 2), e('draw2', 2), e('flip', 1)],
  wild: [e('wild', 4), e('wild4', 4)],
};

/** Día y Noche's night side (112): per colour one 0, two of 1–9, two +5, two Vuelta, two Salto, one Eclipse; 4 Comodín, 4 Comodín +6 */
export const NIGHT_SIDE_DECK: DeckSpec = {
  numbers: { zero: 1, each: 2, minValue: 1 },
  perColor: [e('draw6', 2), e('reverse', 2), e('skip', 2), e('flip', 1)],
  wild: [e('wild', 4), e('wild4', 4)],
};

/**
 * the deck a rule set describes (the historical `deck` names plus the `power.*` toggles), as a spec:
 * buildDeck builds every one-sided deck from this
 */
export function deckSpecForRules(rules: RuleSettings): DeckSpec {
  const action = rules.deck === 'action';
  const cyclone = rules.deck === 'cyclone';
  const side = rules.deck === 'sideBySide';
  const perColor: DeckEntry[] = [e('skip', action ? 4 : 2), e('reverse', action ? 4 : 2), e('draw2', action ? 4 : 2)];
  if (cyclone || side) perColor.push(e('draw6', 1));
  if (rules['power.shield']) perColor.push(e('shield', 1));
  if (rules['power.sweep']) perColor.push(e('sweep', cyclone || side ? 2 : 1));
  if (rules['power.mirror']) perColor.push(e('mirror', 1));
  const wild: DeckEntry[] = [e('wild', 4), e('wild4', 4)];
  if (cyclone) wild.push(e('draw10', 6), e('wild4', 2));
  if (rules['power.swap']) wild.push(e('swap', 2));
  return { numbers: { zero: 1, each: 2, minValue: action ? 5 : 1 }, perColor, wild };
}

const def = (id: GameMode, icon: string, rest: Partial<ModeDef>): ModeDef => ({
  v: MODE_SCHEMA,
  id,
  base: id,
  name: '',
  icon,
  builtIn: true,
  teams: 'optional',
  seating: 'across',
  twoSided: false,
  deck: CLASSIC_DECK,
  rules: {},
  ...rest,
});

/**
 * the built-in modes as data. Their decks follow the rules (deckSpecForRules), so the in-mode power
 * toggles keep working; `forced` is what modeRules always applied.
 */
export const BUILTIN_MODES: Record<GameMode, ModeDef> = {
  classic: def('classic', 'cards', {}),
  action: def('action', 'bolt', { forced: { stacking: 'any', 'power.sweep': true, 'power.swap': true } }),
  cyclone: def('cyclone', 'tornado', { forced: { stacking: 'any' } }),
  sideBySide: def('sideBySide', 'pair', { teams: 'always', seating: 'side', forced: { stacking: 'any', 'power.sweep': true } }),
  dayNight: def('dayNight', 'sunmoon', { twoSided: true, deck: DAY_SIDE_DECK, night: NIGHT_SIDE_DECK, forced: { stacking: 'any' } }),
};

export const isBuiltInMode = (id: string): id is GameMode => Object.prototype.hasOwnProperty.call(BUILTIN_MODES, id);

/** the definition of a mode id (built-ins only for now; player-made modes come with their JSON) */
export function modeDef(id: string): ModeDef {
  return isBuiltInMode(id) ? BUILTIN_MODES[id] : BUILTIN_MODES.classic;
}

// ───────────────────────── sanitizing stored JSON ─────────────────────────

const CARD_KINDS: readonly CardKind[] = ['number', 'skip', 'skipAll', 'reverse', 'draw2', 'draw6', 'shield', 'sweep', 'mirror', 'flip', 'wild', 'wildColor', 'wild4', 'draw10', 'swap', 'wildFlip', 'sweepWild', 'wheelWild'];
const COLOURLESS = new Set<CardKind>(['wild', 'wildColor', 'wild4', 'draw10', 'swap', 'wildFlip', 'sweepWild', 'wheelWild']);

/** coloured power / action kinds a deck list may hold per colour (`flip` only counts in two-sided decks) */
export const PER_COLOR_KINDS: readonly CardKind[] = CARD_KINDS.filter((k) => k !== 'number' && !COLOURLESS.has(k));
/** colourless kinds a deck list may hold (`wildFlip` only counts in two-sided decks) */
export const COLOURLESS_KINDS: readonly CardKind[] = CARD_KINDS.filter((k) => COLOURLESS.has(k));
/** kinds that turn the deck over: only dealt in two-sided decks */
export const TWO_SIDED_KINDS: readonly CardKind[] = ['flip', 'wildFlip'];
/** at most this many of one entry (per colour / in total): keeps a broken file from building a huge deck */
const MAX_ENTRY = 12;

const int = (v: unknown, lo: number, hi: number, dflt: number): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : dflt;
  return Math.max(lo, Math.min(hi, n));
};

function cleanEntries(raw: unknown, colourless: boolean, dflt: DeckEntry[]): DeckEntry[] {
  if (!Array.isArray(raw)) return dflt.map((x) => ({ ...x }));
  const out: DeckEntry[] = [];
  for (const it of raw) {
    const k = (it as { kind?: unknown })?.kind;
    if (typeof k !== 'string' || !CARD_KINDS.includes(k as CardKind) || k === 'number') continue;
    if (COLOURLESS.has(k as CardKind) !== colourless) continue;
    const n = int((it as { n?: unknown }).n, 0, MAX_ENTRY, 0);
    if (n > 0) out.push({ kind: k as CardKind, n });
  }
  return out;
}

/** a stored deck list → a valid DeckSpec; missing parts come from `dflt` (the classic deck by default) */
export function sanitizeDeckSpec(raw: unknown, dflt: DeckSpec = CLASSIC_DECK): DeckSpec {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<DeckSpec>;
  const nums = (r.numbers && typeof r.numbers === 'object' ? r.numbers : {}) as Partial<DeckSpec['numbers']>;
  const dn = dflt.numbers;
  return {
    numbers: { zero: int(nums.zero, 0, 4, dn.zero), each: int(nums.each, 0, 4, dn.each), minValue: int(nums.minValue, 1, 9, dn.minValue) },
    perColor: cleanEntries(r.perColor, false, dflt.perColor),
    wild: cleanEntries(r.wild, true, dflt.wild),
  };
}

/**
 * stored rules from before a rule was split: `sevenZero` (7 swaps, 0 rotates) became `sevenSwap` +
 * `zeroPass`. Returns a copy with the new keys filled in (they win when both are present) and the old
 * key dropped; anything else comes back as it was.
 */
export function upgradeLegacyRules<T extends Record<string, unknown>>(raw: T): T {
  if (!('sevenZero' in raw)) return raw;
  const { sevenZero, ...rest } = raw as Record<string, unknown>;
  if (sevenZero !== true) return rest as T;
  return { ...rest, sevenSwap: rest.sevenSwap ?? true, zeroPass: rest.zeroPass ?? true } as unknown as T;
}

/** a stored / received KuCards mode → a valid ModeDef (missing fields take their defaults; never throws) */
export function sanitizeModeDef(raw: unknown): ModeDef {
  const clean = sanitizeModeBase(raw, isBuiltInMode);
  const base = { ...clean, rules: upgradeLegacyRules(clean.rules), ...(clean.forced ? { forced: upgradeLegacyRules(clean.forced) } : {}) };
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<ModeDef>;
  const b = typeof r.base === 'string' && isBuiltInMode(r.base) ? r.base : isBuiltInMode(base.id) ? base.id : 'classic';
  const twoSided = r.twoSided === true;
  if (!twoSided) return { ...base, base: b, icon: base.icon || 'cards', twoSided, deck: sanitizeDeckSpec(r.deck) };
  // two-sided: a mode saved before the night list existed played the fixed Día y Noche deck (its `deck`
  // was ignored), so without a night list both sides take the Día y Noche defaults
  const legacy = !r.night || typeof r.night !== 'object';
  return {
    ...base,
    base: b,
    icon: base.icon || 'cards',
    twoSided,
    deck: legacy ? cloneSpec(DAY_SIDE_DECK) : sanitizeDeckSpec(r.deck, DAY_SIDE_DECK),
    night: legacy ? cloneSpec(NIGHT_SIDE_DECK) : sanitizeDeckSpec(r.night, NIGHT_SIDE_DECK),
  };
}

const cloneSpec = (d: DeckSpec): DeckSpec => ({ numbers: { ...d.numbers }, perColor: d.perColor.map((x) => ({ ...x })), wild: d.wild.map((x) => ({ ...x })) });

/** the rules a mode plays with: the player's settings, then what the mode always enforces */
export function applyForced(def: ModeDef, rules: RuleSettings): RuleSettings {
  return applyForcedBase(def, rules);
}

/**
 * a new player-made mode from a template (a built-in or another custom mode): same deck, seating and
 * rules (the template's forced rules folded in), a new id and the given name
 */
export function modeFromTemplate(t: ModeDef, rules: RuleSettings, id: string, name: string): ModeDef {
  const forcedRules = applyForced(t, rules);
  return {
    ...t,
    id,
    name,
    builtIn: undefined,
    forced: undefined,
    base: t.base,
    deck: t.builtIn ? (t.twoSided ? cloneSpec(DAY_SIDE_DECK) : deckSpecForRules(forcedRules)) : t.deck,
    night: t.twoSided ? cloneSpec(t.night ?? NIGHT_SIDE_DECK) : undefined,
    rules: forcedRules,
  };
}
