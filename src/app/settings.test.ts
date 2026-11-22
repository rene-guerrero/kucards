import { describe, expect, it } from 'vitest';
import { RULE_PRESETS, RULES_VERSION } from '../engine/rules';
import { DEFAULT_LINEUP } from '../roster';
import { defaultSettings, descriptorsFor, migrateSettings, rulesFor, sanitizeLineupSetting, sanitizeRules, withMode, withRules } from './settings';
import { loadSave, migrateSave, type SavedGame } from './save';
import { createMatch } from '../engine/game';

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

  it('Codo a codo hides and forces stacking; 2 vs 2 rules show in every mode', () => {
    expect(descriptorsFor('classic').some((d) => d.key === 'stacking')).toBe(true);
    expect(descriptorsFor('sideBySide').some((d) => d.key === 'stacking')).toBe(false);
    expect(sanitizeRules({ stacking: 'off' }, 'sideBySide').stacking).toBe('any');
    expect(sanitizeRules({ stacking: 'off' }, 'classic').stacking).toBe('off');
    for (const m of ['classic', 'action', 'cyclone', 'sideBySide'] as const) expect(descriptorsFor(m).some((d) => d.key === 'partnerOpen')).toBe(true);
    expect(descriptorsFor('classic').some((d) => d.key === 'seating')).toBe(false);
  });

  it('migrates the old Parejas mode: side → Codo a codo, across → Clásico with 2 vs 2', () => {
    const side = migrateSettings({ mode: 'partners', players: 3, rulesByMode: { partners: { seating: 'side', partnerPass: true, stacking: 'off' } } });
    expect(side.mode).toBe('sideBySide');
    expect(side.rulesByMode!.sideBySide!.partnerPass).toBe(true);
    expect(side.rules.stacking).toBe('any');
    expect((side.rulesByMode as Record<string, unknown>).partners).toBeUndefined();
    const across = migrateSettings({ mode: 'partners', players: 2, rulesByMode: { partners: { seating: 'across', partnerShield: true }, classic: { jumpIn: true } } });
    expect(across.mode).toBe('classic');
    expect(across.teamPlay).toBe(true);
    expect(across.players).toBe(4);
    expect(across.rules.partnerShield).toBeUndefined(); // retired with Escudo / Espejo: just off
    // Parejas was not the selected mode: Clásico keeps its own rules, 2 vs 2 stays off
    const other = migrateSettings({ mode: 'action', rulesByMode: { partners: { seating: 'across' }, classic: { jumpIn: true } } });
    expect(other.mode).toBe('action');
    expect(other.teamPlay).toBe(false);
    expect(other.rulesByMode!.classic!.jumpIn).toBe(true);
  });

  it('drops saves from before the fixed side seating', () => {
    const store = new Map<string, string>();
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      } as Storage,
    });
    try {
      const match = createMatch(RULE_PRESETS[0].rules, { mode: 'classic', players: 4 });
      store.set('kucards.save.v1', JSON.stringify({ v: 1, match, lineup: {} }));
      expect(loadSave()).toBeNull();
      store.set('kucards.save.v1', JSON.stringify({ v: 2, match, lineup: {} }));
      expect(loadSave()?.match.round).toBeNull();
    } finally {
      if (original) Object.defineProperty(globalThis, 'localStorage', original);
      else delete (globalThis as { localStorage?: Storage }).localStorage;
    }
  });

  it('migrates old Parejas saves', () => {
    const save = (teams: [number[], number[]]): SavedGame => ({ v: 1, lineup: {}, match: { ...createMatch(RULE_PRESETS[0].rules, { mode: 'classic', players: 4 }), mode: 'partners', teams } as unknown as SavedGame['match'] });
    const s = migrateSave(save([[0, 3], [1, 2]]));
    expect(s.match.mode).toBe('sideBySide');
    expect(s.match.rules.stacking).toBe('any');
    expect(s.match.teams).toEqual([[0, 3], [1, 2]]);
    const a = migrateSave(save([[0, 2], [1, 3]]));
    expect(a.match.mode).toBe('classic');
    expect(a.match.teams).toEqual([[0, 2], [1, 3]]);
  });
});

describe('gestures setting', () => {
  it('defaults, sanitizes and caps at 5', async () => {
    const { sanitizeGestures, isChatId } = await import('../net/protocol');
    expect(sanitizeGestures(undefined)).toEqual(['thumbsUp', 'clap', 'wave', 'shrug', 'facepalm']);
    expect(sanitizeGestures(['wave', 'wave', 'nope', 'rub', 'clap', 'chin', 'mewing', 'shrug'])).toEqual(['wave', 'rub', 'clap', 'chin', 'mewing']);
    expect(isChatId('g:wave') && isChatId('hello') && !isChatId('g:nope')).toBe(true);
  });
});
