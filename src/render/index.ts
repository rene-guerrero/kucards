import type { Card, RestoreState, Seat, TableView, TableViewOptions } from '../contracts';
import { CardTable } from './cardTable';

/** TableView with the optional extras implemented, plus two extensions the contract does not carry yet. */
export interface TableViewExt extends TableView {
  restore(state: RestoreState): Promise<void>;
  setSpeed(x: number): void;
  setReducedMotion(r: boolean): void;
  setTableStyle(s: NonNullable<TableViewOptions['tableStyle']>): void;
  setCardBack(b: NonNullable<TableViewOptions['cardBack']>): void;
  /** put exactly these cards in the human hand (e.g. after a swap / rotate, whose events carry no faces) */
  setHand(cards: Card[]): void;
  /** card faces by id (the match's deck), so swept / revealed opponent cards can show their faces */
  setDeck(cards: readonly Card[]): void;
  /** show a seat's hand face up (Parejas partner), null = face down again; cheap, diff-based */
  setOpenHand(seat: Seat, cards: Card[] | null): void;
  /** Parejas teams for the felt tint (team A teal, team B coral); null = none. Without it, an open hand implies the partner. */
  setTeams(teams: [Seat[], Seat[]] | null): void;
  /** the pile's screen point in viewport CSS px (the colour pane springs from it); null before layout */
  pileScreenPoint(): { x: number; y: number } | null;
  /** move the human's colour-changing card onto the pile before the colour is picked; resolves when it has landed */
  previewPlay(cardId: number): Promise<void>;
  /** return a previewed card to the hand (no play followed) */
  cancelPreview(): void;
}

export function createTableView(opts: TableViewOptions): TableViewExt {
  return new CardTable(opts);
}
