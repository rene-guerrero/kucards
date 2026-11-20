/**
 * The offline match in progress, saved after every move so "Continuar" can pick it up (even after the
 * app was closed). One slot. Anything unreadable or from another version is dropped.
 */
import type { Lineup, MatchState } from '../contracts';
import { modeRules } from '../engine/rules';

const KEY = 'kucards.save.v1';
const VERSION = 1;

export interface SavedGame {
  v: number;
  match: MatchState;
  lineup: Lineup;
}

export function saveGame(match: MatchState, lineup: Lineup): void {
  try {
    if (match.over) return clearSave();
    localStorage.setItem(KEY, JSON.stringify({ v: VERSION, match, lineup } satisfies SavedGame));
  } catch {
    /* storage full / blocked: the game goes on without a save */
  }
}

export function loadSave(): SavedGame | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as SavedGame;
    if (s?.v !== VERSION || !s.match?.seats?.length || s.match.over) return null;
    return migrateSave(s);
  } catch {
    return null;
  }
}

/** old Parejas saves: side teams ([[0,1],[2,3]] / [[0,3],[1,2]]) → Codo a codo, across → Clásico 2 vs 2 */
export function migrateSave(s: SavedGame): SavedGame {
  if ((s.match.mode as string) !== 'partners') return s;
  const across = !!s.match.teams?.[0].includes(2);
  const mode = across ? 'classic' : 'sideBySide';
  const teams = s.match.teams ?? (across ? [[0, 2], [1, 3]] : [[0, 1], [2, 3]]);
  return { ...s, match: { ...s.match, mode, teams, rules: modeRules(mode, s.match.rules) } };
}

export function clearSave(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/** what the menu shows under "Continuar" */
export function saveSummary(s: SavedGame | null): { round: number } | null {
  return s ? { round: s.match.round?.roundNo ?? 1 } : null;
}
