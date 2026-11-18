/**
 * CPU strength / speed benchmark. Skipped unless KUCA_BENCH is set, e.g. (PowerShell):
 *   $env:KUCA_BENCH='hard:normal'; $env:KUCA_DEALS='200'; npx vitest run src/engine/ai.bench.test.ts
 * KUCA_BENCH = "<a>:<b>[,<a>:<b>…]" levels; KUCA_FROM = first seed (default 1); KUCA_MODE = classic | action;
 * KUCA_TUNE = JSON overrides for HARD_W / NORMAL_W (prefix "n." for a NORMAL_W key HARD_W also has).
 *
 * Format: 4-player one-round games where A and B sit at two seats and the other two seats are normal.
 * Every deal is played four times with A / B at seats (0,1), (1,0), (0,2), (2,0) (duplicate style, less
 * luck). Reported: A's share of the rounds A or B won (head-to-head), both absolute win rates, and
 * master's milliseconds per searched decision. Deterministic for a seed range (master's playout cap
 * binds before the clock on a desktop).
 */
import { describe, expect, it } from 'vitest';
import type { Difficulty, GameMode, MatchState, Seat } from '../contracts';
import { applyMove, chooseMove, closeWindow, createMatch, RULE_PRESETS, startRound } from '.';
import { lastMasterStats } from './ai';
import { HARD_W, NORMAL_W } from './aiPolicy';
import { Rng } from './rng';

const BENCH = typeof process !== 'undefined' ? process.env.KUCA_BENCH : undefined;
// KUCA_TUNE = JSON overrides for HARD_W (weight experiments)
// KUCA_MASTER = JSON MasterOptions for master seats (e.g. {"timeMs":1e9} to ignore the clock)
const MASTER_OPTS = BENCH && process.env.KUCA_MASTER ? JSON.parse(process.env.KUCA_MASTER) : undefined;
if (BENCH && process.env.KUCA_TUNE) {
  for (const [k, v] of Object.entries(JSON.parse(process.env.KUCA_TUNE) as Record<string, number>)) {
    if (k.startsWith('n.')) (NORMAL_W as Record<string, number>)[k.slice(2)] = v;
    else if (k in HARD_W) (HARD_W as Record<string, number>)[k] = v;
    else if (k in NORMAL_W) (NORMAL_W as Record<string, number>)[k] = v;
    else throw new Error('unknown weight ' + k);
  }
}

interface Timing {
  searched: number;
  ms: number;
  max: number;
}

function playRound(mode: GameMode, levels: Record<number, Difficulty>, seed: number, tm: Timing): Seat {
  const rules = { ...RULE_PRESETS.find((p) => p.id === mode)!.rules, target: 0 };
  let m: MatchState = startRound(createMatch(rules, { mode, players: 4 }, seed)).match;
  const rng = new Rng(seed * 31 + 7);
  const ask = (s: Seat) => {
    const lv = levels[s] ?? 'normal';
    if (lv !== 'master') return chooseMove(m, s, lv);
    lastMasterStats.playouts = 0;
    const t0 = performance.now();
    const mv = chooseMove(m, s, lv, undefined, MASTER_OPTS);
    const dt = performance.now() - t0;
    if (lastMasterStats.playouts > 0) {
      tm.searched++;
      tm.ms += dt;
      tm.max = Math.max(tm.max, dt);
    }
    return mv;
  };
  for (let i = 0; i < 4000; i++) {
    const r = m.round!;
    if (r.over) break;
    let acted = false;
    const start = rng.int(m.seats.length);
    for (let j = 0; j < m.seats.length && !acted; j++) {
      const s = m.seats[(start + j) % m.seats.length];
      if (s === r.turn) continue;
      const mv = ask(s);
      if (!mv) continue;
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
    const mv = ask(m.round!.turn)!;
    const out = applyMove(m, mv);
    m = out.match;
    for (const e of out.events) if (e.type === 'roundEnd') return e.winner;
  }
  throw new Error(`round did not finish (seed ${seed})`);
}

const PAIRS: [Seat, Seat][] = [
  [0, 1],
  [1, 0],
  [0, 2],
  [2, 0],
];

describe.runIf(!!BENCH)('cpu benchmark', () => {
  for (const pair of (BENCH ?? '').split(',').filter(Boolean)) {
    const [a, b] = pair.split(':') as [Difficulty, Difficulty];
    it(`${a} vs ${b}`, () => {
      const deals = Number(process.env.KUCA_DEALS ?? 100);
      const from = Number(process.env.KUCA_FROM ?? 1);
      const mode = (process.env.KUCA_MODE ?? 'classic') as GameMode;
      const tm: Timing = { searched: 0, ms: 0, max: 0 };
      let wa = 0;
      let wb = 0;
      let n = 0;
      const t0 = performance.now();
      for (let seed = from; seed < from + deals; seed++) {
        for (const [sa, sb] of PAIRS) {
          const w = playRound(mode, { [sa]: a, [sb]: b }, seed, tm);
          n++;
          if (w === sa) wa++;
          else if (w === sb) wb++;
        }
      }
      const res = {
        pair, mode, from, deals, rounds: n, aWins: wa, bWins: wb,
        h2h: +(wa / Math.max(1, wa + wb)).toFixed(4),
        aRate: +(wa / n).toFixed(4), bRate: +(wb / n).toFixed(4),
        masterMs: tm.searched ? +(tm.ms / tm.searched).toFixed(1) : null, masterMax: +tm.max.toFixed(1), searched: tm.searched,
        sec: +((performance.now() - t0) / 1000).toFixed(1),
      };
      console.log('BENCH ' + JSON.stringify(res));
      expect(n).toBeGreaterThan(0);
    }, 3_600_000);
  }
});
