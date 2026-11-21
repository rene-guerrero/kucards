/**
 * CPU policies for easy / normal / hard (master uses `hardTurnScores` as its prior and playout policy).
 *
 *  - easy:   a random legal card (style: carefree = first card that fits, impulsive = highest number,
 *            beginner = colour first and wilds right away); forgets ¡Ku! now and then.
 *  - normal: heuristics. Dump high numbers, keep wilds, best colour, penalties on short opponents, never
 *            penalise / mirror onto the partner when avoidable, shield / mirror when hit. It is the casual
 *            default, so it slips now and then (NORMAL_W): a rough card / colour pick, a forgotten ¡Ku!,
 *            a missed catch.
 *  - hard:   normal + public card counting (Knowledge: unseen colours, voids, colours chosen after wilds,
 *            the partner's open hand): colour choices aimed at the next opponent's voids and away from what
 *            is still out there, targets the leader, holds +4 / shields / mirrors for defence, sets up the
 *            partner (colours it can play, its last card), endgame care with the last two cards, smarter
 *            +4 challenges, keeps penalties / skips / wilds for when an opponent gets short (HARD_W),
 *            always catches a missed ¡Ku!. Small slips (HARD_W.slip*, forgetKu) keep it below master.
 * Style weights are light biases added on top (see STYLE_WEIGHTS).
 */
import type { Card, CardFace, Color, MatchState, Move, PlayStyle, RoundState, Seat } from '../contracts';
import { sideColors } from '../contracts';
import { cardPoints, matchDeck } from './cards';
import { canPlay, isLegal, multiPlayOptions, opponents, stepSeat } from './game';
import { bit, colorIdx, drawOf, isPenaltyCard, isWildCard, type Knowledge } from './aiKnow';
import type { Rng } from './rng';

export type Level = 1 | 2 | 3; // easy, normal, hard (master plays hard outside its search)

// ───────────────────────── styles ─────────────────────────

export interface StyleWeights {
  /** bonus for penalties / skips on an opponent */
  penalty: number;
  /** extra bonus when that opponent is the leader */
  leader: number;
  /** cost of spending wilds / +4 while the hand is still big */
  hoard: number;
  /** calls ¡Ku! as soon as it has two cards, catches everyone (easy too) */
  kuEarly: boolean;
  /** multiplier on partner terms */
  partner: number;
  /** number cards before action cards */
  numbers: number;
  /** per colour kept in hand */
  variety: number;
}

const BASE: StyleWeights = { penalty: 0, leader: 0, hoard: 0, kuEarly: false, partner: 1, numbers: 0, variety: 0 };

export const STYLE_WEIGHTS: Record<PlayStyle, StyleWeights> = {
  carefree: BASE,
  impulsive: { ...BASE, numbers: 2 },
  beginner: BASE,
  balanced: { ...BASE, variety: 3 },
  byTheBook: { ...BASE, numbers: 8 },
  chatty: { ...BASE, kuEarly: true },
  aggressive: { ...BASE, penalty: 12, leader: 6 },
  hoarder: { ...BASE, hoard: 15 },
  teamPlayer: { ...BASE, partner: 1.6 },
  perfect: BASE,
};

export const styleWeights = (style?: PlayStyle): StyleWeights => (style ? STYLE_WEIGHTS[style] ?? BASE : BASE);

// ───────────────────────── hard weights ─────────────────────────

/**
 * Weights of the hard-level terms (master uses hard as its prior and playout policy). Tuned with the
 * seeded benchmark in ai.bench.test.ts; exported so the benchmark can try variants (never changed by
 * the game itself).
 */
export const HARD_W = {
  /** per unseen number card of the same value (others can switch colour on it) */
  numVal: 1.2,
  /** hand-quality change */
  qual: 2,
  /** colour environment for the next player */
  env: 1,
  /** I play again: bonus with a follow-up card */
  follow: 1,
  /** penalty / skip on the leader */
  leader: 8,
  /** a one-card opponent plays next on a colour that is not its void */
  short1: 12,
  /** big wild penalty spent early */
  bigWild: 12,
  /** the last two cards: keep the flexible one */
  last2: 1,
  /** shed points when an opponent is close to going out */
  shed: 0.25,
  /** per card of the resulting colour still in hand */
  keepColor: 0,
  /** penalties / skips on an opponent with many cards while nobody is short: keep them */
  holdHit: 50,
  /** …while the victim holds more than holdLen cards and every opponent more than holdMin */
  holdLen: 3,
  holdMin: 2,
  /** plain wilds spent while other cards can be played */
  holdWild: 40,
  /** hard only (master plays without them): small random slips per card / on the wild colour */
  slipNoise: 40,
  slipColor: 30,
  /** hard only: forgets to call ¡Ku! this often (it still calls at once when the catch window opens) */
  forgetKu: 0.15,
};

/** normal-level weights (normal is the casual default: decent, but it slips now and then) */
export const NORMAL_W = {
  /** random spread added to every move score (hard / master: 0.5, a tie-break only) */
  noise: 25,
  /** forgets to call ¡Ku! with the second-to-last card this often (hard / master never do) */
  forgetKu: 0.4,
  /** lets a missed ¡Ku! go this often (hard / master always catch) */
  missCatch: 0.2,
  /** after forgetting, calls ¡Ku! before anyone catches it this often */
  rescueKu: 0.25,
  /** spread on the wild colour choice (each card of a colour in hand is worth ~3) */
  colorNoise: 20,
};

/**
 * Random spread for a move score. Normal draws one slip per card (all colour / target variants of a card
 * share it, so a wild still gets its best colour); hard / master only break ties.
 */
function noiser(c: Ctx): (mv: Move) => number {
  const card = c.level === 2 ? NORMAL_W.noise : c.slip ? HARD_W.slipNoise : 0;
  const colour = c.level === 2 ? NORMAL_W.colorNoise : c.slip ? HARD_W.slipColor : 0;
  if (card <= 0.5 && colour <= 0.5) return () => c.rng.next() * 0.5;
  const per = new Map<number, number>();
  return (mv) => {
    // only card choices slip: drawing / passing / accepting stay deliberate
    if (mv.kind !== 'play' && mv.kind !== 'jumpIn') return c.rng.next() * 0.5;
    const id = mv.cardId;
    let v = per.get(id);
    if (v === undefined) per.set(id, (v = c.rng.next() * card));
    // wild colours: a rough pick among the colours it holds, not always the very best one
    const col = extra(mv).color;
    return v + c.rng.next() * (col && mv.kind === 'play' && !extra(mv).target ? Math.max(0.5, colour) : 0.5);
  };
}

// ───────────────────────── helpers ─────────────────────────

/** easy CPUs forget to shout ¡Ku! this often (impulsive ones a bit more) */
export const EASY_FORGET_KU = 0.3;
const IMPULSIVE_FORGET_KU = 0.45;

const DRAW_SCORE = -60;
const PASS_SCORE = -55;
const ACCEPT_SCORE = -40;
const PARTNER_HIT = -100;

/** deck empty and nothing under the top card to reshuffle: drawing brings no card */
const nothingToDraw = (r: RoundState): boolean => r.deck.length === 0 && r.discard.length <= 1;

export const isTurnMove = (mv: Move): boolean => mv.kind === 'play' || mv.kind === 'draw' || mv.kind === 'pass' || mv.kind === 'acceptPenalty';

const colorCount = (hand: readonly Card[], c: Color): number => {
  let n = 0;
  for (const x of hand) if (x.face.color === c) n++;
  return n;
};

/** may `card` go on top of `top` with `color` active (no penalty pending) */
export function fits(card: Card, top: Card, color: Color): boolean {
  if (isWildCard(card)) return true;
  if (card.face.color === color) return true;
  if (card.face.kind === 'number') return top.face.kind === 'number' && card.face.value === top.face.value;
  return card.face.kind === top.face.kind;
}

/** move fields some engine versions add (partnerPass `give`, jumpIn `target`) */
type Extra = { give?: number; target?: Seat; color?: Color };
const extra = (mv: Move): Extra => mv as unknown as Extra;

export interface Ctx {
  m: MatchState;
  r: RoundState;
  seat: Seat;
  hand: Card[];
  level: Level;
  w: StyleWeights;
  k: Knowledge | null;
  rng: Rng;
  twoPlayers: boolean;
  /** opponent with the fewest cards (null when none) */
  leader: Seat | null;
  minFoe: number;
  /** hard (not master, not inside master playouts): small slips, see HARD_W.slipNoise */
  slip?: boolean;
}

export function makeCtx(m: MatchState, seat: Seat, level: Level, w: StyleWeights, k: Knowledge | null, rng: Rng): Ctx {
  const r = m.round!;
  let leader: Seat | null = null;
  let minFoe = 99;
  let act = 0;
  for (const s of m.seats) {
    if (r.eliminated[s]) continue;
    act++;
    if (s === seat || !opponents(m, seat, s)) continue;
    const n = r.hands[s].length;
    if (n < minFoe) {
      minFoe = n;
      leader = s;
    }
  }
  return { m, r, seat, hand: r.hands[seat], level, w, k, rng, twoPlayers: act === 2, leader, minFoe };
}

/** who suffers the card (skipped / penalised) and who plays next onto it */
function flowAfter(c: Ctx, card: Card): { victim: Seat | null; nextPlayer: Seat } {
  const { m, r, seat } = c;
  const next = stepSeat(m, r, seat);
  const kind = card.face.kind;
  if (kind === 'skip' || (kind === 'reverse' && c.twoPlayers)) return { victim: next, nextPlayer: stepSeat(m, r, next) };
  if (kind === 'reverse') return { victim: null, nextPlayer: stepSeat(m, r, seat, -r.direction) };
  if (kind === 'skipAll') return { victim: next, nextPlayer: seat };
  if (isPenaltyCard(card)) {
    const stacking = kind !== 'wildColor' && (m.rules.stacking === 'same' || m.rules.stacking === 'any');
    return { victim: next, nextPlayer: stacking ? next : stepSeat(m, r, next) };
  }
  return { victim: null, nextPlayer: next };
}

/** chance the next player can follow `col` on top of `top` (public counting, its voids) */
export function followChance(c: Ctx, top: Card, col: Color, s: Seat): number {
  const k = c.k!;
  const total = Math.max(1, k.unseenTotal);
  let same = 0;
  // cards matching the top by number / kind (other colours): rough share of the unseen cards
  if (top.face.kind === 'number') same = 0.06 * total;
  else if (top.face.color !== null) same = 0.04 * total;
  const colN = k.voids[s] & bit(col) ? 0 : k.unseen[colorIdx(col)];
  const frac = Math.min(0.95, (colN + k.unseenWild + same) / total);
  return 1 - Math.pow(1 - frac, c.r.hands[s].length);
}

/** colour environment for the next player: their voids, what is still out there, the partner's hand */
function colorEnv(c: Ctx, top: Card, col: Color, nextPlayer: Seat): number {
  const k = c.k;
  if (!k) return 0;
  const { m, seat, r } = c;
  let v = 0;
  if (nextPlayer !== seat && opponents(m, seat, nextPlayer)) {
    const n = r.hands[nextPlayer].length;
    v -= followChance(c, top, col, nextPlayer) * (n <= 2 ? 24 : n <= 4 ? 12 : 6);
    if (k.likes[nextPlayer] & bit(col)) v -= 3;
  } else if (k.pHand && nextPlayer === k.partner) {
    const has = colorCount(k.pHand, col);
    v += c.w.partner * (has > 0 ? 3 + Math.min(has, 3) : -3);
  }
  return v;
}

// ───────────────────────── turn move scoring ─────────────────────────

/** heuristic value of a turn move or a jump-in (scored as a play by `seat`) */
export function scoreTurn(c: Ctx, mv: Move): number {
  if (mv.kind === 'draw') return nothingToDraw(c.r) ? -500 : DRAW_SCORE + drawPassAdjust(c);
  if (mv.kind === 'pass') return PASS_SCORE + drawPassAdjust(c);
  if (mv.kind === 'acceptPenalty') return ACCEPT_SCORE;
  if (mv.kind !== 'play' && mv.kind !== 'jumpIn') return -1000;

  const { m, r, seat, hand, w } = c;
  const card = hand.find((x) => x.id === mv.cardId);
  if (!card) return -1000;
  const ex = extra(mv);
  const face = card.face;
  let after = hand.filter((x) => x !== card);
  let swept = 0;
  const sweepCol = face.kind === 'sweep' ? face.color : face.kind === 'sweepWild' ? (ex.color ?? null) : null;
  if (sweepCol) {
    const keep = after.filter((x) => x.face.color !== sweepCol);
    swept = after.length - keep.length;
    after = keep;
  }
  if (ex.give !== undefined) after = after.filter((x) => x.id !== ex.give);
  const { victim, nextPlayer } = flowAfter(c, card);
  const victimLen = victim !== null ? r.hands[victim].length : 99;
  const victimFoe = victim !== null && opponents(m, seat, victim);
  const hit = (strong: number, weak: number) => (victim === null ? 0 : victimFoe ? (victimLen <= 2 ? strong : weak) + w.penalty + (victim === c.leader ? w.leader : 0) : PARTNER_HIT * w.partner);
  const holdsPenalty = after.some((x) => x.face.kind === 'skip' || isPenaltyCard(x));
  const resColor: Color = face.color ?? ex.color ?? r.activeColor;
  const hard = c.level >= 3;
  const big = after.length > 2;

  let sc = 0;
  if (r.pendingDraw > 0) {
    // stacking: passes the (bigger) stack to the next seat
    sc = 30 + (victimFoe ? 20 + w.penalty : PARTNER_HIT * w.partner);
  } else {
    switch (face.kind) {
      case 'number': {
        const val = face.value ?? 0;
        // hard: card points only matter when the match is played to a points target; numbers the others
        // still hold in other colours let them switch colour on me
        sc = 10 + (hard ? (Number(m.rules.target) > 0 ? 0.5 * val : 0) - HARD_W.numVal * (c.k?.unseenVal[val] ?? 0) : val) + w.numbers;
        const target = ex.target;
        if (m.rules.sevenZero && face.value === 7 && target !== undefined) {
          const t = r.hands[target].length;
          sc += opponents(m, seat, target) ? (after.length - t) * 4 + (target === c.leader ? w.leader : 0) : -20;
        } else if (m.rules.sevenZero && face.value === 0) {
          sc += (after.length - r.hands[stepSeat(m, r, seat, -r.direction)].length) * 3;
        }
        if (ex.give !== undefined) sc += giveValue(c, card, ex.give, after.length);
        break;
      }
      case 'skip':
        sc = 22 + hit(25, 5);
        break;
      case 'reverse':
        if (c.twoPlayers) sc = 22 + hit(25, 5);
        else {
          sc = 20;
          const next = stepSeat(m, r, seat);
          const prev = stepSeat(m, r, seat, -r.direction);
          if (opponents(m, seat, next) && r.hands[next].length <= 2) sc += 15; // the short opponent waits longer
          // steer: partner next and an opponent behind -> after the reverse my penalties hit the opponent
          if (m.teams && !opponents(m, seat, next) && opponents(m, seat, prev) && holdsPenalty) sc += 15 * w.partner;
          if (hard && opponents(m, seat, prev) && r.hands[prev].length <= 2 && !opponents(m, seat, next)) sc -= 12;
        }
        break;
      case 'skipAll':
        // everyone else loses a turn and I go again: a free card
        sc = 32 + (c.minFoe <= 2 ? 15 : 5);
        break;
      case 'draw2':
        sc = 24 + hit(40, 8);
        break;
      case 'draw6':
        sc = 26 + hit(50, 15);
        break;
      case 'wild':
        sc = after.length <= 1 ? 30 : -15;
        break;
      case 'wild4':
        sc = (after.length <= 1 ? 30 : -25) + hit(45, 0);
        break;
      case 'draw10':
        sc = (after.length <= 1 ? 30 : -20) + hit(60, 10);
        break;
      case 'wildColor':
        sc = (after.length <= 1 ? 30 : -15) + hit(35, 5);
        break;
      case 'swap': {
        const target = ex.target;
        if (target === undefined) sc = -10;
        else if (opponents(m, seat, target)) sc = -6 + (after.length - r.hands[target].length) * 5 + (target === c.leader ? w.leader : 0);
        else sc = -40;
        break;
      }
      case 'sweep':
        sc = swept >= 2 ? 14 + 9 * swept : 6 + 3 * swept;
        break;
      case 'sweepWild':
        // the colour that sheds the most cards (a wild spent on one card is a waste)
        sc = swept >= 2 ? 10 + 9 * swept : -10 + 3 * swept;
        break;
      case 'flip':
        sc = 10 + flipValue(c, card, after);
        break;
      case 'wildFlip':
        // two-sided: an Eclipse whose colour I pick from the side it turns to; one-sided: a plain wild
        sc = card.other ? (after.length <= 1 ? 30 : 0) + flipValue(c, card, after, ex.color) : after.length <= 1 ? 30 : -15;
        break;
      case 'shield':
      case 'mirror':
        // defence cards: hard keeps them for when a penalty comes
        sc = hard ? (after.length <= 1 ? 26 : big ? 0 : 8) : 12;
        break;
      default:
        sc = 12;
    }
  }
  if (face.color) sc += 2 * colorCount(after, face.color);
  if (face.color === null && ex.color) {
    // wild colour: my colours (after a swap I get the target's hand, so their liked colour instead; a wild
    // sweep and a wild Eclipse weigh their colour themselves)
    if (face.kind === 'swap' && ex.target !== undefined && c.k) sc += c.k.likes[ex.target] & bit(ex.color) ? 4 : 0;
    else if (face.kind === 'sweepWild' || (face.kind === 'wildFlip' && card.other)) {
      /* scored above */
    } else {
      const counts = sideColors(r.side).map((x) => colorCount(after, x));
      const max = Math.max(...counts);
      const mine = colorCount(after, ex.color);
      sc += 3 * mine + (max > 0 && mine === max ? 1 : 0);
    }
  }
  if (face.color === null && big && face.kind !== 'swap' && face.kind !== 'sweepWild') sc -= w.hoard;
  if (w.numbers && face.kind !== 'number') sc -= w.numbers * 0.5;
  if (w.variety) sc += w.variety * sideColors(r.side).reduce((t, x) => t + (colorCount(after, x) > 0 ? 1 : 0), 0);
  if (hard) sc += hardExtras(c, card, after, resColor, victim, victimLen, nextPlayer);
  if (after.length === 0 && ex.give === undefined) sc += 200; // going out always wins
  return sc;
}

// ───────────────────────── Día y Noche ─────────────────────────

/** how much a face helps its holder (Día y Noche flip decisions): wilds and big penalties most */
export function faceStrength(f: CardFace): number {
  switch (f.kind) {
    case 'number':
      return 1;
    case 'wild':
    case 'wildFlip':
      return 5;
    case 'sweepWild':
      return 4;
    case 'wild4':
    case 'wildColor':
      return 6;
    case 'skipAll':
      return 4;
    case 'flip':
      return 2;
    case 'skip':
    case 'reverse':
      return 2.5;
    default:
      return 1 + 0.8 * (f.draw ?? 0);
  }
}

const avgStrength = new Map<string, [number, number]>();
/** the average face strength of each side of the match's two-sided deck: [day, night] */
function sideAvg(m: MatchState): [number, number] {
  const key = JSON.stringify([m.deckSpec ?? null, m.nightSpec ?? null]);
  let v = avgStrength.get(key);
  if (!v) {
    const deck = matchDeck(m);
    const avg = (fs: CardFace[]) => fs.reduce((t, f) => t + faceStrength(f), 0) / Math.max(1, fs.length);
    // the deck starts on the day side: `face` is the day face, `other` the night one
    v = [avg(deck.map((x) => x.face)), avg(deck.map((x) => x.other ?? x.face))];
    if (avgStrength.size > 16) avgStrength.clear();
    avgStrength.set(key, v);
  }
  return v;
}

/**
 * Value of playing an Eclipse: my hand after it (I see my cards' other faces) against what each opponent
 * gets. Opponents' cards after the flip are exactly the backs everybody sees now (public), against what
 * an average hand of the side in play would be worth; the short opponents count most. Plus how many of
 * my cards follow the face the Eclipse turns up.
 */
export function flipValue(c: Ctx, card: Card, after: readonly Card[], pick?: Color): number {
  const { m, r, seat } = c;
  const sum = (cs: readonly Card[], other: boolean) => cs.reduce((t, x) => t + faceStrength(other ? x.other ?? x.face : x.face), 0);
  let v = 2 * (sum(after, true) - sum(after, false));
  const [day, night] = sideAvg(m);
  const avgNow = r.side === 'dark' ? night : day;
  for (const s of m.seats) {
    if (s === seat || r.eliminated[s]) continue;
    const hand = r.hands[s];
    const gain = sum(hand, true) - avgNow * hand.length;
    const weight = hand.length <= 2 ? 3 : hand.length <= 4 ? 1.5 : 1;
    v += (opponents(m, seat, s) ? -1.2 : 0.6 * c.w.partner) * weight * gain;
  }
  // the face the Eclipse turns up: how many of my cards follow it (wildFlip: the colour I pick)
  const top = card.other;
  if (pick) {
    let fit = 0;
    for (const x of after) {
      const f = x.other ?? x.face;
      if (f.color === null || f.color === pick) fit++;
    }
    v += 3 * Math.min(fit, 4) - (fit === 0 ? 6 : 0);
  } else if (top) {
    const col = top.color;
    let fit = 0;
    for (const x of after) {
      const f = x.other ?? x.face;
      if (f.color === null || (col !== null && f.color === col) || (f.kind === top.kind && (f.kind !== 'number' || f.value === top.value))) fit++;
    }
    v += 3 * Math.min(fit, 3) - (fit === 0 ? 6 : 0);
  }
  return v;
}

/** hard: how well a hand can follow whatever comes next (colours covered, number bridges, wilds) */
export function handQuality(hand: readonly Card[]): number {
  if (!hand.length) return 0;
  let colours = 0;
  let wilds = 0;
  const vals = new Map<number, number>(); // value -> colour bitmask
  for (const x of hand) {
    if (isWildCard(x)) wilds++;
    else if (x.face.color) {
      colours |= bit(x.face.color);
      if (x.face.kind === 'number') vals.set(x.face.value ?? 0, (vals.get(x.face.value ?? 0) ?? 0) | bit(x.face.color));
      else vals.set(104 + x.face.kind.length, (vals.get(104 + x.face.kind.length) ?? 0) | bit(x.face.color));
    }
  }
  let cov = 0;
  for (let i = 0; i < 4; i++) if (colours & (1 << i)) cov++;
  let bridges = 0;
  for (const b of vals.values()) {
    let n = 0;
    for (let i = 0; i < 4; i++) if (b & (1 << i)) n++;
    if (n > 1) bridges += n - 1;
  }
  return 3 * cov + 2 * Math.min(bridges, 4) + 5 * Math.min(wilds, 2);
}

/** hard: card counting, defence, partner set-up, endgame */
function hardExtras(c: Ctx, card: Card, after: Card[], resColor: Color, victim: Seat | null, victimLen: number, nextPlayer: Seat): number {
  const { m, r, seat, w, k } = c;
  const face = card.face;
  let v = 0;
  if (r.pendingDraw > 0) return 0;
  const H = HARD_W;
  v += H.qual * (handQuality(after) - handQuality(c.hand));
  // the resulting colour against the next player's hand
  v += H.env * colorEnv(c, card, resColor, nextPlayer);
  // I play again (2 players: skip / reverse / penalty; skipAll): worth it with a follow-up card
  if (nextPlayer === seat || (c.twoPlayers && victim !== null && opponents(m, seat, victim))) {
    let follow = 0;
    for (const x of after) if (fits(x, card, resColor)) follow++;
    v += H.follow * (follow ? 6 + Math.min(follow, 3) : drawOf(card) ? -2 : -9);
  }
  // the leader is the real target
  if (victim !== null && opponents(m, seat, victim) && victim === c.leader) v += H.leader;
  // a short opponent about to play onto my card is dangerous unless the colour is their void
  if (nextPlayer !== seat && opponents(m, seat, nextPlayer)) {
    const n = r.hands[nextPlayer].length;
    const voidHit = k ? (k.voids[nextPlayer] & bit(resColor)) !== 0 : false;
    if (n === 1 && !voidHit) v -= H.short1;
  }
  // big penalties and defence cards are worth more later
  const d = drawOf(card);
  if (d >= 4 && isWildCard(card) && victimLen > 3 && after.length > 2) v -= H.bigWild;
  // partner set-up (open hand): its last cards
  if (k?.pHand && k.partner !== null && nextPlayer === k.partner && !r.eliminated[k.partner]) {
    const ph = k.pHand;
    let playable = 0;
    for (const x of ph) if (fits(x, card, resColor)) playable++;
    if (ph.length === 1 && playable) v += 40 * w.partner;
    else if (ph.length <= 3) v += 4 * playable * w.partner;
  }
  // the last two cards: keep the flexible one
  if (after.length === 1) {
    const x = after[0];
    if (isWildCard(x)) v += 12 * H.last2;
    else if (x.face.color === resColor) v += 8 * H.last2;
    else if (fits(x, card, resColor)) v += 4 * H.last2;
  }
  if (H.keepColor) v += H.keepColor * colorCount(after, resColor);
  if (H.holdHit && victim !== null && opponents(m, seat, victim) && victimLen > H.holdLen && c.minFoe > H.holdMin && after.length > 2) v -= H.holdHit;
  if (H.holdWild && (face.kind === 'wild' || face.kind === 'wild4') && after.length > 1 && c.hand.some((x) => x !== card && !isWildCard(x) && fits(x, c.r.discard[c.r.discard.length - 1], c.r.activeColor))) v -= H.holdWild;
  // an opponent close to going out: shed points
  if (c.minFoe <= 2) v += H.shed * cardPoints(face);
  return v;
}

/** drawing / passing: hard dislikes leaving a short opponent a free turn on a colour it follows */
function drawPassAdjust(c: Ctx): number {
  if (c.level < 3) return 0;
  const next = stepSeat(c.m, c.r, c.seat);
  if (c.k?.pHand && next === c.k.partner && c.k.pHand.length === 1) {
    const top = c.r.discard[c.r.discard.length - 1];
    if (fits(c.k.pHand[0], top, c.r.activeColor)) return 30 * c.w.partner; // partner goes out on this colour
  }
  return 0;
}

/** partnerPass: giving my card to the partner helps when I am the one closer to going out */
function giveValue(c: Ctx, seven: Card, giveId: number, myAfter: number): number {
  const p = c.k?.partner ?? partnerSeat(c);
  if (p === null) return -50;
  const pLen = c.r.hands[p].length;
  const give = c.hand.find((x) => x.id === giveId);
  if (!give || give === seven) return -50;
  let v = myAfter + 1 <= pLen ? 6 : -8;
  if (myAfter <= 1) v += 10;
  if (c.k?.pHand && give.face.color && colorCount(c.k.pHand, give.face.color) > 0) v += 2;
  if (isWildCard(give)) v -= 3;
  return v;
}

const partnerSeat = (c: Ctx): Seat | null => {
  if (!c.m.teams) return null;
  const team = c.m.teams[0].includes(c.seat) ? c.m.teams[0] : c.m.teams[1];
  return team.find((s) => s !== c.seat) ?? null;
};

// ───────────────────────── decisions ─────────────────────────

/**
 * Everything before the turn move: ¡Ku! catches / calls, shield / mirror responses, +4 challenges.
 * Returns undefined when the turn (or jump-in) decision should follow.
 */
export function decidePre(c: Ctx, legal: Move[]): Move | null | undefined {
  const { r, seat, hand, w } = c;
  const easy = c.level === 1;
  const catchMv = legal.find((x) => x.kind === 'catchKu');
  if (catchMv && (easy ? w.kuEarly || c.rng.next() < 0.5 : c.level > 2 || w.kuEarly || c.rng.next() >= NORMAL_W.missCatch)) return catchMv;
  const callMv = legal.find((x) => x.kind === 'callKu');
  if (callMv) {
    const asked = r.window?.reason === 'ku' && r.window.victim === seat;
    if (asked && (c.level > 2 || c.rng.next() < (easy ? 0.5 : NORMAL_W.rescueKu))) return callMv;
    if (!easy && !(asked && c.level === 2) && hand.length === 1 && !r.kuCalled[seat]) return callMv;
    if (w.kuEarly && hand.length === 2 && seat !== r.turn) return callMv;
  }
  const responds = legal.filter((x) => x.kind === 'respond');
  if (responds.length) {
    const mv = decideRespond(c, responds);
    if (mv) return mv;
  }
  const challenge = legal.find((x) => x.kind === 'challenge');
  const stacks = legal.filter((x) => x.kind === 'play');
  if (challenge && shouldChallenge(c, stacks.length > 0)) return challenge;
  // mandatory stacking: rather challenge than be forced to stack onto the partner
  if (challenge && c.m.teams && stacks.length && stacks.every((x) => hitsPartner(c, x))) return challenge;
  return undefined;
}

function decideRespond(c: Ctx, responds: Move[]): Move | null {
  const { m, r, seat } = c;
  if (c.level === 1) return c.rng.next() < 0.5 ? responds[c.rng.int(responds.length)] : null;
  const victim = r.window?.victim ?? r.turn;
  if (victim !== seat && opponents(m, seat, victim)) return null; // never rescue an opponent
  const from = r.pendingFrom;
  const kindOf = (mv: Move) => c.hand.find((x) => mv.kind === 'respond' && x.id === mv.cardId)?.face.kind;
  const mirror = responds.find((x) => kindOf(x) === 'mirror');
  const shield = responds.find((x) => kindOf(x) === 'shield');
  const mirrorOk = from !== null && from !== seat && opponents(m, seat, from);
  if (mirror && mirrorOk && (r.pendingDraw >= 4 || opponents(m, seat, from!))) return mirror;
  if (shield) return shield;
  // other respond cards the engine may list: anything but a mirror onto the own team
  return responds.find((x) => kindOf(x) !== 'mirror') ?? null;
}

/**
 * +4 / +10 challenge: was it likely played while holding the colour in play before it?
 * Easy: now and then, at random. Normal: the chance the offender holds that colour, from the cards it
 * cannot see (own hand and the pile are known). Hard / master: the tracker's unseen counts, and never
 * when the offender showed it could not follow that colour. The bar is higher when a stack is
 * possible (stacking passes the penalty on for free). Never the own partner (see decidePre).
 */
function shouldChallenge(c: Ctx, canStack: boolean): boolean {
  const { r } = c;
  const offender = r.pendingFrom ?? stepSeat(c.m, r, c.seat, -r.direction);
  if (offender === c.seat || !opponents(c.m, c.seat, offender)) return false;
  if (c.level === 1) return c.rng.next() < (canStack ? 0.12 : 0.3);
  const under = r.discard[r.discard.length - 2];
  const prevColor = c.k?.prevColor ?? under?.face.color ?? null;
  if (!prevColor) return false;
  const n = r.hands[offender].length;
  let frac: number;
  if (c.k) {
    if (c.k.voids[offender] & bit(prevColor)) return false; // it could not follow that colour: legal
    frac = c.k.unseen[colorIdx(prevColor)] / Math.max(1, c.k.unseenTotal);
  } else {
    // public view: the deck's cards minus the pile and the own hand
    const deck = matchDeck(c.m);
    const seen = [...r.discard, ...c.hand];
    const total = deck.length - seen.length;
    const ofColor = deck.filter((x) => x.face.color === prevColor).length - seen.filter((x) => x.face.color === prevColor).length;
    frac = Math.max(0, ofColor) / Math.max(1, total);
  }
  const pHeld = 1 - Math.pow(1 - frac, n);
  const bar = c.level >= 3 ? (canStack ? 0.62 : 0.45) : canStack ? 0.72 : 0.55;
  return pHeld > bar;
}

/** the turn move for normal / hard (with the ¡Ku! flag and partnerPass give added) */
export function decideTurn(c: Ctx, turn: Move[]): Move {
  // never hurt the partner (penalty / skip / stack onto it) while anything else is possible
  const safe = c.m.teams ? turn.filter((mv) => !hitsPartner(c, mv)) : turn;
  const options = safe.length ? safe : turn;
  let best = options[0];
  let bestScore = -Infinity;
  const noise = noiser(c);
  for (const mv of options) {
    const sc = scoreTurn(c, mv) + noise(mv);
    if (sc > bestScore) {
      bestScore = sc;
      best = mv;
    }
  }
  return finishPlay(c, best);
}

/** a play that penalises / skips the partner (going out is always fine) */
export function hitsPartner(c: Ctx, mv: Move): boolean {
  if (mv.kind !== 'play' || c.hand.length <= 1) return false;
  const card = c.hand.find((x) => x.id === mv.cardId);
  if (!card) return false;
  const k = card.face.kind;
  if (!(c.r.pendingDraw > 0 || isPenaltyCard(card) || k === 'skip' || (k === 'reverse' && c.twoPlayers))) return false;
  const next = stepSeat(c.m, c.r, c.seat);
  return next !== c.seat && !opponents(c.m, c.seat, next);
}

/**
 * How many cards of a multi-play group (`max` of them, the opening card included) the CPU puts down.
 * Numbers: all (dumping cards is nearly always good). +2s: all onto an opponent, just the one onto the
 * partner. Skips (and reverses between two players, which skip): the count whose turn lands best, back on
 * the CPU or its partner, more cards breaking ties, skipping the partner costs. Reverses: an odd count, so
 * the direction still turns as the CPU chose.
 */
function multiCount(c: Ctx, kind: string, max: number): number {
  if (kind === 'number') return max;
  const nx = stepSeat(c.m, c.r, c.seat);
  if (kind === 'draw2') return nx !== c.seat && !opponents(c.m, c.seat, nx) ? 1 : max;
  if (kind === 'reverse' && !c.twoPlayers) return max % 2 ? max : max - 1;
  let best = 1;
  let bestV = -Infinity;
  for (let k = 1; k <= max; k++) {
    let s = c.seat;
    let v = k;
    for (let i = 0; i < k; i++) {
      s = stepSeat(c.m, c.r, s);
      if (s !== c.seat && !opponents(c.m, c.seat, s)) v -= 2 * c.w.partner;
    }
    const land = stepSeat(c.m, c.r, s);
    if (land === c.seat) v += 4;
    else if (!opponents(c.m, c.seat, land)) v += 3 * c.w.partner;
    if (v >= bestV) {
      bestV = v;
      best = k;
    }
  }
  return best;
}

/**
 * Multi-play rules: put other cards of the group down with this one (the same number, multiPlay; more
 * +2 / reverse / skip cards, multiDraw2 / multiReverse / multiSkip; how many: multiCount; easy now and then
 * plays just the one). The order puts the colour the CPU wants in play last: the colour it keeps most cards
 * of, and (hard) one the next opponent showed it cannot follow. When that card is the one picked to open
 * the play, another card of the group opens instead if it also fits the pile.
 */
export function addMulti(c: Ctx, mv: Move): Move {
  if (mv.kind !== 'play' || mv.extra?.length) return mv;
  const opts = multiPlayOptions(c.m, mv);
  if (!opts.length) return mv;
  if (c.level === 1 && c.rng.next() < 0.3) return mv;
  const first = c.hand.find((x) => x.id === mv.cardId);
  if (!first) return mv;
  const all = [first, ...opts.map((id) => c.hand.find((x) => x.id === id)!)];
  const n = multiCount(c, first.face.kind, all.length);
  if (n <= 1) return mv;
  const nx = stepSeat(c.m, c.r, c.seat);
  const want = (x: Card, rest: readonly Card[]): number => {
    const col = x.face.color;
    if (!col) return -1;
    let v = colorCount(rest, col) * 10;
    if (c.k && nx !== c.seat && opponents(c.m, c.seat, nx) && c.k.voids[nx] & bit(col)) v += 6;
    return v;
  };
  // fewer than all: keep the cards of the colours the CPU holds least of (the opening card stays)
  let group = all;
  if (n < all.length) {
    const others = c.hand.filter((x) => !all.includes(x));
    const extra = all.slice(1).sort((a, b) => want(a, others) - want(b, others));
    group = [first, ...extra.slice(0, n - 1)];
  }
  const rest = c.hand.filter((x) => !group.includes(x));
  const best = (xs: Card[]): Card => xs.reduce((a, b) => (want(b, rest) > want(a, rest) ? b : a));
  let lead = first;
  let last = best(group);
  if (last === first) {
    const alt = group.find((x) => x !== first && canPlay(x, c.r, c.m.rules));
    if (alt) lead = alt;
    else last = best(group.filter((x) => x !== first));
  }
  const mid = group.filter((x) => x !== lead && x !== last);
  return { ...mv, cardId: lead.id, extra: [...mid, last].map((x) => x.id) };
}

/** add multiPlay extras, `ku: true` on the second-to-last card, and a partnerPass gift when the engine accepts one */
export function finishPlay(c: Ctx, mv0: Move): Move {
  if (mv0.kind !== 'play') return mv0;
  const { m, r, seat, hand } = c;
  const multi = addMulti(c, mv0);
  const mv = isLegal(m, multi) ? multi : mv0;
  if (mv.kind !== 'play') return mv;
  let out: Move = mv;
  const card = hand.find((x) => x.id === mv.cardId);
  if (card && m.teams && m.rules.partnerPass && !m.rules.sevenZero && card.face.kind === 'number' && card.face.value === 7 && extra(mv).give === undefined && c.level >= 2) {
    const gift = pickGift(c, card, mv.extra ?? []);
    if (gift !== null) {
      const cand = { ...mv, give: gift } as Move;
      if (isLegal(m, cand) && scoreTurn(c, cand) > scoreTurn(c, mv)) out = cand;
    }
  }
  const left = hand.length - 1 - (extra(out).give !== undefined ? 1 : 0) - (mv.extra?.length ?? 0);
  if (m.rules.kuCall && left === 1 && !r.kuCalled[seat]) {
    const forget = c.w.kuEarly ? 0 : c.level > 2 ? (c.slip ? HARD_W.forgetKu : 0) : c.level === 2 ? NORMAL_W.forgetKu : c.w === STYLE_WEIGHTS.impulsive ? IMPULSIVE_FORGET_KU : EASY_FORGET_KU;
    if (!forget || c.rng.next() >= forget) out = { ...out, ku: true } as Move;
  }
  return out;
}

function pickGift(c: Ctx, seven: Card, gone: readonly number[] = []): number | null {
  const rest = c.hand.filter((x) => x !== seven && !gone.includes(x.id));
  if (rest.length < 2) return null;
  let best: Card | null = null;
  let bestV = -Infinity;
  for (const x of rest) {
    let v = cardPoints(x.face) * 0.1 - (x.face.color ? colorCount(rest, x.face.color) : 3);
    if (c.k?.pHand && x.face.color && colorCount(c.k.pHand, x.face.color) > 0) v += 2;
    if (isWildCard(x)) v -= 4;
    if (v > bestV) {
      bestV = v;
      best = x;
    }
  }
  return best ? best.id : null;
}

/** off-turn jump-ins (normal / hard) */
export function decideJump(c: Ctx, jumps: Move[], callMv: Move | undefined): Move | null {
  let best: Move | null = null;
  let bestScore = -20;
  for (const mv of jumps) {
    const sc = scoreTurn(c, mv) + c.rng.next() * 0.5;
    if (sc > bestScore) {
      bestScore = sc;
      best = mv;
    }
  }
  if (best && callMv && c.hand.length === 2) return callMv; // shout first, then jump in
  return best;
}

export function chooseEasy(c: Ctx, legal: Move[], style?: PlayStyle): Move | null {
  const pre = decidePre(c, legal);
  if (pre !== undefined) return pre;
  const { r, seat, rng } = c;
  const turn = legal.filter(isTurnMove);
  const callMv = legal.find((x) => x.kind === 'callKu');
  if (turn.length) {
    const plays = turn.filter((x) => x.kind === 'play');
    // a draw that cannot bring a card would just repeat the same state (and the same seeded choice)
    const others = turn.filter((x) => x.kind !== 'play' && !(x.kind === 'draw' && plays.length && nothingToDraw(r)));
    const byCard = new Map<number, Move[]>();
    for (const mv of plays) {
      if (mv.kind !== 'play') continue;
      const list = byCard.get(mv.cardId);
      if (list) list.push(mv);
      else byCard.set(mv.cardId, [mv]);
    }
    const cards = [...byCard.values()];
    const cardOf = (g: Move[]) => c.hand.find((x) => g[0].kind === 'play' && x.id === g[0].cardId)!;
    let pick: Move[];
    if (!cards.length || (others.length && rng.next() >= 0.85)) pick = others.length ? [others[rng.int(others.length)]] : cards[rng.int(cards.length)];
    else if (style === 'carefree') pick = cards[0];
    else if (style === 'impulsive') {
      const nums = cards.filter((g) => cardOf(g).face.kind === 'number');
      pick = nums.length ? nums.reduce((a, b) => ((cardOf(b).face.value ?? 0) > (cardOf(a).face.value ?? 0) ? b : a)) : cards[rng.int(cards.length)];
    } else if (style === 'beginner') {
      const wilds = cards.filter((g) => isWildCard(cardOf(g)));
      const same = cards.filter((g) => cardOf(g).face.color === r.activeColor);
      pick = wilds.length ? wilds[0] : same.length ? same[rng.int(same.length)] : cards[rng.int(cards.length)];
    } else pick = cards[rng.int(cards.length)];
    return finishPlay(c, pick[rng.int(pick.length)]);
  }
  const jumps = legal.filter((x) => x.kind === 'jumpIn');
  if (jumps.length && rng.next() < 0.5) {
    if (callMv && c.hand.length === 2 && rng.next() >= EASY_FORGET_KU && !r.kuCalled[seat]) return callMv;
    return jumps[rng.int(jumps.length)];
  }
  return null;
}

/** normal / hard: the whole decision */
export function chooseHeuristic(c: Ctx, legal: Move[]): Move | null {
  const pre = decidePre(c, legal);
  if (pre !== undefined) return pre;
  const turn = legal.filter(isTurnMove);
  if (turn.length) return decideTurn(c, turn);
  const jumps = legal.filter((x) => x.kind === 'jumpIn');
  if (jumps.length) return decideJump(c, jumps, legal.find((x) => x.kind === 'callKu'));
  return null;
}
