import { describe, expect, it } from 'vitest';
import { RULE_PRESETS } from '../engine/rules';
import { allPresets, deleteProfile, LEGACY_PROFILES_KEY, loadProfiles, MAX_PROFILES, RULE_PROFILES_KEY, saveProfile } from './ruleProfiles';

const mem = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
};
const rules = RULE_PRESETS[0].rules;

describe('ruleProfiles', () => {
  it('maps old Parejas profiles to Codo a codo (side) or Clásico (across)', () => {
    const s = mem();
    s.setItem(RULE_PROFILES_KEY, JSON.stringify([
      { id: 'a', name: 'Lado', mode: 'partners', rules: { seating: 'side', stacking: 'off' } },
      { id: 'b', name: 'Frente', mode: 'partners', rules: { seating: 'across', partnerPass: true } },
    ]));
    const [side, across] = loadProfiles(s);
    expect(side).toMatchObject({ mode: 'sideBySide', name: 'Lado' });
    expect(side.rules.stacking).toBe('any');
    expect(across).toMatchObject({ mode: 'classic', name: 'Frente' });
    expect(across.rules.partnerPass).toBe(true);
  });

  it('saves, loads, overwrites per mode and deletes by id', () => {
    const s = mem();
    expect(saveProfile('  Mine ', 'classic', rules, s)).toHaveLength(1);
    const first = loadProfiles(s)[0];
    expect(first).toMatchObject({ name: 'Mine', mode: 'classic' });
    expect(saveProfile('MINE', 'classic', rules, s)).toHaveLength(1);
    expect(loadProfiles(s)[0]).toMatchObject({ id: first.id, name: 'MINE' });
    expect(saveProfile('mine', 'action', RULE_PRESETS[1].rules, s)).toHaveLength(2);
    expect(deleteProfile(first.id, s)).toHaveLength(1);
  });
  it('caps names and count, ignores empty names', () => {
    const s = mem();
    expect(saveProfile('x'.repeat(50), 'classic', rules, s)[0].name).toBe('x'.repeat(24));
    expect(saveProfile('  ', 'classic', rules, s)).toHaveLength(1);
    for (let i = 1; i < MAX_PROFILES + 3; i++) saveProfile(`p${i}`, 'classic', rules, s);
    expect(loadProfiles(s)).toHaveLength(MAX_PROFILES);
  });
  it('survives corrupt data and sanitizes rules', () => {
    const s = mem();
    s.setItem(RULE_PROFILES_KEY, '{nope');
    expect(loadProfiles(s)).toEqual([]);
    s.setItem(RULE_PROFILES_KEY, JSON.stringify([null, { name: 5 }, { id: 'a', name: 'ok', mode: 'bogus', rules: { bogusKey: 1 } }, { name: 'OK' }]));
    const l = loadProfiles(s);
    expect(l).toHaveLength(1);
    expect(l[0].mode).toBe('classic');
    expect(l[0].rules).not.toHaveProperty('bogusKey');
  });
  it('migrates the legacy key', () => {
    const s = mem();
    s.setItem(LEGACY_PROFILES_KEY, JSON.stringify([{ name: 'Old', mode: 'action', rules, savedAt: 5 }]));
    const l = loadProfiles(s);
    expect(l).toMatchObject([{ name: 'Old', mode: 'action' }]);
    expect(l[0].id).toBeTruthy();
    expect(s.getItem(LEGACY_PROFILES_KEY)).toBeNull();
    expect(loadProfiles(s)[0].id).toBe(l[0].id);
  });
  it('allPresets lists built-ins then profiles', () => {
    const s = mem();
    saveProfile('Mine', 'classic', rules, s);
    const a = allPresets(s);
    expect(a).toHaveLength(RULE_PRESETS.length + 1);
    expect(a.at(-1)?.label.es).toBe('Mine');
  });
});
