/**
 * KuCards' room core for kunet's local hosts (the Node dev host, the Android Wi-Fi / Bluetooth host, the
 * hosting device's own loopback): the same RoomCore the Durable Object runs, with the default timers.
 */
import type { CodeRules, MakeCore } from 'kunet';
import { DISCONNECT_GRACE_MS, NEXT_ROUND_MS, ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH, ROOM_IDLE_TTL_MS, TURN_TIMEOUT_MS, WINDOW_MS } from '../protocol';
import { RoomCore, type Tunables } from './core';
import { normalizeCode, type RoomData } from './lobby';

export const GAME_ID = 'kucards';

export const LOCAL_TUNABLES: Tunables = {
  turnTimeoutMs: TURN_TIMEOUT_MS,
  windowMs: WINDOW_MS,
  graceMs: DISCONNECT_GRACE_MS,
  idleTtlMs: ROOM_IDLE_TTL_MS,
  nextRoundMs: NEXT_ROUND_MS,
  cpuSpeed: 1,
};

export const makeCore: MakeCore = (io, data) => new RoomCore(io, LOCAL_TUNABLES, data ? resumed(data as RoomData, io.now()) : null);

/**
 * A saved room coming back after the host app restarted: nobody is connected any more. Everyone gets
 * the usual grace period to come back (then a CPU covers their seat), and the clocks restart when the
 * first player is back.
 */
function resumed(r: RoomData, now: number): RoomData {
  const out: RoomData = JSON.parse(JSON.stringify(r));
  for (const m of Object.values(out.members)) {
    if (!m.connected) continue;
    m.connected = false;
    out.schedule.grace[m.playerId] = now + LOCAL_TUNABLES.graceMs;
  }
  out.schedule.game = null;
  out.schedule.win = null;
  out.schedule.idle = now + LOCAL_TUNABLES.idleTtlMs;
  return out;
}

export const CODE_RULES: CodeRules = { alphabet: ROOM_CODE_ALPHABET, length: ROOM_CODE_LENGTH };

export { normalizeCode };
