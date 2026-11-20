/**
 * Server tunables. The protocol constants are the defaults; tests (and only tests) shorten them via
 * Worker vars, e.g. `wrangler dev --var KUCA_TURN_TIMEOUT_MS:1500`.
 */
import type { Tunables } from '../../src/net/room/core';
import { DISCONNECT_GRACE_MS, NEXT_ROUND_MS, ROOM_IDLE_TTL_MS, TURN_TIMEOUT_MS, WINDOW_MS } from '../../src/net/protocol';

export interface Env {
  ROOMS: DurableObjectNamespace;
  KUCA_TURN_TIMEOUT_MS?: string;
  KUCA_WINDOW_MS?: string;
  KUCA_GRACE_MS?: string;
  KUCA_IDLE_TTL_MS?: string;
  /** pause between the end of a round and the next deal (clients show the round summary meanwhile) */
  KUCA_NEXT_ROUND_MS?: string;
  /** multiplier on CPU think delays (1 = like the local game; tests use ~0.05) */
  KUCA_CPU_SPEED?: string;
  /** comma-separated extra allowed CORS / WebSocket origins */
  KUCA_EXTRA_ORIGINS?: string;
}

const num = (v: string | undefined, d: number, min = 0): number => {
  const n = v === undefined || v === '' ? NaN : Number(v);
  return Number.isFinite(n) && n >= min ? n : d;
};

export function tunables(env: Partial<Env>): Tunables {
  return {
    turnTimeoutMs: num(env.KUCA_TURN_TIMEOUT_MS, TURN_TIMEOUT_MS, 200),
    windowMs: num(env.KUCA_WINDOW_MS, WINDOW_MS, 100),
    graceMs: num(env.KUCA_GRACE_MS, DISCONNECT_GRACE_MS, 0),
    idleTtlMs: num(env.KUCA_IDLE_TTL_MS, ROOM_IDLE_TTL_MS, 1000),
    nextRoundMs: num(env.KUCA_NEXT_ROUND_MS, NEXT_ROUND_MS, 0),
    cpuSpeed: num(env.KUCA_CPU_SPEED, 1, 0),
  };
}
