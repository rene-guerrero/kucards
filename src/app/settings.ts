/**
 * App settings: load / save / migrate in localStorage. Rules are kept per mode (`rulesByMode`), each set
 * starting from that mode's preset (RULE_PRESETS) and edited in Ajustes → Reglas. Ported from Kudominoes.
 */
import type { AppSettings, GameMode, Lineup, RulePreset, RuleSettings, SettingDescriptor } from '../contracts';
import { CARD_BACKS, TABLE_STYLES } from '../contracts';
import { DEFAULT_RULES, RULE_PRESETS, RULE_SETTINGS, RULES_VERSION } from '../engine/rules';
import { DEFAULT_LINEUP, isCharacter } from '../roster';
import { sanitizeFace } from 'kuavatars/faces';
import { resolveQuality } from './perf';

export const SETTINGS_KEY = 'kucards.settings.v1';
export const MODES: GameMode[] = ['classic', 'action', 'cyclone', 'partners'];

export interface RulesSource {
  RULE_SETTINGS: SettingDescriptor[];
  DEFAULT_RULES: RuleSettings;
  RULE_PRESETS: RulePreset[];
}
const ENGINE: RulesSource = { RULE_SETTINGS, DEFAULT_RULES, RULE_PRESETS };

export const isMode = (v: unknown): v is GameMode => MODES.includes(v as GameMode);

/** the preset rules of a mode (falls back to the defaults) */
export function presetRules(mode: GameMode, src: RulesSource = ENGINE): RuleSettings {
  return { ...(src.RULE_PRESETS.find((p) => p.id === mode)?.rules ?? src.DEFAULT_RULES) };
}

/** descriptors shown for a mode (descriptors without `modes` apply to every mode) */
export function descriptorsFor(mode: GameMode, src: RulesSource = ENGINE): SettingDescriptor[] {
  return src.RULE_SETTINGS.filter((d) => !d.modes || d.modes.includes(mode));
}

/**
 * Keep only rules the engine knows, with values of the right type / one of the options, on top of the
 * mode's preset. Preset-only keys (e.g. `deck`) always come from the preset.
 */
export function sanitizeRules(stored: unknown, mode: GameMode, src: RulesSource = ENGINE): RuleSettings {
  const out = presetRules(mode, src);
  const s = (stored && typeof stored === 'object' ? stored : {}) as Record<string, unknown>;
  for (const d of src.RULE_SETTINGS) {
    if (!(d.key in out)) out[d.key] = d.default;
    const v = s[d.key];
    if (v === undefined) continue;
    if (d.type === 'select' && d.options) {
      if (!d.options.some((o) => o.value === v)) continue;
    } else if (typeof v !== typeof d.default) continue;
    out[d.key] = v as RuleSettings[string];
  }
  return out;
}

export function defaultRulesByMode(src: RulesSource = ENGINE): Record<GameMode, RuleSettings> {
  return Object.fromEntries(MODES.map((m) => [m, presetRules(m, src)])) as Record<GameMode, RuleSettings>;
}

export function defaultSettings(src: RulesSource = ENGINE): AppSettings {
  const rulesByMode = defaultRulesByMode(src);
  return {
    language: 'es',
    quality: 'medium',
    qualityMode: 'auto',
    sound: true,
    music: false,
    vibration: true,
    animationSpeed: 'normal',
    playerName: '',
    mode: 'classic',
    rules: { ...rulesByMode.classic },
    rulesByMode,
    rulesVersion: RULES_VERSION,
    reducedMotion: false,
    players: 4,
    lineup: { ...DEFAULT_LINEUP },
    avatars: true,
    avatarFace: 0,
    tableStyle: 'teal',
    cardBack: 'ku',
    settingsTab: 'game',
  };
}

/** a lineup slot may hold a character id or 'random' (drawn when the match starts) */
export const RANDOM = 'random';

/** known characters (or 'random') in seats 1–3, no character twice; else the default lineup */
export function sanitizeLineupSetting(v: unknown): Lineup {
  if (!v || typeof v !== 'object') return { ...DEFAULT_LINEUP };
  const o = v as Record<string, unknown>;
  const ids = [o[1], o[2], o[3]];
  if (!ids.every((x) => x === RANDOM || isCharacter(x))) return { ...DEFAULT_LINEUP };
  const real = ids.filter((x) => x !== RANDOM);
  if (new Set(real).size !== real.length) return { ...DEFAULT_LINEUP };
  return { 1: ids[0] as string, 2: ids[1] as string, 3: ids[2] as string };
}

const isQuality = (v: unknown): v is AppSettings['quality'] => v === 'low' || v === 'medium' || v === 'high';
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';

/** Turn any stored object into valid settings (pure; no storage, no quality detection). */
export function migrateSettings(raw: unknown, src: RulesSource = ENGINE): AppSettings {
  const def = defaultSettings(src);
  if (!raw || typeof raw !== 'object') return def;
  const s = raw as Partial<AppSettings>;
  const pick = <K extends keyof AppSettings>(k: K, ok: (v: unknown) => boolean): AppSettings[K] => (ok(s[k]) ? (s[k] as AppSettings[K]) : def[k]);
  const mode: GameMode = isMode(s.mode) ? s.mode : 'classic';
  // an older rules version keeps only what still validates (sanitizeRules), on top of the new presets
  const storedByMode = (s.rulesByMode && typeof s.rulesByMode === 'object' ? s.rulesByMode : {}) as Partial<Record<GameMode, unknown>>;
  const rulesByMode = Object.fromEntries(
    MODES.map((m) => [m, sanitizeRules(storedByMode[m] ?? (m === mode && !s.rulesByMode ? s.rules : undefined), m, src)]),
  ) as Record<GameMode, RuleSettings>;
  return {
    language: pick('language', (v) => v === 'es' || v === 'en'),
    quality: pick('quality', isQuality),
    qualityMode: s.qualityMode === 'manual' && isQuality(s.quality) ? 'manual' : 'auto',
    autoQuality: isQuality(s.autoQuality) ? s.autoQuality : undefined,
    sound: pick('sound', isBool),
    music: pick('music', isBool),
    vibration: pick('vibration', isBool),
    animationSpeed: pick('animationSpeed', (v) => v === 'normal' || v === 'fast'),
    playerName: typeof s.playerName === 'string' ? s.playerName.trim().slice(0, 14) : '',
    mode,
    rules: { ...rulesByMode[mode] },
    rulesByMode,
    rulesVersion: RULES_VERSION,
    reducedMotion: isBool(s.reducedMotion) ? s.reducedMotion : false,
    players: s.players === 2 || s.players === 3 || s.players === 4 ? s.players : 4,
    lineup: sanitizeLineupSetting(s.lineup),
    avatars: isBool(s.avatars) ? s.avatars : true,
    avatarFace: sanitizeFace(s.avatarFace ?? 0),
    tableStyle: TABLE_STYLES.includes(s.tableStyle as never) ? s.tableStyle : def.tableStyle,
    cardBack: CARD_BACKS.includes(s.cardBack as never) ? s.cardBack : def.cardBack,
    settingsTab: s.settingsTab === 'game' || s.settingsTab === 'rules' || s.settingsTab === 'av' ? s.settingsTab : 'game',
  };
}

export function loadSettings(src: RulesSource = ENGINE): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return resolveQuality(migrateSettings(raw ? JSON.parse(raw) : null, src));
  } catch {
    return resolveQuality(defaultSettings(src));
  }
}

export function saveSettings(s: AppSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...s, rulesVersion: RULES_VERSION }));
  } catch {
    /* storage full / private mode: non-fatal */
  }
}

/** the stored rules of a mode */
export function rulesFor(s: AppSettings, mode: GameMode): RuleSettings {
  return { ...(s.rulesByMode?.[mode] ?? presetRules(mode)) };
}

/** store a mode's rules (keeps `rules` in sync with the selected mode) */
export function withRules(s: AppSettings, mode: GameMode, rules: RuleSettings): AppSettings {
  const rulesByMode = { ...(s.rulesByMode ?? {}), [mode]: { ...rules } };
  return { ...s, rulesByMode, rules: mode === (s.mode ?? 'classic') ? { ...rules } : s.rules };
}

/** select a mode (its stored rules become `rules`) */
export function withMode(s: AppSettings, mode: GameMode): AppSettings {
  return { ...s, mode, rules: rulesFor(s, mode) };
}
