/**
 * The one game-mode dropdown (Nueva partida, the Sala, Ajustes › Reglas): built-in and player-made modes,
 * each with its icon. Built on ruleSelect.
 */
import type { GameMode } from '../contracts';
import { RULE_PRESETS } from '../engine/rules';
import { loadCustomModes } from '../app/customModes';
import { loc, t } from './i18n';
import { modeIconSvg } from './modeIcons';
import { BUILTIN_MODES } from '../engine/modes';
import { ruleSelect } from './settings';

export interface ModeChoice {
  id: string;
  label: string;
  icon: string;
  custom: boolean;
}

/** the built-in modes (preset names, both languages) */
export const builtInModeNames = (): string[] => RULE_PRESETS.flatMap((p) => [p.label.es, p.label.en]);

/** every mode to choose from: the built-ins, then the player's own (optionally only the built-ins) */
export function modeChoices(builtInOnly = false): ModeChoice[] {
  const out: ModeChoice[] = RULE_PRESETS.map((p) => ({ id: p.id, label: loc(p.label), icon: BUILTIN_MODES[p.id as GameMode]?.icon ?? 'cards', custom: false }));
  if (!builtInOnly) for (const d of loadCustomModes()) out.push({ id: d.id, label: d.name, icon: d.icon, custom: true });
  return out;
}

export interface ModeSelectOpts {
  /** the selected mode id */
  current: string;
  /** shown instead of the mode's own name (e.g. a rule set: "Mi casa") */
  currentLabel?: string;
  onPick(id: string): void;
  choices?: ModeChoice[];
  disabled?: boolean;
  variant?: 'soft';
}

export function modeSelect(o: ModeSelectOpts): HTMLElement {
  const list = o.choices ?? modeChoices();
  const el = ruleSelect(
    list.map((c) => ({
      label: c.id === o.current && o.currentLabel ? o.currentLabel : c.label,
      icon: modeIconSvg(c.icon),
      on: c.id === o.current,
      pick: () => o.onPick(c.id),
    })),
    t('newgame.rules'),
    o.variant,
  );
  el.classList.add('mode-select');
  if (o.disabled) el.querySelector<HTMLButtonElement>('.rsel-btn')?.setAttribute('disabled', '');
  return el;
}
