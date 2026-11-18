/**
 * Master CPU: time-budgeted determinized Monte Carlo over the real engine.
 *
 * For a turn decision it keeps the best few candidates by the hard heuristic, then repeatedly:
 *  1. samples a world consistent with what the seat knows: its own hand, the partner's open hand, the
 *     public hand sizes, colours a seat could not follow (no card of that colour is dealt to it) and
 *     colours chosen after wilds (one such card is dealt to it when possible); the rest of the hidden
 *     cards are shuffled into the hidden hands and the deck;
 *  2. plays each candidate in that world and runs a short playout with the hard policy for every seat
 *     (common random numbers: the same world and seed for every candidate);
 *  3. scores the end: a finished round counts as a win / loss for the seat's team (plus a little for the
 *     points when the match is played to a target), a cut-off playout counts as a win chance estimated
 *     from the hand sizes.
 * The best average (plus a small share of the heuristic score as a tie-break) wins. Everything is
 * seeded from the match state (no Math.random), and the sample count is capped so the result does not
 * depend on the device; the wall-clock budget (MASTER_MS) only cuts slow devices short.
 *
 * Phase 9 balance: in this game the playouts mostly average out hidden-hand luck, so many deep playouts
 * buy little strength (measured: 240 playouts × 14 turns ≈ 150 ms gave the same results as 160 × 4
 * turns ≈ 30–40 ms). Master's edge over hard is mainly that it plays hard's policy without hard's slips;
 * the short search adds a little on top and stays cheap on weak phones.
 */
import type { Card, MatchState, Move, PlayStyle, RoundState, Seat } from '../contracts';
import { applyMove, closeWindow, legalMoves, opponents } from './game';
import { bit, knowledge, type Knowledge } from './aiKnow';
import { chooseHeuristic, handQuality, decideJump, decidePre, finishPlay, isTurnMove, makeCtx, scoreTurn, styleWeights, type Ctx } from './aiPolicy';
import { hashSeed, Rng } from './rng';

/** wall-clock budget per master decision (ms) */
export const MASTER_MS = 60;

export interface MasterOptions {
  /** wall-clock budget (ms), default MASTER_MS */
  timeMs?: number;
  /** cap on playouts (samples × candidates); keeps decisions reproducible on fast devices */
  maxPlayouts?: number;
  /** turn moves per playout before the hand-size estimate takes over */
  depth?: number;
  /** candidates kept from the heuristic ranking */
  candidates?: number;
  /** share of the heuristic score added to the playout average (default HEUR_K) */
  heurK?: number;
}

const DEFAULTS = { maxPlayouts: 160, depth: 4, candidates: 3 };
/** share of the heuristic score added to the playout average (the heuristic is ~±50 per card) */
const HEUR_K = 0.0015;
/** hand quality (aiPolicy.handQuality) counts as this many cards fewer in the cut-off estimate */
const QUALITY_K = 0.06;

export let lastMasterStats = { samples: 0, playouts: 0, ms: 0, candidates: 0 };

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export function chooseMaster(match: MatchState, seat: Seat, k: Knowledge, seed: number, style?: PlayStyle, opts: MasterOptions = {}): Move | null {
  const legal = legalMoves(match, seat);
  if (!legal.length) return null;
  const rng = new Rng(seed);
  const c = makeCtx(match, seat, 3, styleWeights(style), k, rng);
  const pre = decidePre(c, legal);
  if (pre !== undefined) return pre;
  const turn = legal.filter(isTurnMove);
  if (!turn.length) {
    const jumps = legal.filter((x) => x.kind === 'jumpIn');
    return jumps.length ? decideJump(c, jumps, legal.find((x) => x.kind === 'callKu')) : null;
  }
  if (turn.length === 1) return finishPlay(c, turn[0]);

  // candidates: the best few by the hard heuristic (an immediate win is taken at once)
  const scored = turn.map((mv) => ({ mv, h: scoreTurn(c, mv) })).sort((a, b) => b.h - a.h);
  if (scored[0].h >= 150) return finishPlay(c, scored[0].mv);
  const cands = scored.slice(0, opts.candidates ?? DEFAULTS.candidates).map((x) => ({ mv: finishPlay(c, x.mv), h: x.h, acc: 0, n: 0 }));
  if (cands.length === 1) return cands[0].mv;

  const timeMs = opts.timeMs ?? MASTER_MS;
  const maxPlayouts = opts.maxPlayouts ?? DEFAULTS.maxPlayouts;
  const depth = opts.depth ?? DEFAULTS.depth;
  const heurK = opts.heurK ?? HEUR_K;
  const maxSamples = Math.max(2, Math.floor(maxPlayouts / cands.length));
  const t0 = now();
  const r = match.round!;
  const team = (s: Seat) => s === seat || !opponents(match, seat, s);
  let samples = 0;
  let playouts = 0;
  let out = false;
  while (samples < maxSamples && !out) {
    const world = determinize(match, r, seat, k, rng);
    const playSeed = rng.int(0x7fffffff);
    for (const cd of cands) {
      // the clock is checked between playouts (slow devices stop early; one full sample at least)
      if (samples >= 1 && now() - t0 > timeMs * 0.9) {
        out = true;
        break;
      }
      cd.acc += playout(world, cd.mv, team, depth, playSeed, t0 + timeMs * 0.95);
      cd.n++;
      playouts++;
    }
    if (!out) samples++;
  }
  let best = cands[0];
  let bestV = -Infinity;
  for (const cd of cands) {
    const v = cd.acc / Math.max(1, cd.n) + heurK * cd.h;
    if (v > bestV) {
      bestV = v;
      best = cd;
    }
  }
  lastMasterStats = { samples, playouts, ms: now() - t0, candidates: cands.length };
  return best.mv;
}

/** a full world consistent with what `seat` knows */
function determinize(m: MatchState, r: RoundState, seat: Seat, k: Knowledge, rng: Rng): MatchState {
  const hidden: Seat[] = [];
  const pool: Card[] = [];
  for (const s of m.seats) {
    if (s === seat || r.eliminated[s] || (k.pHand && s === k.partner)) continue;
    hidden.push(s);
    for (const c of r.hands[s]) pool.push(c);
  }
  for (const c of r.deck) pool.push(c);
  // shuffle
  for (let i = pool.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    const t = pool[i];
    pool[i] = pool[j];
    pool[j] = t;
  }
  const used = new Uint8Array(pool.length);
  const hands = r.hands.slice();
  // constrained seats first (most voids first)
  const order = hidden.slice().sort((a, b) => popcount(k.voids[b]) - popcount(k.voids[a]));
  for (const s of order) {
    const need = r.hands[s].length;
    const voids = k.voids[s];
    const hand: Card[] = [];
    if (k.likes[s]) {
      for (let i = 0; i < pool.length && !hand.length; i++) {
        const col = pool[i].face.color;
        if (!used[i] && col && k.likes[s] & bit(col) && !(voids & bit(col))) {
          used[i] = 1;
          hand.push(pool[i]);
        }
      }
    }
    for (let i = 0; i < pool.length && hand.length < need; i++) {
      if (used[i]) continue;
      const col = pool[i].face.color;
      if (voids && col && voids & bit(col)) continue;
      used[i] = 1;
      hand.push(pool[i]);
    }
    // not enough cards outside the voids: the inference was wrong, fill with anything
    for (let i = 0; i < pool.length && hand.length < need; i++) {
      if (used[i]) continue;
      used[i] = 1;
      hand.push(pool[i]);
    }
    hands[s] = hand;
  }
  const deck: Card[] = [];
  for (let i = 0; i < pool.length; i++) if (!used[i]) deck.push(pool[i]);
  return { ...m, round: { ...r, hands, deck } };
}

const popcount = (x: number) => {
  let n = 0;
  while (x) {
    n += x & 1;
    x >>= 1;
  }
  return n;
};

/** hard-policy playout after `first`; returns the value for `seat`'s team in [~0, ~1.2] */
function playout(world: MatchState, first: Move, team: (s: Seat) => boolean, depth: number, seed: number, deadline: number): number {
  let m: MatchState = { ...world, rng: seed };
  const rng = new Rng(seed ^ 0x2545f491);
  // each seat's counting is taken once per playout (it changes slowly; recounting every ply is costly)
  const know: (Knowledge | undefined)[] = [];
  const target = Number(m.rules.target) || 0;
  let res = step(m, first);
  if (!res) return 0.5;
  m = res.m;
  if (res.winner !== null) return endValue(res.winner, res.points, team, target);
  let turns = 0;
  let guard = 0;
  while (turns < depth && guard++ < depth * 4) {
    if ((guard & 3) === 0 && now() > deadline) break;
    const r = m.round!;
    if (r.over || m.over) break;
    let mv: Move | null = null;
    if (r.window) {
      for (const s of r.window.seats.concat(r.window.victim !== undefined ? [r.window.victim] : [])) {
        mv = policy(m, s, rng, false, know);
        if (mv) break;
      }
      if (!mv) {
        const out = closeWindow(m);
        const w = winnerOf(out.events);
        m = out.match;
        if (w) return endValue(w.winner, w.points, team, target);
        continue;
      }
    } else {
      mv = policy(m, r.turn, rng, true, know);
      turns++;
    }
    if (!mv) break;
    res = step(m, mv);
    if (!res) break;
    m = res.m;
    if (res.winner !== null) return endValue(res.winner, res.points, team, target);
  }
  return estimate(m, team);
}

function policy(m: MatchState, s: Seat, rng: Rng, onTurn: boolean, know: (Knowledge | undefined)[]): Move | null {
  const legal = legalMoves(m, s);
  if (!legal.length) return null;
  const r = m.round!;
  let k = know[s];
  if (!k) k = know[s] = knowledge(m, r, s, null);
  else if (k.pHand) k = { ...k, pHand: r.hands[k.partner!] };
  const c: Ctx = makeCtx(m, s, 3, styleWeights(), k, rng);
  if (!onTurn) {
    // windows: respond / call / catch only (no jump-ins in playouts, for speed)
    const pre = decidePre(c, legal);
    return pre ?? null;
  }
  return chooseHeuristic(c, legal);
}

function winnerOf(events: { type: string }[]): { winner: Seat; points: number } | null {
  for (const e of events) {
    if (e.type === 'roundEnd') {
      const ev = e as { type: 'roundEnd'; winner: Seat; points: number[] };
      return { winner: ev.winner, points: Math.max(...ev.points) };
    }
  }
  return null;
}

function step(m: MatchState, mv: Move): { m: MatchState; winner: Seat | null; points: number } | null {
  let out;
  try {
    out = applyMove(m, mv);
  } catch {
    return null;
  }
  const w = winnerOf(out.events);
  return { m: out.match, winner: w ? w.winner : null, points: w ? w.points : 0 };
}

function endValue(winner: Seat, points: number, team: (s: Seat) => boolean, target: number): number {
  const pts = target > 0 ? 0.2 * Math.min(1, points / Math.max(100, target * 0.4)) : 0;
  return team(winner) ? 1 + pts : -pts;
}

/** win chance from the hand sizes (and a pending stack) */
function estimate(m: MatchState, team: (s: Seat) => boolean): number {
  const r = m.round!;
  let mine = 0;
  let all = 0;
  for (const s of m.seats) {
    if (r.eliminated[s]) continue;
    let n = r.hands[s].length;
    if (r.pendingDraw > 0 && s === r.turn) n += r.pendingDraw * 0.7;
    const w = Math.exp(-0.55 * (n - QUALITY_K * handQuality(r.hands[s])));
    all += w;
    if (team(s)) mine += w;
  }
  return all > 0 ? mine / all : 0.5;
}

export const masterSeed = (m: MatchState, seat: Seat): number => {
  const r = m.round!;
  return hashSeed(m.rng, seat, 4, r.discard.length, r.deck.length, r.hands[seat].length, r.turn, r.roundNo, 0x6d);
};
