/**
 * Game modes, the game-independent core (shared later with KuDominoes, e.g. as a `kumodes` package).
 *
 * Nothing here knows about cards or tiles. A mode is plain versioned JSON: id, name, icon, who plays
 * (teams, seating), its rule settings and the rules it enforces. Each game extends `ModeBase` with its
 * own fields (KuCards: the deck list and the two-sided deck) and passes its own sanitizer for them.
 *
 * Forward compatible by design: `sanitizeModeBase` keeps what it knows, fills every missing field with a
 * default and keeps unknown rule keys, so a mode saved today still loads after new rules are added.
 */

/** a rule value (the same shape as the games' RuleSettings values) */
export type ModeValue = string | number | boolean;
export type ModeRules = Record<string, ModeValue>;

export interface ModeBase {
  /** schema version of the stored JSON */
  v: number;
  /** built-in: its fixed id; player-made: 'custom-…' */
  id: string;
  /** a player-made mode's own name (built-ins are named by the game's i18n) */
  name: string;
  /** an icon id (each game ships its icon set) */
  icon: string;
  builtIn?: boolean;
  /** 2 vs 2: never, the player's choice (with 4 players), or always (forces 4 players) */
  teams: 'off' | 'optional' | 'always';
  /** with teams: partners across the table, or side by side */
  seating: 'across' | 'side';
  /** rule settings; unknown keys are kept for newer versions */
  rules: ModeRules;
  /** rules the mode always enforces over the player's settings */
  forced?: ModeRules;
}

export const MODE_SCHEMA = 1;
export const MODE_NAME_MAX = 24;
export const CUSTOM_PREFIX = 'custom-';

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export function cleanModeRules(raw: unknown): ModeRules {
  const out: ModeRules = {};
  if (!isObj(raw)) return out;
  for (const [k, v] of Object.entries(raw)) if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
  return out;
}

/** the shared fields of a stored / received mode → valid (never throws) */
export function sanitizeModeBase(raw: unknown, isBuiltIn: (id: string) => boolean): ModeBase {
  const r = isObj(raw) ? raw : {};
  const id = typeof r.id === 'string' && r.id.trim() ? r.id.trim().slice(0, 40) : `${CUSTOM_PREFIX}x`;
  const teams = r.teams === 'off' || r.teams === 'always' ? r.teams : 'optional';
  return {
    v: MODE_SCHEMA,
    id,
    name: typeof r.name === 'string' ? r.name.trim().slice(0, MODE_NAME_MAX) : '',
    icon: typeof r.icon === 'string' && r.icon ? r.icon.slice(0, 24) : '',
    ...(isBuiltIn(id) && r.builtIn === true ? { builtIn: true } : {}),
    teams,
    seating: r.seating === 'side' && teams !== 'off' ? 'side' : 'across',
    rules: cleanModeRules(r.rules),
    ...(isObj(r.forced) ? { forced: cleanModeRules(r.forced) } : {}),
  };
}

/**
 * Are partners sitting side by side? A mode may allow side seating yet have no teams in play (2–3
 * players, or the host chose Individual), so the seating and the 2 vs 2 teams must both be checked.
 * The engine, both lobby previews and the online protocol share this so they always agree on who the
 * human's partner is.
 */
export function sideSeating(def: ModeBase, players: number, teamsOn: boolean): boolean {
  return def.seating === 'side' && def.teams !== 'off' && players === 4 && teamsOn;
}

/** the rules a mode plays with: the player's settings, then what the mode always enforces */
export function applyForced<R extends ModeRules>(mode: Pick<ModeBase, 'forced'>, rules: R): R {
  return mode.forced ? ({ ...rules, ...mode.forced } as R) : ({ ...rules } as R);
}

/** names compare without case, accents or extra spaces ("Ciclón" = "ciclon ") */
export const nameKey = (s: string): string =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().replace(/\s+/g, ' ').toLocaleLowerCase();

/** is `name` free? (`taken`: every existing mode's names, built-ins in every language) */
export function nameFree(name: string, taken: readonly string[]): boolean {
  const k = nameKey(name);
  return !!k && !taken.some((t) => nameKey(t) === k);
}

/** a free name from a wanted one: "Ciclón Loco" → "Ciclón Loco (2)" → "(3)"… (copies from a lobby) */
export function freeName(wanted: string, taken: readonly string[]): string {
  const base = wanted.trim().slice(0, MODE_NAME_MAX - 4) || 'Modo';
  if (nameFree(base, taken)) return base;
  for (let i = 2; i < 100; i++) if (nameFree(`${base} (${i})`, taken)) return `${base} (${i})`;
  return `${base} (${Date.now() % 1000})`;
}

/** a new player-made mode id */
export const newModeId = (): string => `${CUSTOM_PREFIX}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
export const isCustomId = (id: string): boolean => id.startsWith(CUSTOM_PREFIX);
