import { describe, expect, it } from 'vitest';
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from '../../src/net/protocol';
import { RULE_PRESETS } from '../../src/engine/rules';
import {
  autoSeat,
  ensureHost,
  fillSeats,
  freeSeats,
  generateCode,
  LobbyError,
  newRoom,
  normalizeCode,
  normalizeRules,
  publicRoom,
  removeMember,
  sanitizeFace,
  sanitizeName,
  seatOf,
  setCpu,
  setMode,
  setRules,
  sit,
  type RoomData,
} from '../src/lobby';

function join(r: RoomData, pid: string, now = 0): void {
  r.members[pid] = { playerId: pid, name: pid, face: 0, connected: true, cpuCovering: false, joinedAt: now };
  if (!r.hostId) r.hostId = pid;
  autoSeat(r, pid);
}

describe('room codes', () => {
  it('uses the protocol alphabet and length', () => {
    let x = 0;
    const rnd = () => ((x = (x * 9301 + 49297) % 233280), x / 233280);
    for (let i = 0; i < 300; i++) {
      const c = generateCode(rnd);
      expect(c).toHaveLength(ROOM_CODE_LENGTH);
      for (const ch of c) expect(ROOM_CODE_ALPHABET).toContain(ch);
    }
  });
  it('normalizes user input (KUCA-XXXX)', () => {
    expect(normalizeCode('7kqm')).toBe('7KQM');
    expect(normalizeCode(' KUCA-7KQM ')).toBe('7KQM');
    expect(normalizeCode('kuca-7kqm')).toBe('7KQM');
    expect(normalizeCode('KUDO-7KQM')).toBeNull();
    expect(normalizeCode('7KQ0')).toBeNull();
  });
});

describe('names and faces', () => {
  it('trims, strips invisible characters and caps the length', () => {
    expect(sanitizeName('  Ana  ')).toBe('Ana');
    expect(sanitizeName('A‮B​C')).toBe('ABC');
    expect(sanitizeName('x'.repeat(40))).toHaveLength(16);
    expect(sanitizeName('')).toBe('Jugador');
  });
  it('cleans a face with KuAvatars', () => {
    const f = sanitizeFace({ iris: 'javascript:alert(1)', junk: 'x'.repeat(5000) });
    expect(JSON.stringify(f)).not.toContain('javascript');
    expect(JSON.stringify(f).length).toBeLessThan(2000);
    expect(sanitizeFace(3)).toBeTruthy();
  });
});

describe('seats, modes, rules, host', () => {
  it('auto-seats arrivals; the creator is host', () => {
    const r = newRoom('ABCD', 0);
    join(r, 'p1');
    join(r, 'p2');
    expect(seatOf(r, 'p1')).toBe(0);
    expect(seatOf(r, 'p2')).toBe(1);
    expect(r.hostId).toBe('p1');
    expect(freeSeats(r)).toBe(2);
  });

  it('sit moves, stands up and refuses a taken seat', () => {
    const r = newRoom('ABCD', 0);
    join(r, 'p1');
    join(r, 'p2');
    sit(r, 'p2', 2);
    expect(seatOf(r, 'p2')).toBe(2);
    expect(() => sit(r, 'p2', 0)).toThrow(LobbyError);
    sit(r, 'p2', null);
    expect(seatOf(r, 'p2')).toBeNull();
  });

  it('modes: 2 players use seats 0 and 2; Parejas is always 4 with its teams', () => {
    const r = newRoom('ABCD', 0);
    join(r, 'p1');
    join(r, 'p2'); // seat 1
    setMode(r, 'p1', 'classic', 2);
    expect(seatOf(r, 'p2')).toBe(2);
    expect(r.seats[1].kind).toBe('empty');
    expect(() => setMode(r, 'p2', 'action', 3)).toThrow(LobbyError);
    setMode(r, 'p1', 'sideBySide', 2);
    expect(r.playerCount).toBe(4);
    expect(r.rules.stacking).toBe('any');
    expect(publicRoom(r).teams).toEqual([[0, 1], [2, 3]]);
    setRules(r, 'p1', { ...r.rules, stacking: 'off' });
    expect(r.rules.stacking).toBe('any'); // Codo a codo always stacks
    setMode(r, 'p1', 'classic', 4, true);
    expect(publicRoom(r).teamPlay).toBe(true);
    expect(publicRoom(r).teams).toEqual([[0, 2], [1, 3]]);
    setMode(r, 'p1', 'classic', 3, true);
    expect(publicRoom(r).teams).toBeNull();
  });

  it('rules are normalized on top of the preset', () => {
    const rules = normalizeRules({ stacking: 'nonsense', jumpIn: true, deck: 'cyclone', handSize: 99, evil: 1 }, 'classic');
    expect(rules.stacking).toBe('off');
    expect(rules.jumpIn).toBe(true);
    expect(rules.deck).toBe('classic');
    expect(rules.handSize).toBe(7);
    expect('evil' in rules).toBe(false);
  });

  it('host-only CPU seats, distinct characters', () => {
    const r = newRoom('ABCD', 0);
    join(r, 'p1');
    setCpu(r, 'p1', 1, 'lola');
    expect(() => setCpu(r, 'p1', 2, 'lola')).toThrow(LobbyError);
    expect(() => setCpu(r, 'p1', 0, 'carlos')).toThrow(LobbyError);
    fillSeats(r, () => 0.3);
    const ids = r.seats.filter((s) => s.kind === 'cpu').map((s) => (s as { characterId: string }).characterId);
    expect(new Set(ids).size).toBe(3);
  });

  it('the host passes on; a leaver mid-match becomes a CPU', () => {
    const r = newRoom('ABCD', 0);
    join(r, 'p1', 0);
    join(r, 'p2', 1);
    r.members.p1.connected = false;
    expect(ensureHost(r)).toBe(true);
    expect(r.hostId).toBe('p2');
    r.phase = 'playing';
    removeMember(r, 'p1');
    expect(r.seats[0].kind).toBe('cpu');
    expect(r.members.p1).toBeUndefined();
  });
});
