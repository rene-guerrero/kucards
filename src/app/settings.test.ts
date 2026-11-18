import { describe, expect, it } from 'vitest';
import { RULE_PRESETS, RULES_VERSION } from '../engine/rules';
import { DEFAULT_LINEUP } from '../roster';
import { defaultSettings, descriptorsFor, migrateSettings, rulesFor, sanitizeLineupSetting, sanitizeRules, withMode, withRules } from './settings';

describe('settings', () => {
  it('defaults: Spanish, Classic, rules per mode from the presets', () => {
    const s = defaultSettings();
    expect(s.language).toBe('es');
    expect(s.mode).toBe('classic');
    expect(s.players).toBe(4);
    for (const p of RULE_PRESETS) expect(s.rulesByMode?.[p.id]).toEqual(p.rules);
    expect(s.rules).toEqual(s.rulesByMode?.classic);
  });

  it('migrates garbage to defaults', () => {
    expect(migrateSettings(null)).toEqual(defaultSettings());
    const s = migrateSettings({ language: 'fr', players: 7, avatarFace: 99, tableStyle: 'pink', cardBack: 'x', mode: 'pairs', lineup: { 1: 'zorg', 2: 'zorg', 3: 'lola' } });
    expect(s.language).toBe('es');
    expect(s.players).toBe(4);
    expect(typeof (s.avatarFace as { iris: string }).iris).toBe('string'); // any input becomes a clean FaceSpec
    expect(migrateSettings({ avatarFace: { iris: '#123456', hat: 'crown', bogus: 1 } }).avatarFace).toEqual({ iris: '#123456', hat: 'crown' });
    expect(s.tableStyle).toBe('teal');
    expect(s.cardBack).toBe('ku');
    expect(s.mode).toBe('classic');
    expect(s.lineup).toEqual(DEFAULT_LINEUP);
    expect(s.rulesVersion).toBe(RULES_VERSION);
  });

  it('keeps valid stored values and drops invalid rule values', () => {
    const s = migrateSettings({
      language: 'en',
      players: 3,
      mode: 'cyclone',
      rulesByMode: { classic: { handSize: 10, stacking: 'nope', jumpIn: 'yes', deck: 'action' }, cyclone: { target: 200 } },
    });
    expect(s.language).toBe('en');
    expect(s.players).toBe(3);
    expect(s.rulesByMode?.classic?.handSize).toBe(10);
    expect(s.rulesByMode?.classic?.stacking).toBe('off');
    expect(s.rulesByMode?.classic?.jumpIn).toBe(false);
    // preset-only keys come from the preset
    expect(s.rulesByMode?.classic?.deck).toBe('classic');
    expect(s.rules.target).toBe(200);
    expect(s.rules.stacking).toBe('any');
  });

  it('migrates a flat `rules` from before rulesByMode into the selected mode', () => {
    const s = migrateSettings({ mode: 'action', rules: { handSize: 5 } });
    expect(s.rulesByMode?.action?.handSize).toBe(5);
    expect(s.rulesByMode?.classic?.handSize).toBe(7);
  });

  it('lineup accepts random and rejects duplicates', () => {
    expect(sanitizeLineupSetting({ 1: 'random', 2: 'rosa', 3: 'random' })).toEqual({ 1: 'random', 2: 'rosa', 3: 'random' });
    expect(sanitizeLineupSetting({ 1: 'rosa', 2: 'rosa', 3: 'lola' })).toEqual(DEFAULT_LINEUP);
  });

  it('withRules / withMode keep rules in sync', () => {
    let s = defaultSettings();
    s = withRules(s, 'action', { ...rulesFor(s, 'action'), handSize: 10 });
    expect(s.rules.handSize).toBe(7);
    s = withMode(s, 'action');
    expect(s.rules.handSize).toBe(10);
  });

  it('partners-only rules are filtered by mode', () => {
    expect(descriptorsFor('classic').some((d) => d.key === 'seating')).toBe(false);
    expect(descriptorsFor('partners').some((d) => d.key === 'seating')).toBe(true);
    expect(sanitizeRules({ seating: 'side' }, 'partners').seating).toBe('side');
  });
});
