import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Difficulty, GameMode, MatchState, Move, PlayStyle, RuleSettings, Seat, Seating } from '../contracts';
import { applyMove, chooseMove, closeWindow, createMatch, isLegal, RULE_PRESETS, startRound } from '.';
import { MASTER_MS, type MasterOptions } from './ai';
import { isPenaltyCard } from './aiKnow';
import { HARD_W } from './aiPolicy';
import { legalMoves as legalMovesOf } from './game';
import { Rng } from './rng';
import { card, num, scenario, setupOf } from './testutil';

const cardOf = (mv: Move | null) => (mv && (mv.kind === 'play' || mv.kind === 'jumpIn' || mv.kind === 'respond') ? mv.cardId : null);
const preset = (id: GameMode, over: RuleSettings = {}): RuleSettings => ({ ...RULE_PRESETS.find((p) => p.id === id)!.rules, ...over });
/** opponents with ordinary hands (scenario seats are empty otherwise) */
const FULL = { 1: [1, 2, 3, 4, 5].map((v) => num('palma', v)), 2: [1, 2, 3, 4, 5].map((v) => num('coral', v)), 3: [1, 2, 3, 4, 5].map((v) => num('mar', v)) };
const POWER = { 'power.swap': true, 'power.shield': true, 'power.sweep': true, 'power.mirror': true };

// ───────────────────────── a tiny match driver ─────────────────────────

interface Drive {
  rules: RuleSettings;
  mode: GameMode;
  players: 2 | 3 | 4;
  seating?: Seating;
  levels: Partial<Record<Seat, Difficulty>>;
  styles?: Partial<Record<Seat, PlayStyle>>;
  seed: number;
  opts?: MasterOptions;
  /** called before every CPU decision is applied */
  check?: (m: MatchState, mv: Move) => void;
}

/** plays one round; returns the winning seat */
function playRound(d: Drive): Seat {
  let m: MatchState = startRound(createMatch({ ...d.rules, target: 0 }, setupOf(d.mode, d.players, d.seating), d.seed)).match;
  const rng = new Rng(d.seed * 31 + 7);
  const lv = (s: Seat) => d.levels[s] ?? 'normal';
  for (let i = 0; i < 4000; i++) {
    const r = m.round!;
    if (r.over) break;
    let acted = false;
    const start = rng.int(m.seats.length);
    for (let j = 0; j < m.seats.length && !acted; j++) {
      const s = m.seats[(start + j) % m.seats.length];
      if (s === r.turn) continue;
      const mv = chooseMove(m, s, lv(s), d.styles?.[s], d.opts);
      if (!mv) continue;
      d.check?.(m, mv);
      const out = applyMove(m, mv);
      m = out.match;
      for (const e of out.events) if (e.type === 'roundEnd') return e.winner;
      acted = true;
    }
    if (acted) continue;
    if (m.round!.window && rng.next() < 0.5) {
      const out = closeWindow(m);
      m = out.match;
      for (const e of out.events) if (e.type === 'roundEnd') return e.winner;
      continue;
    }
    const t = m.round!.turn;
    const mv = chooseMove(m, t, lv(t), d.styles?.[t], d.opts);
    expect(mv).not.toBeNull();
    d.check?.(m, mv!);
    const out = applyMove(m, mv!);
    m = out.match;
    for (const e of out.events) if (e.type === 'roundEnd') return e.winner;
  }
  throw new Error(`round did not finish (seed ${d.seed})`);
}

const legalCheck = (m: MatchState, mv: Move) => {
  if (!isLegal(m, mv)) throw new Error(`illegal CPU move ${JSON.stringify(mv)}`);
};

/**
 * The scenario tests below check hard's policy itself: switch its small random slips off (HARD_W.slip*,
 * forgetKu) for them. Normal keeps its slips; its tests compare over many seeds where it matters.
 */
function withoutHardSlips(): void {
  const saved = { slipNoise: HARD_W.slipNoise, slipColor: HARD_W.slipColor, forgetKu: HARD_W.forgetKu };
  beforeAll(() => Object.assign(HARD_W, { slipNoise: 0, slipColor: 0, forgetKu: 0 }));
  afterAll(() => Object.assign(HARD_W, saved));
}

// ───────────────────────── basics (phase 2) ─────────────────────────

describe('cpu basics', () => {
  it('is deterministic and legal', () => {
    const { match } = startRound(createMatch(RULE_PRESETS[0].rules, { mode: 'classic', players: 4 }, 99));
    for (const level of ['easy', 'normal', 'hard', 'master'] as const) {
      const opts = { timeMs: 1e9 };
      const a = chooseMove(match, match.round!.turn, level, undefined, opts);
      expect(a).toEqual(chooseMove(match, match.round!.turn, level, undefined, opts));
      expect(isLegal(match, a!)).toBe(true);
    }
  });

  it('returns null off turn when there is nothing to do', () => {
    const { match } = startRound(createMatch(RULE_PRESETS[0].rules, { mode: 'classic', players: 4 }, 5));
    const off = match.seats.find((s) => s !== match.round!.turn)!;
    for (const level of ['easy', 'normal', 'hard', 'master'] as const) expect(chooseMove(match, off, level)).toBeNull();
  });
});

describe('normal heuristics', () => {
  withoutHardSlips();
  it('dumps the high number and keeps the wild', () => {
    const hi = num('sol', 9);
    const m = scenario({ rules: { target: 500 }, hands: { 0: [num('sol', 1), hi, card('wild'), num('mar', 3)] }, top: num('sol', 5) });
    expect(cardOf(chooseMove(m, 0, 'normal'))).toBe(hi.id);
  });

  it('plays a wild when it is the only option, choosing the colour it holds most', () => {
    const w = card('wild');
    const m = scenario({ hands: { 0: [w, num('mar', 1), num('mar', 2), num('coral', 3)] }, top: num('sol', 5) });
    expect(chooseMove(m, 0, 'hard')).toMatchObject({ kind: 'play', cardId: w.id, color: 'mar' });
    // normal picks its colour roughly (NORMAL_W.colorNoise): mostly the one it holds most
    let mar = 0;
    for (let seed = 0; seed < 100; seed++) {
      const mv = chooseMove({ ...m, rng: seed }, 0, 'normal');
      expect(mv).toMatchObject({ kind: 'play', cardId: w.id });
      if (mv?.kind === 'play' && mv.color === 'mar') mar++;
    }
    expect(mar).toBeGreaterThan(40);
  });

  it('hits a short-handed next opponent with a +2', () => {
    const d2 = card('draw2', 'sol');
    const m = scenario({ hands: { 0: [num('sol', 9), d2, num('mar', 3)], 1: [num('mar', 1)] }, top: num('sol', 5) });
    for (const lv of ['normal', 'hard'] as const) expect(cardOf(chooseMove(m, 0, lv))).toBe(d2.id);
  });

  it('shouts ¡Ku! with its second-to-last card', () => {
    const m = scenario({ hands: { ...FULL, 0: [num('sol', 9), num('mar', 3)] }, top: num('sol', 5) });
    for (const lv of ['hard', 'master'] as const) expect(chooseMove(m, 0, lv)).toMatchObject({ kind: 'play', ku: true });
    // normal forgets now and then (NORMAL_W.forgetKu), but mostly shouts
    let shouted = 0;
    for (let seed = 0; seed < 100; seed++) if ((chooseMove({ ...m, rng: seed }, 0, 'normal') as { ku?: boolean } | null)?.ku) shouted++;
    expect(shouted).toBeGreaterThan(40);
    expect(shouted).toBeLessThan(100);
  });

  it('catches a missed ¡Ku! and the offender calls it when asked', () => {
    const a = num('sol', 1);
    const m = scenario({ hands: { 0: [a, num('mar', 9)], 1: [num('coral', 3), num('coral', 4)] }, top: num('sol', 5) });
    const w = applyMove(m, { kind: 'play', seat: 0, cardId: a.id }).match;
    for (const lv of ['hard', 'master'] as const) {
      expect(chooseMove(w, 2, lv)).toEqual({ kind: 'catchKu', seat: 2, target: 0 });
      expect(chooseMove(w, 1, lv)).toEqual({ kind: 'catchKu', seat: 1, target: 0 });
      expect(chooseMove(w, 0, lv)).toEqual({ kind: 'callKu', seat: 0 });
    }
    // normal catches most slips and sometimes calls in time, but not always (NORMAL_W)
    let caught = 0;
    let called = 0;
    for (let seed = 0; seed < 200; seed++) {
      const ws = { ...w, rng: seed };
      if (chooseMove(ws, 1, 'normal')?.kind === 'catchKu') caught++;
      if (chooseMove(ws, 0, 'normal')?.kind === 'callKu') called++;
    }
    expect(caught).toBeGreaterThan(120);
    expect(caught).toBeLessThan(200);
    expect(called).toBeGreaterThan(20);
    expect(called).toBeLessThan(120);
  });

  it('jumps in when it can, calling ¡Ku! first on its second-to-last card', () => {
    const twin = num('sol', 5);
    const m = scenario({ rules: { jumpIn: true }, hands: { 2: [twin, num('mar', 1), num('mar', 2)] }, top: num('sol', 5) });
    expect(chooseMove(m, 2, 'normal')).toEqual({ kind: 'jumpIn', seat: 2, cardId: twin.id });
    const m2 = scenario({ rules: { jumpIn: true }, hands: { 2: [twin, num('mar', 1)] }, top: num('sol', 5) });
    expect(chooseMove(m2, 2, 'normal')).toEqual({ kind: 'callKu', seat: 2 });
  });

  it('swaps with the opponent holding the fewest cards on a 7', () => {
    const seven = num('sol', 7);
    const m = scenario({ rules: { sevenZero: true }, hands: { 0: [seven, num('mar', 1), num('mar', 2), num('mar', 3)], 1: [num('coral', 1), num('coral', 2), num('coral', 3)], 2: [num('coral', 4)], 3: [num('coral', 5), num('coral', 6)] }, top: num('sol', 5) });
    expect(chooseMove(m, 0, 'normal')).toMatchObject({ kind: 'play', cardId: seven.id, target: 2 });
  });
});

// ───────────────────────── power cards, Cyclone, challenge ─────────────────────────

describe('power cards', () => {
  withoutHardSlips();
  it('swap targets the opponent with the fewest cards', () => {
    const sw = card('swap');
    const m = scenario({ rules: POWER, hands: { 0: [sw, num('mar', 1), num('mar', 2), num('coral', 3), num('coral', 4)], 1: [num('mar', 5), num('mar', 6), num('mar', 7)], 2: [num('mar', 8)], 3: [num('sol', 1), num('sol', 2)] }, top: num('palma', 5) });
    for (const lv of ['normal', 'hard'] as const) expect(chooseMove(m, 0, lv)).toMatchObject({ kind: 'play', cardId: sw.id, target: 2 });
  });

  it('sweeps when it dumps at least two more cards, not for one', () => {
    const sw = card('sweep', 'sol');
    const m = scenario({ rules: POWER, hands: { 0: [sw, num('sol', 2), num('sol', 3), num('mar', 4), num('coral', 4)] }, top: num('sol', 5) });
    expect(cardOf(chooseMove(m, 0, 'normal'))).toBe(sw.id);
    const sw2 = card('sweep', 'sol');
    const nine = num('sol', 9);
    const m2 = scenario({ rules: POWER, hands: { 0: [sw2, nine, num('mar', 4), num('coral', 4)] }, top: num('sol', 5) });
    expect(cardOf(chooseMove(m2, 0, 'normal'))).toBe(nine.id);
  });

  it('a hit seat mirrors an opponent’s penalty back, and shields when it has no mirror', () => {
    const d2 = card('draw2', 'sol');
    for (const lv of ['normal', 'hard', 'master'] as const) {
      const mir = card('mirror', 'mar');
      const sh = card('shield', 'coral');
      const m = scenario({ rules: POWER, hands: { 0: [d2, num('sol', 2), num('mar', 3)], 1: [mir, sh, num('palma', 1)] }, top: num('sol', 5) });
      const w = applyMove(m, { kind: 'play', seat: 0, cardId: d2.id }).match;
      expect(w.round!.window?.reason).toBe('penalty');
      expect(chooseMove(w, 1, lv)).toEqual({ kind: 'respond', seat: 1, cardId: mir.id });
      const sh2 = card('shield', 'coral');
      const d2b = card('draw2', 'sol');
      const m2 = scenario({ rules: POWER, hands: { 0: [d2b, num('sol', 2), num('mar', 3)], 1: [sh2, num('palma', 1), num('palma', 2)] }, top: num('sol', 5) });
      const w2 = applyMove(m2, { kind: 'play', seat: 0, cardId: d2b.id }).match;
      expect(chooseMove(w2, 1, lv)).toEqual({ kind: 'respond', seat: 1, cardId: sh2.id });
    }
  });

  it('never mirrors onto its partner (shields instead, or takes it)', () => {
    for (const lv of ['normal', 'hard'] as const) {
      const d2 = card('draw2', 'sol');
      const mir = card('mirror', 'mar');
      const sh = card('shield', 'coral');
      const m = scenario({ seating: 'side', rules: POWER, hands: { 0: [d2, num('sol', 2), num('mar', 3)], 1: [mir, sh, num('palma', 1)], 2: [num('mar', 1)], 3: [num('mar', 2)] }, top: num('sol', 5) });
      const w = applyMove(m, { kind: 'play', seat: 0, cardId: d2.id }).match;
      expect(chooseMove(w, 1, lv)).toEqual({ kind: 'respond', seat: 1, cardId: sh.id });
      const d2b = card('draw2', 'sol');
      const mir2 = card('mirror', 'mar');
      const m2 = scenario({ seating: 'side', rules: POWER, hands: { 0: [d2b, num('sol', 2), num('mar', 3)], 1: [mir2, num('palma', 1)], 2: [num('mar', 1)], 3: [num('mar', 2)] }, top: num('sol', 5) });
      const w2 = applyMove(m2, { kind: 'play', seat: 0, cardId: d2b.id }).match;
      expect(chooseMove(w2, 1, lv)).toEqual({ kind: 'acceptPenalty', seat: 1 });
    }
  });

  it('hard keeps shields and mirrors for defence instead of playing them as plain cards', () => {
    const sh = card('shield', 'sol');
    const m = scenario({ rules: POWER, hands: { 0: [sh, num('sol', 2), num('mar', 3), num('coral', 4), num('palma', 4)], ...FULL }, top: num('sol', 5) });
    expect(cardOf(chooseMove(m, 0, 'hard'))).not.toBe(sh.id);
  });

  it('challenges a +4 only when it was likely illegal', () => {
    const rules = { wild4Challenge: true };
    // a big hand that played +4: it very likely held the old colour
    const w4 = card('wild4');
    const big = [w4, ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((v) => num(v % 2 ? 'mar' : 'coral', v))];
    const m = scenario({ players: 2, rules, hands: { 0: big, 2: [num('palma', 1), num('palma', 2), num('palma', 3)] }, top: num('sol', 5), deck: [...[1, 2, 3, 4, 5, 6].map((v) => num('sol', v)), ...[1, 2, 3, 4, 5, 6].map((v) => num('mar', v))] });
    const w = applyMove(m, { kind: 'play', seat: 0, cardId: w4.id, color: 'coral' }).match;
    expect(w.round!.pendingDraw).toBe(4);
    expect(chooseMove(w, 2, 'hard')).toEqual({ kind: 'challenge', seat: 2 });
    // a +4 as the second-to-last card: one card left, probably legal
    const w4b = card('wild4');
    const m2 = scenario({ players: 2, rules, hands: { 0: [w4b, num('mar', 3)], 2: [num('palma', 1), num('palma', 2), num('palma', 3)] }, top: num('sol', 5) });
    const w2 = applyMove(m2, { kind: 'play', seat: 0, cardId: w4b.id, color: 'coral', ku: true }).match;
    for (const lv of ['normal', 'hard'] as const) expect(chooseMove(w2, 2, lv)).toEqual({ kind: 'acceptPenalty', seat: 2 });
  });

  it('Cyclone: skipAll is a free card, +6 hits a short opponent', () => {
    const sa = card('skipAll', 'sol');
    const m = scenario({ rules: preset('cyclone'), hands: { 0: [sa, num('sol', 9), num('mar', 3), num('mar', 4)] }, top: num('sol', 5) });
    for (const lv of ['normal', 'hard'] as const) expect(cardOf(chooseMove(m, 0, lv))).toBe(sa.id);
    const d6 = card('draw6', 'sol');
    const m2 = scenario({ rules: preset('cyclone'), hands: { 0: [d6, num('sol', 9), num('mar', 3)], 1: [num('mar', 1)] }, top: num('sol', 5) });
    for (const lv of ['normal', 'hard'] as const) expect(cardOf(chooseMove(m2, 0, lv))).toBe(d6.id);
  });
});

// ───────────────────────── hard ─────────────────────────

describe('hard', () => {
  withoutHardSlips();
  it('turns the colour to what the next opponent could not follow', () => {
    // seat 2 (2 players) could not follow sol: it drew and passed
    const w = card('wild');
    const top = num('sol', 5);
    const before = scenario({ players: 2, hands: { 0: [w, num('mar', 1), num('coral', 2), num('palma', 3)], 2: [num('mar', 6), num('coral', 7), num('palma', 8)] }, top, turn: 2, deck: [num('mar', 9)] });
    chooseMove(before, 0, 'hard'); // a CPU looks at the table
    const after = applyMove(before, { kind: 'draw', seat: 2 }).match;
    expect(after.round!.turn).toBe(0);
    const mv = chooseMove(after, 0, 'hard');
    expect(mv).toMatchObject({ kind: 'play', cardId: w.id, color: 'sol' });
  });

  it('partners (open hands): sets up the partner’s last card', () => {
    // a direct set-up: partner next (side seating) with one palma card, seat 0 holds a wild
    const w2 = card('wild');
    const m2 = scenario({ seating: 'side', hands: { 0: [w2, num('mar', 1), num('mar', 2)], 1: [num('palma', 4)], 2: [num('sol', 1), num('sol', 2)], 3: [num('sol', 3), num('sol', 4)] }, top: num('coral', 5) });
    expect(chooseMove(m2, 0, 'hard')).toMatchObject({ kind: 'play', cardId: w2.id, color: 'palma' });
    // closed hands: no such knowledge (normal colour choice: its own colour)
    const m3 = { ...m2, rules: { ...m2.rules, partnerOpen: false } };
    expect(chooseMove(m3, 0, 'hard')).toMatchObject({ kind: 'play', cardId: w2.id, color: 'mar' });
  });

  it('partnerPass: hands a card to the partner on a 7 when it is the one closer to going out', () => {
    const seven = num('sol', 7);
    const m = scenario({ seating: 'across', rules: { partnerPass: true }, hands: { 0: [seven, num('mar', 1), num('coral', 8)], 1: [num('sol', 1), num('sol', 2), num('sol', 3)], 2: [num('palma', 1), num('palma', 2), num('mar', 3), num('mar', 4), num('mar', 5), num('palma', 6)], 3: [num('sol', 4), num('sol', 6), num('sol', 8)] }, top: num('sol', 5) });
    const mv = chooseMove(m, 0, 'hard')!;
    expect(mv).toMatchObject({ kind: 'play', cardId: seven.id });
    expect((mv as { give?: number }).give).toBeDefined();
    expect(isLegal(m, mv)).toBe(true);
  });
});

// ───────────────────────── styles ─────────────────────────

describe('styles', () => {
  withoutHardSlips();
  it('aggressive throws a +2 where steady play keeps its long colour going', () => {
    const d2 = card('draw2', 'mar');
    const sols = [9, 8, 7, 6, 5, 4, 3, 2].map((v) => num('sol', v));
    const m = scenario({ hands: { 0: [d2, ...sols], 1: [1, 2, 3, 4, 5, 6, 7].map((v) => num('mar', v)) }, top: card('draw2', 'sol') });
    // normal slips now and then (NORMAL_W.noise): compare the styles over many seeds
    let steady = 0;
    let aggressive = 0;
    for (let seed = 0; seed < 100; seed++) {
      const ms = { ...m, rng: seed };
      if (sols.some((s) => s.id === cardOf(chooseMove(ms, 0, 'normal')))) steady++;
      if (cardOf(chooseMove(ms, 0, 'normal', 'aggressive')) === d2.id) aggressive++;
    }
    expect(steady).toBeGreaterThan(60);
    expect(aggressive).toBeGreaterThan(60);
  });

  it('byTheBook plays numbers before actions', () => {
    const sk = card('skip', 'sol');
    const four = num('sol', 9);
    const m = scenario({ hands: { 0: [sk, four, num('mar', 3), num('coral', 2)], ...FULL }, top: num('sol', 5) });
    expect(cardOf(chooseMove(m, 0, 'normal'))).toBe(sk.id);
    expect(cardOf(chooseMove(m, 0, 'normal', 'byTheBook'))).toBe(four.id);
  });

  it('hoarder keeps its wild and draws rather than spend it early', () => {
    const w = card('wild');
    const m = scenario({ hands: { 0: [w, num('mar', 1), num('mar', 2), num('coral', 3), num('coral', 4), num('palma', 4)] }, top: num('sol', 5) });
    expect(cardOf(chooseMove(m, 0, 'normal'))).toBe(w.id);
    // hoarder: still plays it when the hand is nearly empty
    const m2 = scenario({ hands: { 0: [w, num('mar', 1)] }, top: num('sol', 5) });
    expect(cardOf(chooseMove(m2, 0, 'normal', 'hoarder'))).toBe(w.id);
    const hoard = (mv: Move | null) => mv?.kind === 'draw' || cardOf(mv) !== w.id;
    // with a big hand the hoarder's wild costs more, so a plain number wins over it where both exist
    const m3 = scenario({ hands: { 0: [w, num('sol', 0), num('mar', 2), num('coral', 3), num('coral', 4), num('palma', 4)] }, top: num('sol', 5) });
    expect(hoard(chooseMove(m3, 0, 'hard', 'hoarder'))).toBe(true);
  });

  it('nobody calls ¡Ku! off turn without a play; easy chatty catches everyone', () => {
    const m = scenario({ hands: { 0: [num('sol', 1), num('mar', 2)], 1: [num('sol', 3), num('mar', 4)] }, top: num('sol', 5) });
    expect(chooseMove(m, 1, 'normal')).toBeNull();
    // ¡Ku! is only legal when it matters (your turn / a jump-in with two cards, or the catch window)
    expect(chooseMove(m, 1, 'normal', 'chatty')).toBeNull();
    const a = num('sol', 1);
    const m2 = scenario({ hands: { 0: [a, num('mar', 9)], 1: [num('coral', 3), num('coral', 4), num('coral', 5)] }, top: num('sol', 5) });
    const w = applyMove(m2, { kind: 'play', seat: 0, cardId: a.id }).match;
    for (let seed = 0; seed < 20; seed++) expect(chooseMove({ ...w, rng: seed }, 1, 'easy', 'chatty')).toMatchObject({ kind: 'catchKu' });
  });

  it('carefree plays the first card that fits; impulsive the highest number', () => {
    const first = num('sol', 1);
    const hi = num('sol', 9);
    const m = scenario({ hands: { 0: [first, num('sol', 4), hi, num('mar', 2)] }, top: num('sol', 5) });
    let carefree = 0;
    let impulsive = 0;
    for (let seed = 0; seed < 40; seed++) {
      const x = { ...m, rng: seed };
      if (cardOf(chooseMove(x, 0, 'easy', 'carefree')) === first.id) carefree++;
      if (cardOf(chooseMove(x, 0, 'easy', 'impulsive')) === hi.id) impulsive++;
    }
    expect(carefree).toBeGreaterThan(30);
    expect(impulsive).toBeGreaterThan(30);
  });
});

// ───────────────────────── partners ─────────────────────────

describe('partners', () => {
  withoutHardSlips();
  for (const lv of ['normal', 'hard'] as const) {
    it(`${lv}, side seating: never +2 the partner sitting next when a number will do`, () => {
      const d2 = card('draw2', 'sol');
      const n = num('sol', 2);
      const m = scenario({ seating: 'side', hands: { 0: [d2, n, num('mar', 3)], 1: [num('coral', 1)], 2: [num('coral', 2)], 3: [num('coral', 3)] }, top: num('sol', 5) });
      expect(m.teams).toEqual([[0, 1], [2, 3]]);
      expect(cardOf(chooseMove(m, 0, lv))).toBe(n.id);
    });

    it(`${lv}, side seating: draws instead of skipping or penalising the partner`, () => {
      for (const k of ['draw2', 'skip'] as const) {
        const c = card(k, 'sol');
        const m = scenario({ seating: 'side', hands: { 0: [c, num('mar', 3), num('mar', 4)], 1: [num('coral', 1), num('coral', 2)] }, top: num('sol', 5) });
        expect(chooseMove(m, 0, lv)).toEqual({ kind: 'draw', seat: 0 });
      }
    });

    it(`${lv}, side seating: uses reverse to turn play away from the partner when it holds a penalty`, () => {
      const rv = card('reverse', 'sol');
      const m = scenario({ seating: 'side', hands: { 0: [rv, num('sol', 9), card('draw2', 'mar')], 1: [num('coral', 1), num('coral', 2)], 3: [num('coral', 3), num('coral', 4)] }, top: num('sol', 5) });
      expect(cardOf(chooseMove(m, 0, lv))).toBe(rv.id);
    });

    it(`${lv}: stacking is mandatory, even onto its partner`, () => {
      const d2 = card('draw2', 'mar');
      const m = scenario({ seating: 'side', rules: { stacking: 'same' }, hands: { 0: [d2, num('mar', 3)], 1: [num('coral', 1)] }, top: card('draw2', 'sol'), pendingDraw: 2 });
      expect(cardOf(chooseMove(m, 0, lv))).toBe(d2.id);
      const m2 = scenario({ seating: 'across', rules: { stacking: 'same' }, hands: { 0: [d2, num('mar', 3)], 1: [num('coral', 1)] }, top: card('draw2', 'sol'), pendingDraw: 2 });
      expect(cardOf(chooseMove(m2, 0, lv))).toBe(d2.id);
    });
  }

  it('across seating: happily penalises the next seat (an opponent)', () => {
    const d2 = card('draw2', 'sol');
    const m = scenario({ seating: 'across', hands: { 0: [d2, num('sol', 2), num('mar', 3)], 1: [num('coral', 1)] }, top: num('sol', 5) });
    expect(cardOf(chooseMove(m, 0, 'normal'))).toBe(d2.id);
  });

  it('side seating fuzz: a CPU never plays a penalty on its partner when it has any alternative', () => {
    let checked = 0;
    const check = (m: MatchState, mv: Move) => {
      legalCheck(m, mv);
      const r = m.round!;
      if (mv.kind === 'respond') {
        const c = r.hands[mv.seat].find((x) => x.id === mv.cardId)!;
        if (c.face.kind === 'mirror' && r.pendingFrom !== null && m.teams!.some((t) => t.includes(mv.seat) && t.includes(r.pendingFrom!))) throw new Error('mirrored onto the partner');
        return;
      }
      if (mv.kind !== 'play') return;
      const hand = r.hands[mv.seat];
      if (hand.length === 1) return; // going out wins the round for the team anyway
      const c = hand.find((x) => x.id === mv.cardId)!;
      if (!isPenaltyCard(c) && c.face.kind !== 'skip') return;
      const next = m.seats[(m.seats.indexOf(mv.seat) + r.direction + 4) % 4];
      if (r.eliminated[next] || m.teams!.every((t) => !(t.includes(mv.seat) && t.includes(next)))) return;
      checked++;
      const alternatives = legalMovesOf(m, mv.seat).filter((x) => x.kind !== 'callKu' && !(x.kind === 'play' && (x.cardId === mv.cardId || r.pendingDraw > 0))); // every stack hits the next seat
      if (alternatives.length) throw new Error(`penalised the partner with ${c.face.kind} (alternatives: ${alternatives.length})`);
    };
    for (let seed = 1; seed <= 40; seed++) {
      const rules = preset('sideBySide', { ...POWER, stacking: seed % 3 ? 'off' : 'any', partnerPass: seed % 2 === 0, jumpIn: seed % 4 === 0 });
      playRound({ rules, mode: 'sideBySide', players: 4, seating: 'side', levels: { 0: 'normal', 1: 'hard', 2: 'hard', 3: 'normal' }, styles: { 1: 'teamPlayer', 3: 'aggressive' }, seed, check });
    }
    expect(checked).toBeGreaterThanOrEqual(0); // forced hits only (the check throws on any unforced one)
  });
});


// ───────────────────────── legality fuzz ─────────────────────────

describe('legality fuzz (all levels, presets, power cards, Cyclone, challenge)', () => {
  const configs: { name: string; mode: GameMode; players: 2 | 3 | 4; seating?: Seating; rules: RuleSettings }[] = [
    { name: 'classic 2p', mode: 'classic', players: 2, rules: preset('classic', { jumpIn: true, sevenZero: true }) },
    { name: 'classic 3p', mode: 'classic', players: 3, rules: preset('classic', { wild4Challenge: true, stacking: 'same' }) },
    { name: 'action 4p (all power cards)', mode: 'action', players: 4, rules: preset('action', { wild4Challenge: true, jumpIn: true }) },
    { name: 'action 2p', mode: 'action', players: 2, rules: preset('action', { sevenZero: true }) },
    { name: 'cyclone 4p', mode: 'cyclone', players: 4, rules: preset('cyclone', { ...POWER, deck: 'cyclone', wild4Challenge: true }) },
    { name: 'cyclone 3p', mode: 'cyclone', players: 3, rules: preset('cyclone', { deck: 'cyclone', kuCall: true }) },
    { name: 'partners across', mode: 'classic', players: 4, seating: 'across', rules: preset('classic', { ...POWER, partnerPass: true, partnerShield: true }) },
    { name: 'partners side closed', mode: 'sideBySide', players: 4, seating: 'side', rules: preset('sideBySide', { partnerOpen: false, stacking: 'any', wild4Challenge: true }) },
  ];
  const LEVELS: Difficulty[] = ['easy', 'normal', 'hard'];
  const STYLES: (PlayStyle | undefined)[] = [undefined, 'carefree', 'impulsive', 'beginner', 'balanced', 'byTheBook', 'chatty', 'aggressive', 'hoarder', 'teamPlayer', 'perfect'];
  for (const cfg of configs) {
    it(cfg.name, () => {
      for (let seed = 1; seed <= 25; seed++) {
        const rng = new Rng(seed * 977);
        const levels: Partial<Record<Seat, Difficulty>> = {};
        const styles: Partial<Record<Seat, PlayStyle>> = {};
        for (const s of [0, 1, 2, 3] as Seat[]) {
          levels[s] = LEVELS[rng.int(LEVELS.length)];
          styles[s] = STYLES[rng.int(STYLES.length)];
        }
        playRound({ ...cfg, levels, styles, seed, check: legalCheck });
      }
    }, 30_000);
  }

  it('master plays legal moves too (short budget)', () => {
    for (const [i, cfg] of configs.entries()) {
      playRound({ ...cfg, levels: { 0: 'master', 1: 'hard', 2: 'master', 3: 'normal' }, seed: 500 + i, opts: { maxPlayouts: 24, timeMs: 1e9 }, check: legalCheck });
    }
  }, 30_000);
});

// ───────────────────────── strength ─────────────────────────

/** paired deals: the same seed twice with the seats swapped (duplicate format, less luck) */
function duel(a: Difficulty, b: Difficulty, rules: RuleSettings, mode: GameMode, deals: number, opts?: MasterOptions, from = 1): number {
  let wins = 0;
  for (let seed = from; seed < from + deals; seed++) {
    if (playRound({ rules, mode, players: 2, levels: { 0: a, 2: b }, seed, opts }) === 0) wins++;
    if (playRound({ rules, mode, players: 2, levels: { 0: b, 2: a }, seed, opts }) === 2) wins++;
  }
  return wins / (2 * deals);
}

describe('strength (2 players, one-round matches, paired deals)', () => {
  it('normal beats easy by far', () => {
    expect(duel('normal', 'easy', preset('classic'), 'classic', 200)).toBeGreaterThan(0.7);
  }, 30_000);

  it('hard beats normal (classic and all-action decks)', () => {
    const classic = duel('hard', 'normal', preset('classic'), 'classic', 1000);
    const action = duel('hard', 'normal', preset('action'), 'action', 1000);
    console.log(`hard vs normal: classic ${(100 * classic).toFixed(1)}%, action ${(100 * action).toFixed(1)}%`);
    expect(classic).toBeGreaterThan(0.52);
    expect(action).toBeGreaterThan(0.52);
  }, 40_000);

  it('master is at least as strong as hard (small sample, reduced budget)', () => {
    // The edge is small (~54% in the 4-player benchmark, PLAN.md §5), so a test-sized sample
    // only guards against master being clearly weaker; see the report for the long runs.
    const rate = duel('master', 'hard', preset('classic'), 'classic', 80, { maxPlayouts: 60, timeMs: 1e9 }, 101);
    console.log(`master vs hard: ${(100 * rate).toFixed(1)}%`);
    expect(rate).toBeGreaterThanOrEqual(0.45);
  }, 40_000);
});

// ───────────────────────── speed ─────────────────────────

describe('speed', () => {
  /** decision states from CPU games (incl. Cyclone with big hands) */
  function states(): MatchState[] {
    const out: MatchState[] = [];
    const cfgs: [GameMode, RuleSettings, 2 | 3 | 4][] = [
      ['action', preset('action', { jumpIn: true, sevenZero: true }), 4],
      ['cyclone', preset('cyclone', { ...POWER, deck: 'cyclone' }), 4],
      ['sideBySide', preset('sideBySide', { partnerPass: true }), 4],
    ];
    for (const [mode, rules, players] of cfgs) {
      let m: MatchState = startRound(createMatch({ ...rules, target: 0 }, { mode, players }, 3)).match;
      for (let i = 0; i < 120 && !m.round!.over; i++) {
        out.push(m);
        const mv = chooseMove(m, m.round!.turn, 'normal');
        if (!mv) m = closeWindow(m).match;
        else m = applyMove(m, mv).match;
      }
    }
    return out;
  }

  it('easy / normal / hard decide in < 5 ms', () => {
    const ss = states();
    for (const lv of ['easy', 'normal', 'hard'] as const) {
      const t0 = performance.now();
      for (const m of ss) chooseMove(m, m.round!.turn, lv);
      const per = (performance.now() - t0) / ss.length;
      expect(per).toBeLessThan(5);
    }
  });

  it(`master stays within MASTER_MS (${MASTER_MS} ms)`, () => {
    const ss = states().filter((_, i) => i % 12 === 0);
    const ts: number[] = [];
    for (const m of ss) {
      const t0 = performance.now();
      chooseMove(m, m.round!.turn, 'master');
      ts.push(performance.now() - t0);
    }
    ts.sort((a, b) => a - b);
    expect(ts[Math.floor(ts.length / 2)]).toBeLessThanOrEqual(MASTER_MS);
    // the clock is checked between playouts: allow a little slack (GC, a busy test machine)
    expect(ts[Math.floor(ts.length * 0.9)]).toBeLessThanOrEqual(MASTER_MS * 1.15);
  }, 20_000);
});

describe('easy', () => {
  it('forgets ¡Ku! some of the time', () => {
    let forgot = 0;
    let called = 0;
    for (let seed = 0; seed < 300; seed++) {
      const m = scenario({ hands: { 0: [num('sol', 9), num('sol', 3)] }, top: num('sol', 5) });
      const mv = chooseMove({ ...m, rng: seed }, 0, 'easy')!;
      if (mv.kind !== 'play') continue;
      if (mv.ku) called++;
      else forgot++;
    }
    expect(forgot).toBeGreaterThan(30);
    expect(called).toBeGreaterThan(forgot);
  });
});

describe('CPU +4 challenges', () => {
  // seat 0 plays a +4 on a sol 5 while holding plenty of sol cards: a clear bluff
  const bluff = (rules: RuleSettings = {}) => {
    const w4 = card('wild4');
    const hand0 = [w4, num('sol', 1), num('sol', 2), num('sol', 3), num('sol', 4), num('sol', 6), num('sol', 7), num('sol', 8)];
    const m = scenario({ rules, hands: { 0: hand0, 1: [num('mar', 1), num('palma', 2), num('coral', 3)], 2: [num('mar', 4)], 3: [num('mar', 5)] }, top: num('sol', 5) });
    return applyMove(m, { kind: 'play', seat: 0, cardId: w4.id, color: 'mar' }).match;
  };

  it('normal and hard CPUs challenge a likely bluff, and the challenge is an event', () => {
    for (const level of ['normal', 'hard'] as Difficulty[]) {
      const m = bluff();
      const mv = chooseMove(m, 1, level);
      expect(mv?.kind, level).toBe('challenge');
      const out = applyMove(m, mv!);
      expect(out.events).toContainEqual(expect.objectContaining({ type: 'challenge', by: 1, target: 0, caught: true }));
    }
  });

  it('easy CPUs challenge now and then', () => {
    let n = 0;
    for (let seed = 0; seed < 40; seed++) {
      const m = bluff();
      if (chooseMove({ ...m, rng: seed * 7919 }, 1, 'easy')?.kind === 'challenge') n++;
    }
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(40);
  });

  it('never on a stacked +4 (not even offered)', () => {
    const w4 = card('wild4');
    const d2 = card('draw2', 'sol');
    const m0 = scenario({
      mode: 'action',
      hands: { 0: [d2, num('sol', 1)], 1: [w4, num('sol', 2), num('sol', 3), num('sol', 6), num('sol', 7)], 2: [num('mar', 1), num('palma', 2)], 3: [num('mar', 5)] },
      top: num('sol', 5),
    });
    const m1 = applyMove(m0, { kind: 'play', seat: 0, cardId: d2.id }).match;
    const m2 = applyMove(m1, { kind: 'play', seat: 1, cardId: w4.id, color: 'mar' }).match;
    expect([m2.round!.turn, m2.round!.pendingDraw]).toEqual([2, 6]);
    expect(legalMovesOf(m2, 2).some((x) => x.kind === 'challenge')).toBe(false);
    for (const level of ['easy', 'normal', 'hard'] as Difficulty[]) expect(chooseMove(m2, 2, level)?.kind).not.toBe('challenge');
  });
});
