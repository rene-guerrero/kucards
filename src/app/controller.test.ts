import { describe, expect, it } from 'vitest';
import type { GameEvent, GameMode, Move, Seat } from '../contracts';
import { engine, giveOptions, RULE_PRESETS } from '../engine';
import { GameController, type GameHud, type GameUi, type GameView } from './controller';

/** a table + HUD that answer at once: the human plays its first playable card (or taps the deck) */
function harness(mode: GameMode, players: 2 | 3 | 4, seed: number, opts: { seating?: 'across' | 'side'; partnerSide?: 'after' | 'before'; tapKu?: boolean; partnerOpen?: boolean } = {}) {
  const preset = RULE_PRESETS.find((p) => p.id === mode)!;
  const rules = { ...preset.rules, target: 200, jumpIn: true, sevenZero: mode !== 'partners' && seed % 2 === 0, partnerPass: true, partnerShield: true, 'power.shield': true, 'power.mirror': true, 'power.swap': true, 'power.sweep': true, wild4Challenge: true, ...(opts.partnerOpen === false ? { partnerOpen: false } : {}) };
  const open: { seat: Seat; n: number | null }[] = [];
  const match = engine.createMatch(rules, { mode, players, seating: opts.seating, partnerSide: opts.partnerSide }, seed);
  const events: GameEvent[] = [];
  let picks = 0;
  const view: GameView = {
    handle: async (ev) => {
      events.push(ev);
    },
    requestHumanPick: async (playable, canDraw) => {
      picks++;
      if (picks > 5000) throw new Error('runaway');
      if (playable.length) return playable[0];
      return canDraw ? 'draw' : new Promise<never>(() => {});
    },
    cancelHumanPick: () => {},
    setOpenHand: (seat, cards) => {
      open.push({ seat, n: cards ? cards.length : null });
    },
    setTurn: () => {},
    reset: () => {},
    setQuality: () => {},
    setPaused: () => {},
    dispose: () => {},
  };
  let kuState = 'hidden';
  const hud: GameHud = {
    onKu: null,
    setPlayers: () => {},
    setRound: () => {},
    setTarget: () => {},
    setScores: () => {},
    setActiveColor: () => {},
    setDirection: () => {},
    setPending: () => {},
    setKu: (s) => {
      kuState = s;
      if (opts.tapKu && s === 'armed') queueMicrotask(() => hud.onKu?.());
    },
    pickColor: async () => 'mar',
    pickTarget: async (seats) => seats[0],
    kuPop: async () => {},
    showResponse: async (o) => (o.canShield ? 'shield' : o.canMirror ? 'mirror' : 'accept'),
    notice: () => {},
    closeAll: () => {},
  };
  let summaries = 0;
  let ended = false;
  let exited = false;
  const ui: GameUi = {
    hud,
    say: () => {},
    bubbleFor: () => null,
    avatarEvent: () => {},
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
  const c = new GameController(match, {
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
  });
  return { c, events, open, get summaries() { return summaries; }, get ended() { return ended; }, get exited() { return exited; }, get kuState() { return kuState; } };
}

describe('GameController (offline loop)', () => {
  const setups: [GameMode, 2 | 3 | 4, ('across' | 'side')?][] = [
    ['classic', 2], ['classic', 3], ['classic', 4], ['action', 4], ['cyclone', 3], ['partners', 4, 'across'], ['partners', 4, 'side'],
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
    const across = harness('partners', 4, 11, { seating: 'across' });
    await across.c.run();
    expect(across.open.some((o) => o.seat === 2 && o.n !== null)).toBe(true);
    expect(across.open.every((o) => o.seat === 2)).toBe(true);
    const side = harness('partners', 4, 12, { seating: 'side' });
    await side.c.run();
    expect(side.open.some((o) => o.seat === 1 && o.n !== null)).toBe(true);
    const before = harness('partners', 4, 14, { seating: 'side', partnerSide: 'before' });
    await before.c.run();
    expect(before.open.some((o) => o.seat === 3 && o.n !== null)).toBe(true);
    expect(before.c.match.over).toBe(true);
  }, 20_000);

  it('keeps the partner hand hidden when partnerOpen is off', async () => {
    const h = harness('partners', 4, 13, { partnerOpen: false });
    await h.c.run();
    expect(h.open.every((o) => o.n === null)).toBe(true);
  }, 20_000);

  it('ignores a move that is not legal', async () => {
    const h = harness('classic', 2, 5);
    const before = h.c.match;
    await h.c.act({ kind: 'pass', seat: 2 } as Move);
    expect(h.c.match).toBe(before);
  });
});
