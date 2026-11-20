import type { EngineApi } from '../contracts';
import { chooseMove } from './ai';
import { applyMove, closeWindow, createMatch, legalMoves, startRound, timeUp } from './game';
import { DEFAULT_RULES, RULE_PRESETS, RULE_SETTINGS } from './rules';

export { RULE_SETTINGS, DEFAULT_RULES, RULE_PRESETS, RULES_VERSION } from './rules';
export { buildDeck, cardPoints, isWildKind, isPenaltyKind, PENALTY_DRAW } from './cards';
export {
  createMatch, startRound, matches, shuffle, legalMoves, applyMove, closeWindow, isLegal, sameMove,
  canPlay, canStack, identical, cardCount, handPoints, stepSeat, teamOf, opponents, activeSeats, topCard,
  partnerOf, visibleHands, giveOptions, penaltyOf, timeUp, timeUpWinner,
} from './game';
export * from './clock';
export { chooseMove, scoreMove, timeoutMove, afterAutoDraw, withAutoColor, AUTO_COLOR } from './ai';

export const engine: EngineApi = {
  RULE_SETTINGS,
  DEFAULT_RULES,
  RULE_PRESETS,
  createMatch,
  startRound,
  legalMoves,
  applyMove,
  closeWindow,
  timeUp,
  chooseMove,
};

export default engine;
