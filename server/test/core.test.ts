/**
 * The room core driven end to end with a fake platform (sockets + clock): whole matches with humans
 * that answer from their 'turn' messages (or let the clock run out), checking that the game always
 * moves on and that no message ever carries a card the receiver may not see.
 */
import { describe, expect, it } from 'vitest';
import type { Card, GameEvent, GameMode, Move, RuleSettings, Seat } from '../../src/contracts';
import { multiPlayOptions, visibleHands } from '../../src/engine/game';
import { PROTOCOL_VERSION, type ServerMsg } from '../../src/net/protocol';
import { normalizeRules } from '../../src/net/room/lobby';
import { RoomCore, type Attachment, type CoreIO, type Tunables } from '../../src/net/room/core';

interface Sock {
  id: number;
  att: Attachment | null;
  open: boolean;
  inbox: ServerMsg[];
}

const CFG: Tunables = { turnTimeoutMs: 3000, windowMs: 1500, graceMs: 500, idleTtlMs: 60_000, nextRoundMs: 1000, cpuSpeed: 0.2 };

function rig(seed = 1) {
  let now = 1_000_000;
  let x = seed;
  const rnd = () => ((x = (x * 1103515245 + 12345) & 0x7fffffff), x / 0x7fffffff);
  const socks: Sock[] = [];
  const io: CoreIO<Sock> = {
    now: () => now,
    random: rnd,
    seed: () => (rnd() * 0x7fffffff) | 0,
    sockets: () => socks.filter((s) => s.open),
    attachment: (s) => s.att,
    setAttachment: (s, a) => (s.att = a),
    send: (s, m) => s.open && s.inbox.push(JSON.parse(JSON.stringify(m))),
    close: (s) => (s.open = false),
  };
  const core = new RoomCore(io, CFG);
  core.create('ABCD', 'pid-1');
  const join = (pid: string): Sock => {
    const s: Sock = { id: socks.length, att: null, open: true, inbox: [] };
    socks.push(s);
    core.accept(s, pid);
    core.message(s, JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, playerId: pid, name: pid, face: 0 }));
    return s;
  };
  const send = (s: Sock, msg: unknown) => core.message(s, JSON.stringify(msg));
  /** let time pass, firing alarms as they come due */
  const run = (ms: number) => {
    const end = now + ms;
    for (let guard = 0; guard < 10_000; guard++) {
      const at = core.nextAlarm();
      if (at === null || at > end) break;
      now = Math.max(now, at);
      core.alarm();
    }
    now = end;
  };
  return { core, join, send, run, socks, get now() { return now; } };
}

const seatOfPid = (core: RoomCore<Sock>, pid: string): Seat | null => {
  const i = core.data!.seats.findIndex((s) => s.kind === 'human' && s.playerId === pid);
  return i < 0 ? null : (i as Seat);
};

/** every card a message shows, by where it appears */
function checkNoLeak(msg: ServerMsg, seat: Seat, seen: Seat[], roundOverHands: boolean): void {
  if (msg.t === 'events') {
    for (const ev of msg.events as GameEvent[]) {
      if (ev.type === 'draw' && ev.cards) expect(seen).toContain(ev.seat);
      if (ev.type === 'swapHands' && ev.cards) expect([ev.a, ev.b]).toContain(seat);
      if (ev.type === 'window' && ev.window) for (const s of ev.window.seats) expect(s).toBe(seat);
    }
    if (!roundOverHands) for (const h of msg.snap.hands) expect(seen).toContain(h.seat);
  }
  if (msg.t === 'turn') for (const m of msg.legal) expect(m.seat).toBe(seat);
  if ((msg.t === 'welcome' || msg.t === 'sync') && msg.view) {
    const m = msg.view.match as { rng: number; round: { hands: Card[][]; deck: Card[]; challenge?: unknown; outPoints?: unknown } | null };
    expect(m.rng).toBe(0);
    if (m.round) {
      expect(m.round.deck).toEqual([]);
      expect(m.round.challenge).toBeUndefined();
      expect(m.round.outPoints).toBeUndefined();
      m.round.hands.forEach((h, s) => {
        if (!seen.includes(s as Seat)) expect(h).toEqual([]);
      });
    }
  }
}

/** play a whole match: humans answer from their latest 'turn' (random legal move), or idle */
function playMatch(mode: GameMode, rules: Partial<RuleSettings>, humans: number, opts: { idle?: boolean; seed?: number; count?: number; multi?: boolean } = {}) {
  const t = rig(opts.seed ?? 7);
  const pids = Array.from({ length: humans }, (_, i) => `pid-${i + 1}`);
  const socks = pids.map((p) => t.join(p));
  t.send(socks[0], { t: 'setMode', mode, playerCount: opts.count ?? 4 });
  t.send(socks[0], { t: 'setRules', rules: normalizeRules({ ...rules }, mode) });
  t.send(socks[0], { t: 'start' });
  const core = t.core;
  expect(core.data!.phase).toBe('playing');
  let x = (opts.seed ?? 7) * 31;
  const rnd = () => ((x = (x * 1103515245 + 12345) & 0x7fffffff), x / 0x7fffffff);
  const read = socks.map(() => 0);
  let moves = 0;
  let rounds = 0;
  for (let step = 0; step < 4000 && core.data!.phase === 'playing'; step++) {
    // invariant: a live match always has a timer pending (it can never stall)
    expect(core.nextAlarm()).not.toBeNull();
    socks.forEach((s, i) => {
      const seat = seatOfPid(core, pids[i])!;
      const m = core.data!.match!;
      const seen = visibleHands(m, seat);
      for (const msg of s.inbox.slice(read[i])) {
        const over = msg.t === 'events' && msg.events.some((e) => e.type === 'roundEnd');
        if (over) rounds++;
        checkNoLeak(msg, seat, seen, over);
      }
    });
    if (!opts.idle) {
      // one human acts on its latest turn message (some moves arrive late: too_late is fine)
      const i = Math.floor(rnd() * socks.length);
      const msgs = socks[i].inbox;
      read[i] = msgs.length;
      const last = [...msgs].reverse().find((m) => m.t === 'turn') as Extract<ServerMsg, { t: 'turn' }> | undefined;
      if (last && last.legal.length && rnd() < 0.7) {
        let mv: Move = last.legal[Math.floor(rnd() * last.legal.length)];
        // multiPlay: add every card that may join (checked against the room's match, as the server does)
        if (opts.multi && mv.kind === 'play') {
          const extra = multiPlayOptions(core.data!.match!, mv);
          if (extra.length) mv = { ...mv, extra };
        }
        t.send(socks[i], { t: 'move', move: mv });
        moves++;
      }
    }
    socks.forEach((s, i) => (read[i] = s.inbox.length));
    t.run(opts.idle ? 4000 : 400);
  }
  const kinds = new Set(socks.flatMap((s) => s.inbox.flatMap((m) => (m.t === 'events' ? m.events.map((e) => (e.type === 'window' && e.window ? `window:${e.window.reason}` : e.type)) : []))));
  return { core, socks, moves, rounds, kinds };
}

describe('room core: whole matches', () => {
  it('classic, 2 humans + 2 CPUs, one round, humans moving', () => {
    const r = playMatch('classic', { target: 0 }, 2);
    expect(r.core.data!.phase).toBe('finished');
    expect(r.moves).toBeGreaterThan(0);
  });

  it('all action with power cards, ¡Ku!, jump-in and the challenge on', () => {
    const kinds = new Set<string>();
    for (const seed of [3, 11, 19, 23]) {
      const r = playMatch('action', { target: 0, jumpIn: true, kuCall: true, wild4Challenge: true, sevenZero: true, stacking: 'any' }, 3, { seed });
      expect(r.core.data!.phase).toBe('finished');
      r.kinds.forEach((k) => kinds.add(k));
    }
    // the matches went through response windows and out-of-turn play
    console.log('event kinds seen:', [...kinds].sort().join(' '));
    expect(kinds.has('window:penalty') || kinds.has('window:ku')).toBe(true);
  });

  it('multiPlay and numberFinish: humans play same numbers together, CPUs too', () => {
    let multis = 0;
    for (const seed of [2, 13, 29]) {
      const r = playMatch('classic', { target: 0, multiPlay: true, numberFinish: true, kuCall: true }, 2, { seed, multi: true });
      expect(r.core.data!.phase).toBe('finished');
      expect(r.core.data!.match!.rules.multiPlay).toBe(true);
      multis += r.socks[0].inbox.filter((m) => m.t === 'events' && m.events.some((e) => e.type === 'play' && e.more)).length;
    }
    expect(multis).toBeGreaterThan(0);
  });

  it('multiDraw2 / multiReverse / multiSkip: humans and CPUs play several action cards of one kind', () => {
    let multis = 0;
    for (const seed of [4, 17, 31]) {
      const r = playMatch('action', { target: 0, multiDraw2: true, multiReverse: true, multiSkip: true, numberFinish: seed === 17, kuCall: true, stacking: 'any' }, 2, { seed, multi: true });
      expect(r.core.data!.phase).toBe('finished');
      multis += r.socks[0].inbox.filter((m) => m.t === 'events' && m.events.some((e) => e.type === 'play' && e.more && e.card.face.kind !== 'number')).length;
    }
    expect(multis).toBeGreaterThan(0);
  });

  it('cyclone (stacking, eliminations) with 3 players', () => {
    const r = playMatch('cyclone', {}, 2, { count: 3, seed: 5 });
    expect(r.core.data!.phase).toBe('finished');
  });

  it('nobody moves: the clock covers every human turn and the match still ends', () => {
    const r = playMatch('classic', { target: 0 }, 2, { idle: true });
    expect(r.core.data!.phase).toBe('finished');
    const covered = r.socks[0].inbox.filter((m) => m.t === 'covered');
    expect(covered.length).toBeGreaterThan(0);
  });
});

describe('room core: Parejas visibility', () => {
  for (const open of [true, false]) {
    it(`partnerOpen ${open}: the partner's hand ${open ? 'is' : 'is not'} in the snapshot`, () => {
      const t = rig(9);
      const a = t.join('pid-1');
      const b = t.join('pid-2');
      t.send(a, { t: 'setMode', mode: 'classic', playerCount: 4, teamPlay: true });
      t.send(a, { t: 'setRules', rules: normalizeRules({ partnerOpen: open }, 'classic') });
      t.send(a, { t: 'start' });
      const ev = a.inbox.find((m) => m.t === 'events') as Extract<ServerMsg, { t: 'events' }>;
      const deal = ev.events[0] as Extract<GameEvent, { type: 'deal' }>;
      const round = t.core.data!.match!.round!;
      expect(deal.hand!.map((c) => c.id)).toEqual(round.hands[0].map((c) => c.id));
      expect(ev.snap.hands.map((h) => h.seat).sort()).toEqual(open ? [0, 2] : [0]);
      const evB = b.inbox.find((m) => m.t === 'events') as Extract<ServerMsg, { t: 'events' }>;
      const dealB = evB.events[0] as Extract<GameEvent, { type: 'deal' }>;
      expect(dealB.hand!.map((c) => c.id)).toEqual(round.hands[1].map((c) => c.id));
    });
  }
});

describe('room core: side seating', () => {
  it('start keeps the avatar swap chosen in the lobby, without changing teams', () => {
    const t = rig(5);
    const a = t.join('pid-1');
    t.send(a, { t: 'setMode', mode: 'sideBySide', playerCount: 4 });
    t.send(a, { t: 'setSwappedSeats', swapped: true });
    t.send(a, { t: 'start' });
    expect(t.core.data!.match!.teams).toEqual([[0, 1], [2, 3]]);
    expect(t.core.data!.match!.setup?.swappedSeats).toBe(true);
    const room = t.socks[0].inbox.filter((m) => m.t === 'room').pop() as Extract<ServerMsg, { t: 'room' }>;
    expect(room.room.teams).toEqual([[0, 1], [2, 3]]);
    expect(room.room.swappedSeats).toBe(true);
  });
});

describe('room core: moves', () => {
  it('rejects a move for another seat and a late out-of-turn move', () => {
    const t = rig(4);
    const a = t.join('pid-1');
    t.join('pid-2');
    t.send(a, { t: 'start' });
    const round = t.core.data!.match!.round!;
    const other = ([0, 1, 2, 3] as Seat[]).find((s) => s !== 0)!;
    a.inbox.length = 0;
    t.send(a, { t: 'move', move: { kind: 'draw', seat: other } });
    expect(a.inbox.at(-1)).toMatchObject({ t: 'error', code: 'too_late' });
    t.send(a, { t: 'move', move: { kind: 'catchKu', seat: 0, target: other } });
    expect(a.inbox.at(-1)).toMatchObject({ t: 'error', code: 'too_late' });
    if (round.turn === 0) {
      t.send(a, { t: 'move', move: { kind: 'play', seat: 0, cardId: 9999 } });
      expect(a.inbox.at(-1)).toMatchObject({ t: 'error', code: 'bad_move' });
    }
  });

  it('a reconnecting player gets a redacted snapshot with their legal moves', () => {
    const t = rig(6);
    const a = t.join('pid-1');
    t.join('pid-2');
    t.send(a, { t: 'start' });
    t.run(500);
    a.open = false;
    t.core.socketGone(a);
    const a2 = t.join('pid-1');
    const w = a2.inbox.find((m) => m.t === 'welcome') as Extract<ServerMsg, { t: 'welcome' }>;
    expect(w.view).not.toBeNull();
    expect(w.view!.seat).toBe(0);
    const m = w.view!.match as { round: { hands: Card[][] } };
    expect(m.round.hands[0].length).toBe(w.view!.handCounts[0]);
    expect(m.round.hands[1]).toEqual([]);
    for (const mv of w.view!.legal) expect(mv.seat).toBe(0);
  });
});

describe('room core: round clock', () => {
  it('the host sets clocks (clamped); in the final minute moves get the short time; at zero the round ends by time', () => {
    const r = rig(4);
    const host = r.join('pid-1');
    r.send(host, { t: 'setRules', rules: { target: 0 } });
    r.send(host, { t: 'setClock', clock: { roundMin: 3, moveSec: 500, finalSec: 1 } });
    expect(r.core.data!.clock).toEqual({ roundMin: 3, moveSec: 60, finalSec: 4 });
    r.send(host, { t: 'start' });
    const ends = r.core.data!.roundEnds!;
    expect(ends).toBeGreaterThan(r.now);
    // nobody moves: every human turn waits its full move time until the final minute, then 4 s
    r.run(ends - r.now - 30_000);
    const turns = host.inbox.filter((m): m is Extract<typeof m, { t: 'turn' }> => m.t === 'turn' && m.deadline !== null);
    expect(turns.some((m) => m.moveMs === 60_000)).toBe(true);
    expect(turns.at(-1)!.roundEnds).toBe(ends);
    expect(r.core.data!.match!.round!.over).toBe(false);
    {
      expect(turns.at(-1)!.moveMs).toBe(4_000);
      r.run(40_000);
      const end = host.inbox.flatMap((m) => (m.t === 'events' ? m.events : [])).find((e) => e.type === 'roundEnd');
      expect(end).toMatchObject({ byTime: true });
      expect(r.core.data!.match!.round!.over).toBe(true);
    }
  });
});
