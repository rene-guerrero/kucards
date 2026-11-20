/**
 * Rule profiles (same design as KuDominoes): named rule sets saved on this device, per mode, in
 * localStorage under `kucards.ruleProfiles.v1` as `[{ id, name, mode, rules }]` (max 20, names ≤ 24).
 * They show as chips next to the built-in preset in Ajustes → Reglas, name the rules in the new-game
 * and lobby rules lines, and are offered in the online room's rules sheet. Rules are re-sanitized
 * on every load. Saving a name that exists in that mode (case-insensitive) overwrites it.
 * Data saved by the first version under `kucards-rule-profiles` is migrated on first load.
 */
import type { GameMode, RulePreset, RuleSettings } from '../contracts';
import { RULE_PRESETS } from '../engine/rules';
import { legacyMode, MODES, sanitizeRules } from './settings';

export const RULE_PROFILES_KEY = 'kucards.ruleProfiles.v1';
export const LEGACY_PROFILES_KEY = 'kucards-rule-profiles';
export const MAX_PROFILES = 20;
export const MAX_NAME = 24;

export interface RuleProfile {
  id: string;
  name: string;
  mode: GameMode;
  rules: RuleSettings;
}
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const clean = (name: string) => name.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME).trim();
const same = (a: string, b: string) => a.toLocaleLowerCase() === b.toLocaleLowerCase();
const newId = () => `p${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;

function parse(raw: unknown): RuleProfile[] {
  if (!Array.isArray(raw)) return [];
  const out: RuleProfile[] = [];
  for (const p of raw) {
    if (!p || typeof p !== 'object' || typeof p.name !== 'string') continue;
    const name = clean(p.name);
    const old = legacyMode(p.mode, p.rules).mode as GameMode;
    const mode: GameMode = MODES.includes(old) ? old : 'classic';
    if (!name || out.some((x) => x.mode === mode && same(x.name, name))) continue;
    out.push({ id: typeof p.id === 'string' && p.id ? p.id : newId(), name, mode, rules: sanitizeRules(p.rules, mode) });
    if (out.length >= MAX_PROFILES) break;
  }
  return out;
}

function persist(list: RuleProfile[], store: Store): void {
  try {
    store.setItem(RULE_PROFILES_KEY, JSON.stringify(list));
  } catch {
    /* storage full / private mode: non-fatal */
  }
}

export function loadProfiles(store: Store = localStorage): RuleProfile[] {
  try {
    const cur = store.getItem(RULE_PROFILES_KEY);
    if (cur !== null) return parse(JSON.parse(cur));
    const old = store.getItem(LEGACY_PROFILES_KEY);
    if (old === null) return [];
    const list = parse(JSON.parse(old));
    persist(list, store);
    store.removeItem(LEGACY_PROFILES_KEY);
    return list;
  } catch {
    return [];
  }
}

/** saves (or overwrites the same-named profile of that mode); returns the new list (unchanged when full) */
export function saveProfile(name: string, mode: GameMode, rules: RuleSettings, store: Store = localStorage): RuleProfile[] {
  const n = clean(name);
  const list = loadProfiles(store);
  if (!n) return list;
  const hit = list.find((p) => p.mode === mode && same(p.name, n));
  if (hit) {
    hit.name = n;
    hit.rules = sanitizeRules(rules, mode);
  } else {
    if (list.length >= MAX_PROFILES) return list;
    list.push({ id: newId(), name: n, mode, rules: sanitizeRules(rules, mode) });
  }
  persist(list, store);
  return list;
}

export function deleteProfile(id: string, store: Store = localStorage): RuleProfile[] {
  const list = loadProfiles(store).filter((p) => p.id !== id);
  persist(list, store);
  return list;
}

export function profilesAsPresets(list: RuleProfile[]): RulePreset[] {
  return list.map((p) => ({ id: p.mode, profile: p.id, label: { es: p.name, en: p.name }, blurb: { es: '', en: '' }, rules: p.rules }));
}

/** the engine presets, then the player's profiles (for naming the current rules) */
export const allPresets = (store?: Store): RulePreset[] => [...RULE_PRESETS, ...profilesAsPresets(loadProfiles(store))];
