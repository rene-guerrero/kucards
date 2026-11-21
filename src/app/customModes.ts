/**
 * Player-made game modes: stored as a JSON array of ModeDef in localStorage, read back through
 * sanitizeModeDef (forward compatible: unknown fields / rules survive, missing ones take defaults).
 */
import type { GameMode, RuleSettings } from '../contracts';
import { BUILTIN_MODES, modeFromTemplate, sanitizeModeDef, type ModeDef } from '../engine/modes';
import { freeName, isCustomId, nameFree, newModeId } from '../modes/core';

const KEY = 'kucards.modes.v1';
export const MAX_CUSTOM_MODES = 30;

function read(): ModeDef[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown;
    return Array.isArray(raw) ? raw.map(sanitizeModeDef).filter((d) => isCustomId(d.id)) : [];
  } catch {
    return [];
  }
}

function write(list: ModeDef[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX_CUSTOM_MODES)));
  } catch {
    /* storage full / blocked: the mode lives for this session only */
  }
}

export const loadCustomModes = (): ModeDef[] => read();

export function customMode(id: string): ModeDef | null {
  return read().find((d) => d.id === id) ?? null;
}

/** add or replace (by id) */
export function saveCustomMode(def: ModeDef): ModeDef {
  const clean = sanitizeModeDef(def);
  const list = read().filter((d) => d.id !== clean.id);
  write([...list, clean]);
  return clean;
}

export function deleteCustomMode(id: string): void {
  write(read().filter((d) => d.id !== id));
}

/** every mode name in use (built-ins in both languages, custom modes), optionally without one id */
export function takenNames(builtInNames: readonly string[], exceptId?: string): string[] {
  return [...builtInNames, ...read().filter((d) => d.id !== exceptId).map((d) => d.name)];
}

export const modeNameFree = (name: string, builtInNames: readonly string[], exceptId?: string): boolean =>
  nameFree(name, takenNames(builtInNames, exceptId));

/** a draft for the editor: a copy of a template with a new id and a free name */
export function draftFrom(template: ModeDef, rules: RuleSettings, name: string, builtInNames: readonly string[]): ModeDef {
  return modeFromTemplate(template, rules, newModeId(), freeName(name, takenNames(builtInNames)));
}

/** a mode seen in someone else's room, saved here (a free name if the name is taken; same id = update) */
export function copyMode(def: ModeDef, builtInNames: readonly string[]): ModeDef {
  const mine = read();
  const same = mine.find((d) => d.id === def.id);
  if (same) return saveCustomMode({ ...def, name: same.name });
  return saveCustomMode({ ...def, name: freeName(def.name || 'Modo', takenNames(builtInNames)) });
}

/** a built-in or custom mode by id (custom ids that are gone fall back to Clásico) */
export function anyMode(id: string): ModeDef {
  if (id in BUILTIN_MODES) return BUILTIN_MODES[id as GameMode];
  return customMode(id) ?? BUILTIN_MODES.classic;
}

const MIGRATED = 'kucards.modes.fromProfiles';
/** once: the old saved rule sets ("Mi casa") become player-made modes based on their mode */
export function migrateProfiles(profiles: readonly { name: string; mode: GameMode; rules: RuleSettings }[], builtInNames: readonly string[]): void {
  try {
    if (localStorage.getItem(MIGRATED)) return;
    for (const p of profiles) {
      const t = BUILTIN_MODES[p.mode] ?? BUILTIN_MODES.classic;
      saveCustomMode(modeFromTemplate(t, p.rules, newModeId(), freeName(p.name, takenNames(builtInNames))));
    }
    localStorage.setItem(MIGRATED, '1');
  } catch {
    /* storage blocked: try again next launch */
  }
}

/** the definition of the mode a match plays (custom: its saved definition; built-in: rebuilt from the match's rules) */
export function matchModeDef(m: { mode: GameMode; rules: RuleSettings; custom?: { id: string; name: string } }, builtInLabel: string): ModeDef {
  const own = m.custom ? customMode(m.custom.id) : null;
  if (own) return own;
  return modeFromTemplate(BUILTIN_MODES[m.mode] ?? BUILTIN_MODES.classic, m.rules, m.custom?.id ?? m.mode, m.custom?.name ?? builtInLabel);
}
