import type { FaceSpec } from 'kuavatars/faces';
/**
 * ONLINE MULTIPLAYER PROTOCOL — the single contract between the room server (server/, Cloudflare
 * Worker + one Durable Object per room) and the game client (src/net/**, online UI in src/ui/**).
 * Ported from Kudominoes and adapted for cards.
 *
 * Design: family & friends, private rooms joined by a short code or link, no accounts (a random device
 * id + a name stored on the phone), no spectators, 30 s turn timer after which a CPU plays for that seat,
 * CPUs fill empty seats and take over disconnected players until they return. The SERVER IS
 * AUTHORITATIVE: it owns MatchState, runs the pure engine (src/engine) and the CPU, and sends every
 * player only what their seat may see: their own hand (plus the partner's in Parejas with partnerOpen),
 * the other players' card COUNTS, never the deck order.
 *
 * Response windows (round.window: shield / mirror against a penalty, catching a missed ¡Ku!) are a
 * server-scheduled entry of WINDOW_MS; then the server closes them (EngineApi.closeWindow). Out-of-turn
 * moves are resolved first-come in server arrival order, each validated with legalMoves for that seat.
 *
 * Transport: JSON text frames over one WebSocket per player:
 *   GET  {SERVER}/api/rooms/{code}/ws?pid={playerId}   (upgrade)
 *   POST {SERVER}/api/rooms                            → CreateRoomResponse (creates a code)
 *   GET  {SERVER}/api/rooms/{code}                     → RoomInfoResponse (exists? joinable?)
 *
 * Adding OPTIONAL fields is fine; renaming/removing anything requires updating both sides.
 */
import type { Card, Difficulty, GameEvent, GameMode, Move, RuleSettings, Seat } from '../contracts';
import type { ClockSettings } from '../engine/clock';
import type { ModeDef } from '../engine/modes';
import { sideSeating } from '../modes/core';

/** KuCards speaks its own protocol (Kudominoes is v1); v3 adds setSwappedSeats */
export const PROTOCOL_VERSION = 3;
/** room codes: 4 chars from an unambiguous alphabet (no 0/O/1/I), shown as KUCA-XXXX */
export const ROOM_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
export const ROOM_CODE_LENGTH = 4;
export const ROOM_CODE_PREFIX = 'KUCA-';
export const TURN_TIMEOUT_MS = 30_000;
/** how long a response window stays open (shield / mirror / catching a missed ¡Ku!) */
export const WINDOW_MS = 2_500;
/** a disconnected player's seat is played by a CPU after this grace period (they can rejoin any time) */
export const DISCONNECT_GRACE_MS = 8_000;
/** rooms with nobody connected are deleted after this */
export const ROOM_IDLE_TTL_MS = 2 * 60 * 60 * 1000;
/** pause between the end of a round and the next deal (clients show the round summary meanwhile) */
export const NEXT_ROUND_MS = 8_000;
export const MAX_NAME_LENGTH = 16;

// ───────────────────────── HTTP ─────────────────────────

export interface CreateRoomResponse {
  code: string; // e.g. "7KQM" (display as KUCA-7KQM)
}
export interface RoomInfoResponse {
  exists: boolean;
  phase?: RoomPhase;
  /** free human seats (0 when the match is running and every human seat is taken) */
  freeSeats?: number;
}

// ───────────────────────── room state (what everyone sees) ─────────────────────────

export type RoomPhase = 'lobby' | 'playing' | 'finished';

export type SeatOccupant =
  | { kind: 'empty' }
  /** a human player; `connected` false = dropped (a CPU plays for them after the grace period) */
  | { kind: 'human'; playerId: string; name: string; face: number | FaceSpec; connected: boolean; cpuCovering: boolean }
  /** a roster character filling the seat (src/roster.ts id) */
  | { kind: 'cpu'; characterId: string };

export interface PublicRoom {
  code: string;
  phase: RoomPhase;
  hostId: string; // playerId of the host (creator; passes to the next connected human if they leave)
  mode: GameMode;
  /** 2–4 (always 4 in Codo a codo) */
  playerCount: number;
  /** 2 vs 2 Enfrente (4 players, Clásico / Pura acción / Ciclón; absent from older servers = off) */
  teamPlay?: boolean;
  /** a player-made mode the host picked (its whole definition, so guests can play and copy it); `mode` is its base */
  custom?: ModeDef;
  /** side seating only: each player's own avatar/name has been swapped with their partner's (rivals stay put) */
  swappedSeats?: boolean;
  /** index = Seat (0..3). Seats in play: SEATS_FOR[playerCount] ({2: [0,2], 3: [0,1,3], 4: [0,1,2,3]}). */
  seats: SeatOccupant[];
  rules: RuleSettings;
  /** round limit / move times picked by the host (absent from older servers = no limit, 30 s) */
  clock?: ClockSettings;
  /** running match scores by seat (null in the lobby) */
  scores: number[] | null;
  /** team play: the two teams as seat lists (2 vs 2 across [[0,2],[1,3]], Codo a codo [[0,1],[2,3]]) */
  teams?: [Seat[], Seat[]] | null;
}

// ───────────────────────── per-player view (private) ─────────────────────────

/**
 * Everything one seat may know right now, sent on (re)join and whenever a resync is needed.
 * The client builds its local display from this (instant restore — no replay).
 */
export interface SeatView {
  seat: Seat;
  /** a MatchState REDACTED for this seat: hands it may not see are emptied (see handCounts), the deck is
   *  emptied (see deckCount), engine internals that hide information are stripped, rng = 0 */
  match: unknown;
  handCounts: number[]; // index = Seat
  deckCount: number;
  /** this seat's legal moves right now (turn and out-of-turn; [] while a CPU covers it) */
  legal: Move[];
  /** absolute deadline (server ms) of the human turn in progress, if any */
  turnDeadline: number | null;
  /** absolute deadline (server ms) of the open response window, if any */
  windowEnds: number | null;
  /** absolute end (server ms) of the round clock; null = no round limit */
  roundEnds?: number | null;
  /** the full time of the current move (ms), for the ring */
  moveMs?: number;
}

/**
 * Sent with every 'events' batch: the authoritative counts and the hands this seat may see after the
 * batch (own hand, the partner's with partnerOpen; every hand once the round is over, as at a real
 * table). The client corrects its copy with it (the events alone cannot say e.g. which shield card left
 * a hidden hand).
 */
export interface Snapshot {
  counts: number[];
  deck: number;
  /** the stacked penalty waiting to be drawn */
  pending: number;
  hands: { seat: Seat; cards: Card[] }[];
}

// ───────────────────────── client → server ─────────────────────────

export type ClientMsg =
  /** first message after the socket opens (also on every reconnect) */
  | { t: 'hello'; v: number; playerId: string; name: string; face: number | FaceSpec }
  /** lobby: take / move to a seat (null = leave seat, stay in room) */
  | { t: 'sit'; seat: Seat | null }
  /** lobby, host only: put a roster CPU in a seat (null = empty it) */
  | { t: 'setCpu'; seat: Seat; characterId: string | null }
  /** lobby, host only (Parejas is always 4 players) */
  | { t: 'setMode'; mode: GameMode; playerCount: number; teamPlay?: boolean }
  /** lobby, host only (side seating): swap each player's avatar/name with their partner's */
  | { t: 'setSwappedSeats'; swapped: boolean }
  | { t: 'setRules'; rules: RuleSettings }
  /** host: play a player-made mode (null = back to the built-in `mode`) */
  | { t: 'setCustom'; def: ModeDef | null; playerCount?: number; teamPlay?: boolean }
  /** lobby, host only: round limit / move times (clamped by the server) */
  | { t: 'setClock'; clock: ClockSettings }
  /** lobby/finished, host only: start (empty seats are auto-filled with roster CPUs) */
  | { t: 'start' }
  /**
   * in game: any move that is legal for your seat right now (turn moves, and out of turn: jumpIn,
   * callKu, catchKu, respond). Plays may carry `ku: true` and (partnerPass) `give`.
   */
  | { t: 'move'; move: Move }
  /** quick phrase / emote by id (see QUICK_PHRASES); rate-limited server-side */
  | { t: 'phrase'; id: string }
  | { t: 'rematch' }
  | { t: 'leave' }
  | { t: 'ping'; at: number };

// ───────────────────────── server → client ─────────────────────────

export type ServerMsg =
  /** answer to hello: who you are + full snapshot */
  | { t: 'welcome'; you: { playerId: string; seat: Seat | null; isHost: boolean }; room: PublicRoom; view: SeatView | null }
  /** lobby/room metadata changed (seats, host, rules, presence, scores) */
  | { t: 'room'; room: PublicRoom }
  /**
   * game progress, REDACTED for the receiving seat: draws by seats it may not see carry no `cards`,
   * deal / swapHands / rotateHands carry `hand` / `cards` only for the receiving seat. Animate in order.
   */
  | { t: 'events'; events: GameEvent[]; snap: Snapshot }
  /**
   * The state after every change: whose turn it is, the deadlines, and the receiving seat's legal moves
   * (turn moves when it is theirs, out-of-turn moves any time; [] while a CPU covers them).
   */
  | { t: 'turn'; seat: Seat; deadline: number | null; legal: Move[]; windowEnds: number | null; roundEnds?: number | null; moveMs?: number; /** final minute only: [seat, position] badges (1 = fewest card points) */ ranks?: [Seat, number][] }
  /** full private resync (after reconnect, or if the client reports it's out of sync) */
  | { t: 'sync'; room: PublicRoom; view: SeatView }
  | { t: 'phrase'; seat: Seat; id: string }
  /** a CPU just played for a human seat (timer ran out or player disconnected) */
  | { t: 'covered'; seat: Seat; reason: 'timeout' | 'disconnected' }
  | { t: 'error'; code: ErrorCode; message?: string }
  | { t: 'pong'; at: number; serverNow: number };

export type ErrorCode =
  | 'room_not_found'
  | 'room_full'
  | 'not_host'
  | 'bad_move'
  /** an out-of-turn move arrived after someone else's (first come, first served): not an error to show */
  | 'too_late'
  | 'not_your_turn'
  | 'bad_request'
  | 'version_mismatch'
  | 'rate_limited';

/** placeholder face for a card the receiver may not see (ids of hidden cards are negative) */
export const HIDDEN_FACE = { kind: 'number', color: null, value: 0 } as const;

/** CPU level used when a CPU covers a human seat (timeout / disconnect) */
export const COVER_LEVEL: Difficulty = 'normal';

/** quick phrases (ids are stable; text lives in the client i18n) — neutral Spanish, no slang */
export const QUICK_PHRASES = ['hello', 'nice', 'oops', 'thinking', 'hurry', 'gg', 'thanks', 'wow'] as const;
export type QuickPhraseId = (typeof QUICK_PHRASES)[number];
/** avatar hand gestures sent through the same 'phrase' message as `g:<gesture>` (names as in KuAvatars) */
export const CHAT_GESTURES = ['thumbsUp', 'thumbsDown', 'rub', 'clap', 'wave', 'shrug', 'facepalm', 'chin', 'mewing'] as const;
export type ChatGesture = (typeof CHAT_GESTURES)[number];
/** a quick phrase id or a gesture id ('g:wave') */
export const isChatId = (id: string): boolean =>
  (QUICK_PHRASES as readonly string[]).includes(id) || (id.startsWith('g:') && (CHAT_GESTURES as readonly string[]).includes(id.slice(2)));
export const MAX_GESTURES = 5;
export const DEFAULT_GESTURES: ChatGesture[] = ['thumbsUp', 'clap', 'wave', 'shrug', 'facepalm'];
/** the stored gesture picks: known gestures, no repeats, at most 5 (not a list: the defaults) */
export function sanitizeGestures(v: unknown): ChatGesture[] {
  if (!Array.isArray(v)) return [...DEFAULT_GESTURES];
  const out: ChatGesture[] = [];
  for (const g of v) if ((CHAT_GESTURES as readonly string[]).includes(g) && !out.includes(g) && out.length < MAX_GESTURES) out.push(g);
  return out;
}

/** seats in play by player count (same as the engine) */
export const SEATS_FOR: Record<2 | 3 | 4, Seat[]> = { 2: [0, 2], 3: [0, 1, 3], 4: [0, 1, 2, 3] };

/** the seats in play of a room */
export function activeSeatsOf(room: { mode: GameMode; playerCount: number }): Seat[] {
  if (room.mode === 'sideBySide') return [0, 1, 2, 3];
  const n = room.playerCount === 2 || room.playerCount === 3 ? room.playerCount : 4;
  return SEATS_FOR[n].slice();
}

/** is this room really playing with partners seated next to each other? (the shared predicate) */
export function sideSeatingRoom(room: { mode: GameMode; playerCount: number; teamPlay?: boolean; custom?: ModeDef }): boolean {
  const c = room.custom;
  if (c) {
    const on = room.playerCount === 4 && (c.teams === 'always' || (c.teams === 'optional' && !!room.teamPlay));
    return sideSeating(c, room.playerCount, on);
  }
  return room.mode === 'sideBySide' && room.playerCount === 4;
}

/** teams of a room (side seating pairs the neighbours; 2 vs 2 across pairs 0+2 and 1+3) */
export function teamsFor(room: { mode: GameMode; playerCount: number; teamPlay?: boolean; custom?: ModeDef; swappedSeats?: boolean }): [Seat[], Seat[]] | null {
  const c = room.custom;
  if (c) {
    const on = room.playerCount === 4 && (c.teams === 'always' || (c.teams === 'optional' && !!room.teamPlay));
    if (!on) return null;
    return sideSeatingRoom(room) ? [[0, 1], [2, 3]] : [[0, 2], [1, 3]];
  }
  if (room.mode === 'sideBySide') return [[0, 1], [2, 3]];
  return room.teamPlay && room.playerCount === 4 ? [[0, 2], [1, 3]] : null;
}
