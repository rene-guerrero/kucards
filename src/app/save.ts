/**
 * The offline match in progress, saved after every move so "Continuar" can pick it up (even after the
 * app was closed). One slot. Anything unreadable or from another version is dropped.
 */
import type { Lineup, MatchState } from '../contracts';

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
    return s;
  } catch {
    return null;
  }
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
