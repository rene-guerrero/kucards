import { describe, expect, it } from 'vitest';
import type { GameEvent, GameMode, Move, Seat } from '../contracts';
import { engine, giveOptions, RULE_PRESETS } from '../engine';
import { setupOf } from '../engine/testutil';
import { GameController, type GameHud, type GameUi, type GameView } from './controller';

/** a table + HUD that answer at once: the human plays its first playable card (or taps the deck) */
function harness(mode: GameMode, players: 2 | 3 | 4, seed: number, opts: { seating?: 'across' | 'side'; partnerSide?: 'after' | 'before'; tapKu?: boolean; partnerOpen?: boolean; clock?: { roundMin: number; moveSec: number; finalSec: number } } = {}) {
  const preset = RULE_PRESETS.find((p) => p.id === mode)!;
  const rules = { ...preset.rules, target: 200, jumpIn: true, sevenZero: !opts.seating && seed % 2 === 0, partnerPass: true, partnerShield: true, 'power.shield': true, 'power.mirror': true, 'power.swap': true, 'power.sweep': true, wild4Challenge: true, ...(opts.partnerOpen === false ? { partnerOpen: false } : {}) };
  const open: { seat: Seat; n: number | null; over: boolean }[] = [];
  // eslint-disable-next-line prefer-const
  let ctl: { match: { round?: { over?: boolean } | null } } | null = null;
  const match = engine.createMatch(rules, setupOf(mode, players, opts.seating, opts.partnerSide), seed);
  const events: GameEvent[] = [];
  let picks = 0;
  /** prompts that only offered the deck while a penalty was pending (should be auto-drawn instead) */
  let mustDrawPicks = 0;
  /** colour flow: preview:<id> → color → the play event */
  const flow: string[] = [];
  const view: GameView = {
    previewPlay: async (id) => {
      flow.push(`preview:${id}`);
    },
    handle: async (ev) => {
      events.push(ev);
      if (ev.type === 'play' && ev.seat === 0 && ev.card.face.color === null) flow.push(`play:${ev.card.id}`);
    },
    requestHumanPick: async (playable, canDraw) => {
      picks++;
      if (picks > 5000) throw new Error('runaway');
      if (playable.length) return playable[0];
      if ((ctl?.match.round as { pendingDraw?: number } | null | undefined)?.pendingDraw) mustDrawPicks++;
      return canDraw ? 'draw' : new Promise<never>(() => {});
    },
    cancelHumanPick: () => {},
    setOpenHand: (seat, cards) => {
      open.push({ seat, n: cards ? cards.length : null, over: !!ctl?.match.round?.over });
    },
    setTurn: () => {},
    reset: () => {},
    setQuality: () => {},
    setPaused: () => {},
    dispose: () => {},
  };
  let kuState = 'hidden';
  const music: string[] = [];
  const clocks: [number | null, boolean][] = [];
  const hud: GameHud = {
    onKu: null,
    setPlayers: () => {},
    setRound: () => {},
    setTarget: () => {},
    setScores: () => {},
    setPending: () => {},
    setKu: (s) => {
      kuState = s;
      if (opts.tapKu && s === 'armed') queueMicrotask(() => hud.onKu?.());
    },
    pickColor: async () => {
      flow.push('color');
      return 'mar';
    },
    pickTarget: async (seats) => seats[0],
    kuPop: async () => {},
    showResponse: async (o) => (o.canShield ? 'shield' : o.canMirror ? 'mirror' : 'accept'),
    notice: () => {},
    closeAll: () => {},
    setClock: (ms, urgent) => void clocks.push([ms, urgent]),
  };
  let summaries = 0;
  let ended = false;
  let exited = false;
  const ui: GameUi = {
    hud,
    say: () => {},
    bubbleFor: () => null,
    avatarEvent: () => {},
    musicMode: (m) => void music.push(m),
    roundSummary: async () => {
      summaries++;
      return 'next';
    },
    matchEnd: async () => {
      ended = true;
      return 'menu';
    },
    t: (k) => k,
  };
  const levels = ['easy', 'normal', 'hard'] as const;
  const c: GameController = new GameController(match, {
    engine,
    view,
    ui,
    lineup: {},
    players: match.seats.map((seat, i) => ({ seat: seat as Seat, name: `P${seat}`, face: { iris: '#000' }, level: seat === 0 ? undefined : levels[i % 3] })),
    giveOptions,
    onExit: () => {
      exited = true;
    },
    sleep: () => Promise.resolve(),
    random: () => 0.5,
    clock: opts.clock,
  });
  ctl = c as unknown as typeof ctl;
  return { c, events, open, flow, music, clocks, get summaries() { return summaries; }, get mustDrawPicks() { return mustDrawPicks; }, get ended() { return ended; }, get exited() { return exited; }, get kuState() { return kuState; } };
}

describe('GameController (offline loop)', () => {
  const setups: [GameMode, 2 | 3 | 4, ('across' | 'side')?][] = [
    ['classic', 2], ['classic', 3], ['classic', 4], ['action', 4], ['cyclone', 3], ['classic', 4, 'across'], ['sideBySide', 4, 'side'],
  ];
  for (const [mode, n, seating] of setups) {
    it(`plays a whole ${mode} match with ${n} players${seating ? ` (${seating})` : ''} to the end`, async () => {
      const h = harness(mode, n, 7 + n, { seating, tapKu: true });
      await h.c.run();
      expect(h.c.match.over).toBe(true);
      expect(h.ended).toBe(true);
      expect(h.exited).toBe(true);
      expect(h.summaries).toBeGreaterThan(0);
      expect(h.events.some((e) => e.type === 'roundEnd')).toBe(true);
    }, 20_000);
  }

  it('the human ¡Ku! tap calls ¡Ku! (no catch against seat 0)', async () => {
    const h = harness('classic', 2, 3, { tapKu: true });
    await h.c.run();
    expect(h.events.some((e) => e.type === 'kuCaught' && e.target === 0)).toBe(false);
  }, 20_000);

  it('shows the partner hand face up in Parejas by default', async () => {
    const across = harness('classic', 4, 11, { seating: 'across' });
    await across.c.run();
    expect(across.open.some((o) => o.seat === 2 && o.n !== null)).toBe(true);
    // during play only the partner is face up (at round end everyone's cards turn over)
    expect(across.open.filter((o) => !o.over && o.n !== null).every((o) => o.seat === 2)).toBe(true);
    expect(across.open.some((o) => o.over && o.seat !== 2 && o.n !== null)).toBe(true);
    const side = harness('sideBySide', 4, 12, { seating: 'side' });
    await side.c.run();
    expect(side.open.some((o) => o.seat === 1 && o.n !== null)).toBe(true);
    const before = harness('sideBySide', 4, 14, { seating: 'side', partnerSide: 'before' });
    await before.c.run();
    expect(before.open.some((o) => o.seat === 3 && o.n !== null)).toBe(true);
    expect(before.c.match.over).toBe(true);
  }, 20_000);

  it('keeps the partner hand hidden when partnerOpen is off', async () => {
    const h = harness('classic', 4, 13, { seating: 'across', partnerOpen: false });
    await h.c.run();
    expect(h.open.filter((o) => !o.over).every((o) => o.n === null)).toBe(true);
  }, 20_000);

  it('puts a human wild on the pile before asking its colour', async () => {
    const h = harness('classic', 2, 9, { tapKu: true });
    await h.c.run();
    const pre = h.flow.filter((f) => f.startsWith('preview:'));
    expect(pre.length).toBeGreaterThan(0);
    for (let i = 0; i < h.flow.length; i++) {
      if (!h.flow[i].startsWith('preview:')) continue;
      expect(h.flow[i + 1]).toBe('color');
      expect(h.flow[i + 2]).toBe(`play:${h.flow[i].slice(8)}`);
    }
  }, 20_000);

  it('draws an unanswerable penalty for the human without asking (auto-draw)', async () => {
    let auto = 0;
    for (const seed of [3, 4, 5]) {
      const h = harness('cyclone', 4, seed, { tapKu: true });
      await h.c.run();
      expect(h.mustDrawPicks).toBe(0);
      auto += h.events.filter((e) => e.type === 'draw' && e.seat === 0 && e.reason === 'penalty').length;
    }
    expect(auto).toBeGreaterThan(0);
  }, 30_000);

  it('ignores a move that is not legal', async () => {
    const h = harness('classic', 2, 5);
    const before = h.c.match;
    await h.c.act({ kind: 'pass', seat: 2 } as Move);
    expect(h.c.match).toBe(before);
  });

  it('round clock: final-minute move time, pause freezes it, time up ends the round by time', async () => {
    const h = harness('classic', 4, 21, { clock: { roundMin: 3, moveSec: 30, finalSec: 8 } });
    h.c.match = engine.startRound(h.c.match).match;
    const t0 = Date.now();
    h.c.startClock(61_000);
    expect(h.c.moveTime()).toBe(30_000);
    h.c.setPaused(true);
    h.c.tickClock(t0 + 5000);
    expect(h.c.roundLeft).toBe(61_000);
    h.c.setPaused(false);
    h.c.tickClock(t0 + 7000);
    expect(h.c.moveTime()).toBe(8_000);
    expect(h.music).toEqual(['frenzy']);
    expect(h.clocks.at(-1)).toEqual([59_000, true]);
    h.c.tickClock(t0 + 70_000);
    await h.c.act({ kind: 'pass', seat: 0 } as Move); // waits for the queued time-up
    expect(h.c.match.round!.endedBy).toBe('time');
    expect(h.events.some((e) => e.type === 'roundEnd' && e.byTime)).toBe(true);
    expect(h.open.filter((o) => o.n !== null).length).toBeGreaterThanOrEqual(3);
    expect(h.music.at(-1)).toBe('normal');
    h.c.stop();
  });
});
