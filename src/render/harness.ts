/**
 * Dev harness (harness.html): mounts the card table and drives it with scripted GameEvents built from a
 * real dealt round (engine createMatch / startRound). No applyMove: the rules engine may still be a stub.
 */
import { createTableView, type TableViewExt } from './index';
import { createMatch, startRound, buildDeck, matches, DEFAULT_RULES } from '../engine';
import type { CardBack, Card, CardFace, Color, GameEvent, Quality, RoundState, Seat, SeatPlate, SfxName, TableStyle } from '../contracts';
import { initAudio, playSfx } from '../audio/sfx';

initAudio({ sound: true, music: false, vibration: false });

if (!/[?&]perf=1/.test(location.search)) {
  const u = new URL(location.href);
  u.searchParams.set('perf', '1');
  history.replaceState(null, '', u);
}

const app = document.getElementById('app')!;
const logEl = document.getElementById('log')!;
let msg = '';
const log = (s: string) => {
  msg = s;
  paintLog();
};
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const RULES = { ...DEFAULT_RULES, 'power.swap': true, 'power.shield': true, 'power.sweep': true, 'power.mirror': true };
const SEATS: Record<number, Seat[]> = { 2: [0, 2], 3: [0, 1, 3], 4: [0, 1, 2, 3] };
const COLORS: Color[] = ['sol', 'mar', 'palma', 'coral'];

let view: TableViewExt;
let seats: Seat[] = SEATS[4];
let round: RoundState | null = null;
let deckAll: Card[] = [];
let run = 0;
let sfxLast = '';
const plateEls: HTMLDivElement[] = [];

function paintLog() {
  const idle = view && !(view as unknown as { frameScheduled: boolean }).frameScheduled;
  logEl.textContent = `${msg}\nloop: ${idle ? 'idle' : 'running'}   sfx: ${sfxLast}`;
}
setInterval(paintLog, 300);

function drawPlates(plates: readonly SeatPlate[]) {
  for (const el of plateEls) el.style.display = 'none';
  plates.forEach((p, i) => {
    let el = plateEls[i];
    if (!el) {
      el = plateEls[i] = document.createElement('div');
      el.className = 'plate';
      app.appendChild(el);
    }
    el.style.display = p.visible ? 'flex' : 'none';
    el.style.left = `${p.x - p.w / 2}px`;
    el.style.top = `${p.y - p.h / 2}px`;
    el.style.width = `${p.w}px`;
    el.style.height = `${p.h}px`;
    el.style.transform = `scale(${p.scale})`;
    el.style.flexDirection = p.layout === 'stack' ? 'column' : 'row';
    el.className = `plate${p.active ? ' active' : ''}${p.winner ? ' winner' : ''}`;
    el.innerHTML = `${['Tú', 'Yuni', 'Pancho', 'Mayelín'][p.seat] ?? 'P' + p.seat} <b>${p.count}</b>`;
  });
}

function mount() {
  view?.dispose();
  for (const el of plateEls.splice(0)) el.remove();
  view = createTableView({
    container: app,
    quality: $<HTMLSelectElement>('sQ').value as Quality,
    speed: Number($<HTMLSelectElement>('sSpeed').value),
    tableStyle: $<HTMLSelectElement>('sTable').value as TableStyle,
    cardBack: $<HTMLSelectElement>('sBack').value as CardBack,
    reducedMotion: $<HTMLInputElement>('cReduced').checked,
    seats,
    onSfx: (n) => {
      sfxLast = n;
      playSfx(n);
    },
    onPlates: drawPlates,
    onError: (e) => console.error('[harness] fatal', e),
  });
  (window as unknown as { view: unknown }).view = view;
  if (teams && seats.length === 4) view.setTeams(teams);

  round = null;
}

const rnd = <T>(a: readonly T[]): T => a[Math.floor(Math.random() * a.length)];
const top = (): Card => round!.discard[round!.discard.length - 1];
const opps = () => seats.filter((s) => s !== 0 && !round!.eliminated[s]);
let openSeat: Seat | null = null;
async function send(e: GameEvent) {
  await view.handle(e);
  if (openSeat !== null && round) view.setOpenHand(openSeat, round.hands[openSeat].slice());
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let synthId = 5000;
const synth = (face: CardFace): Card => {
  const c = { id: synthId++, face };
  deckAll.push(c);
  view.setDeck([c]);
  return c;
};
const nextSeat = (s: Seat): Seat => {
  const live = seats.filter((x) => !round!.eliminated[x]);
  return live[(live.indexOf(s) + round!.direction + live.length) % live.length];
};
function need(): boolean {
  if (!round) log('deal first');
  return !!round;
}
function popDeck(): Card {
  if (!round!.deck.length) {
    const t = round!.discard.pop()!;
    round!.deck = round!.discard.splice(0).reverse();
    round!.discard = [t];
  }
  return round!.deck.pop()!;
}
function playable(seat: Seat): Card[] {
  return round!.hands[seat].filter((c) => matches(c, top(), round!.activeColor));
}
async function play(seat: Seat, card: Card) {
  const r = round!;
  r.hands[seat] = r.hands[seat].filter((c) => c.id !== card.id);
  r.discard.push(card);
  const color = card.face.color ?? rnd(COLORS);
  r.activeColor = color;
  await send({ type: 'play', seat, card, color: card.face.color ? undefined : color });
  if (r.hands[seat].length === 1) await send({ type: 'ku', seat });
}

async function deal() {
  run++;
  openSeat = null;
  pen = null;
  const players = seats.length as 2 | 3 | 4;
  const m0 = createMatch(RULES, { mode: 'action', players }, (Math.random() * 1e9) | 0);
  deckAll = buildDeck(m0.rules);
  view.setDeck(deckAll);
  const { match, events } = startRound(m0);
  round = structuredClone(match.round!);
  for (const e of events) {
    if (e.type === 'deal') await send({ ...e, hand: round.hands[0], deck: round.deck.length } as GameEvent);
    else await send(e);
  }
  log(`dealt ${players}p · hand ${round.hands[0].length} · deck ${round.deck.length}`);
}

async function humanPick() {
  if (!need()) return;
  const my = ++run;
  view.setTurn(0);
  const ok = playable(0).map((c) => c.id);
  log(`your pick: ${ok.length} playable (tap / drag up, or tap the deck)`);
  const v = await view.requestHumanPick(ok, true);
  if (my !== run) return;
  if (v === 'draw') {
    const c = popDeck();
    round!.hands[0].push(c);
    await send({ type: 'draw', seat: 0, count: 1, cards: [c], reason: 'turn' });
    log('you drew');
  } else {
    const card = round!.hands[0].find((c) => c.id === v)!;
    await play(0, card);
    log(`you played #${v}`);
  }
}

async function humanRandom() {
  if (!need()) return;
  view.cancelHumanPick();
  const cs = playable(0);
  const card = cs.length ? rnd(cs) : rnd(round!.hands[0]);
  if (!card) return log('empty hand');
  view.setTurn(0);
  await play(0, card);
}

async function oppPlays() {
  if (!need()) return;
  view.cancelHumanPick();
  for (const s of opps()) {
    view.setTurn(s);
    await send({ type: 'turn', seat: s });
    const cs = playable(s);
    if (cs.length) await play(s, rnd(cs));
    else {
      const c = popDeck();
      round!.hands[s].push(c);
      await send({ type: 'draw', seat: s, count: 1, reason: 'turn' });
    }
  }
  view.setTurn(0);
}

async function draws() {
  if (!need()) return;
  view.cancelHumanPick();
  const cs = [popDeck(), popDeck()];
  round!.hands[0].push(...cs);
  await send({ type: 'draw', seat: 0, count: 2, cards: cs, reason: 'turn' });
  const s = rnd(opps());
  if (s !== undefined) {
    round!.hands[s].push(popDeck());
    await send({ type: 'draw', seat: s, count: 1, reason: 'turn' });
  }
}

async function stack() {
  if (!need()) return;
  view.cancelHumanPick();
  const w4 = deckAll.filter((c) => c.face.kind === 'wild4');
  const [a, b] = opps();
  let total = 0;
  for (const s of [a, b ?? a]) {
    const card = w4[total / 4] ?? w4[0];
    total += 4;
    round!.hands[s].push(card);
    await play(s, card);
    await send({ type: 'stack', total });
  }
  const cs = Array.from({ length: total }, () => popDeck());
  round!.hands[0].push(...cs);
  await send({ type: 'draw', seat: 0, count: total, cards: cs, reason: 'penalty' });
}

async function swap() {
  if (!need()) return;
  view.cancelHumanPick();
  const o = seats.includes(2) ? 2 : opps()[0];
  const r = round!;
  [r.hands[0], r.hands[o]] = [r.hands[o], r.hands[0]];
  await send({ type: 'swapHands', a: 0, b: o, cards: r.hands[0] } as GameEvent);
}

async function rotate() {
  if (!need()) return;
  view.cancelHumanPick();
  const r = round!;
  const live = seats.filter((s) => !r.eliminated[s]);
  const old = live.map((s) => r.hands[s]);
  live.forEach((s, i) => (r.hands[live[(i + 1) % live.length]] = old[i]));
  await send({ type: 'rotateHands', direction: 1, cards: r.hands[0] } as GameEvent);
}

async function sweep() {
  if (!need()) return;
  view.cancelHumanPick();
  const s = rnd(opps());
  const r = round!;
  const col = r.hands[s].find((c) => c.face.color)?.face.color ?? 'sol';
  const sw = deckAll.find((c) => c.face.kind === 'sweep' && c.face.color === col)!;
  r.hands[s].push(sw);
  await play(s, sw);
  const ids = r.hands[s].filter((c) => c.face.color === col).map((c) => c.id);
  r.hands[s] = r.hands[s].filter((c) => !ids.includes(c.id));
  r.discard.splice(r.discard.length - 1, 0, ...deckAll.filter((c) => ids.includes(c.id)));
  await send({ type: 'sweep', seat: s, cardIds: ids });
  log(`seat ${s} swept ${ids.length} ${col}`);
}

async function reshuffle() {
  if (!need()) return;
  const r = round!;
  const t = r.discard.pop()!;
  r.deck = r.discard.splice(0).concat(r.deck);
  r.discard = [t];
  await send({ type: 'reshuffle', count: r.deck.length });
}

async function eliminate() {
  if (!need()) return;
  const s = rnd(opps());
  if (s === undefined) return;
  round!.deck.unshift(...round!.hands[s]);
  round!.hands[s] = [];
  round!.eliminated[s] = true;
  await send({ type: 'eliminated', seat: s });
}

// ───────── phase 4/5 visuals ─────────

let teams: [Seat[], Seat[]] | null = null;
function partner(): Seat {
  const mine = teams?.find((t) => t.includes(0));
  const p = mine?.find((s) => s !== 0);
  if (p !== undefined) return p;
  return seats.includes(2) ? 2 : opps()[0];
}

function toggleOpen() {
  if (!need()) return;
  const p = partner();
  openSeat = openSeat === null ? p : null;
  view.setOpenHand(p, openSeat === null ? null : round!.hands[p].slice());
  log(openSeat === null ? 'partner hand closed' : `seat ${p} hand open`);
}

const TEAM_SETS: { label: string; teams: [Seat[], Seat[]] | null }[] = [
  { label: 'Teams: none', teams: null },
  { label: 'Teams: Enfrente', teams: [[0, 2], [1, 3]] },
  { label: 'Teams: Codo R (0+1)', teams: [[0, 1], [2, 3]] },
  { label: 'Teams: Codo L (0+3)', teams: [[0, 3], [1, 2]] },
];
let teamIdx = 0;
function applyTeams(i: number) {
  teamIdx = i % TEAM_SETS.length;
  teams = seats.length === 4 ? TEAM_SETS[teamIdx].teams : null;
  $('bTeams').textContent = TEAM_SETS[teamIdx].label;
  view.setTeams(teams);
  if (openSeat !== null && round) {
    const p = partner();
    if (p !== openSeat) {
      view.setOpenHand(openSeat, null);
      openSeat = p;
      view.setOpenHand(p, round.hands[p].slice());
    }
  }
}
function toggleTeams() {
  applyTeams(teamIdx + 1);
}

/** side-seating partners deal with a 20-card own hand and a 14-card open partner hand */
let sideFlip = false;
async function sideDeal() {
  if (seats.length !== 4) {
    seats = SEATS[4];
    $<HTMLSelectElement>('sPlayers').value = '4';
    mount();
  }
  sideFlip = !sideFlip;
  // Codo a codo is landscape-only in the app
  if (app.className !== 'phoneL' && !/[?&]frame=/.test(location.search)) {
    app.className = 'phoneL';
    $<HTMLSelectElement>('sFrame').value = 'phoneL';
  }
  applyTeams(sideFlip ? 2 : 3);
  await deal();
  const p = partner();
  const mine = Array.from({ length: 13 }, () => popDeck());
  round!.hands[0].push(...mine);
  await send({ type: 'draw', seat: 0, count: mine.length, cards: mine, reason: 'turn' });
  const ps = Array.from({ length: 7 }, () => popDeck());
  round!.hands[p].push(...ps);
  await send({ type: 'draw', seat: p, count: ps.length, cards: ps, reason: 'turn' });
  openSeat = p;
  view.setOpenHand(p, round!.hands[p].slice());
  log(`Codo a codo ${sideFlip ? 'R' : 'L'}: partner seat ${p} (${round!.hands[p].length}), you ${round!.hands[0].length}. Hover / touch to peek`);
}

let pen: { src: Seat; victim: Seat; total: number } | null = null;
async function penaltyWindow(kind: 'wild4' | 'draw2' = 'wild4') {
  if (!need()) return;
  view.cancelHumanPick();
  const src = opps()[0];
  const victim = nextSeat(src);
  const card = synth(kind === 'wild4' ? { kind: 'wild4', color: null, draw: 4 } : { kind: 'draw2', color: round!.activeColor, draw: 2 });
  round!.hands[src].push(card);
  await play(src, card);
  pen = { src, victim, total: kind === 'wild4' ? 4 : 2 };
  await send({ type: 'window', window: { reason: 'penalty', seats: [victim], victim } });
  log(`penalty window: seat ${victim} may answer +${kind === 'wild4' ? 4 : 2} (Shield / Mirror / Take)`);
}
async function takePenalty() {
  if (!pen) await penaltyWindow();
  if (!pen) return;
  const { victim, total } = pen;
  pen = null;
  const cs = Array.from({ length: total }, () => popDeck());
  round!.hands[victim].push(...cs);
  await send({ type: 'window', window: null });
  await send({ type: 'draw', seat: victim, count: total, cards: cs, reason: 'penalty' });
}
async function shield() {
  if (!pen) {
    await penaltyWindow();
    await sleep(700);
  }
  if (!pen) return;
  const { victim } = pen;
  pen = null;
  await send({ type: 'shield', seat: victim });
  await send({ type: 'window', window: null });
}
async function mirror() {
  if (!pen) {
    await penaltyWindow();
    await sleep(700);
  }
  if (!pen) return;
  const { src, victim, total } = pen;
  await send({ type: 'mirror', from: victim, to: src, total });
  pen = { src: victim, victim: src, total };
  await send({ type: 'window', window: { reason: 'penalty', seats: [], victim: src } });
  log(`mirrored: seat ${src} now faces +${total} (Take)`);
}

async function skipAll() {
  if (!need()) return;
  view.cancelHumanPick();
  const card = synth({ kind: 'skipAll', color: round!.activeColor });
  round!.hands[0].push(card);
  await play(0, card);
  for (const s of opps()) await send({ type: 'skip', seat: s });
}

async function wildColor() {
  if (!need()) return;
  view.cancelHumanPick();
  const src = opps()[0];
  const victim = nextSeat(src);
  const card = synth({ kind: 'wildColor', color: null });
  const want = rnd(COLORS);
  round!.discard.push(card);
  round!.activeColor = want;
  await send({ type: 'play', seat: src, card, color: want });
  const cs: Card[] = [];
  for (let k = 0; k < 14; k++) {
    const c = popDeck();
    cs.push(c);
    if (c.face.color === want) break;
  }
  round!.hands[victim].push(...cs);
  await send({ type: 'draw', seat: victim, count: cs.length, cards: cs, reason: 'penalty' });
  log(`seat ${victim} drew ${cs.length} until ${want}`);
}

async function cycloneHand() {
  if (!need()) return;
  view.cancelHumanPick();
  const col = round!.activeColor;
  const faces: CardFace[] = [
    { kind: 'skipAll', color: col }, { kind: 'draw6', color: col, draw: 6 }, { kind: 'skipAll', color: rnd(COLORS) },
    { kind: 'draw6', color: rnd(COLORS), draw: 6 }, { kind: 'draw10', color: null, draw: 10 }, { kind: 'wildColor', color: null },
  ];
  const cs = faces.map(synth);
  round!.hands[0].push(...cs);
  await send({ type: 'draw', seat: 0, count: cs.length, cards: cs, reason: 'turn' });
  const p = partner();
  const cp = [synth({ kind: 'draw10', color: null, draw: 10 }), synth({ kind: 'skipAll', color: rnd(COLORS) })];
  round!.hands[p].push(...cp);
  await send({ type: 'draw', seat: p, count: cp.length, cards: cp, reason: 'turn' });
}

async function kuMoment() {
  if (!need()) return;
  view.cancelHumanPick();
  const s = rnd(seats.filter((x) => !round!.eliminated[x]));
  const h = round!.hands[s];
  if (h.length > 1) {
    const ids = h.slice(1).map((c) => c.id);
    round!.hands[s] = h.slice(0, 1);
    round!.discard.splice(round!.discard.length - 1, 0, ...deckAll.filter((c) => ids.includes(c.id)));
    await send({ type: 'sweep', seat: s, cardIds: ids });
  }
  await send({ type: 'ku', seat: s });
  log(`ku moment: seat ${s}`);
}

async function caught() {
  if (!need()) return;
  const t = rnd(opps());
  if (t === undefined) return;
  await send({ type: 'kuCaught', by: 0, target: t });
  const cs = [popDeck(), popDeck()];
  round!.hands[t].push(...cs);
  await send({ type: 'draw', seat: t, count: 2, cards: cs, reason: 'catch' });
}

const SOUNDS: SfxName[] = ['clack', 'slam', 'thump', 'deal', 'draw', 'shuffle', 'pass', 'select', 'invalid', 'charge', 'ku', 'shield', 'mirror', 'winHand', 'loseHand', 'winMatch', 'loseMatch', 'tranque'];
const sndBar = document.getElementById('snd');
if (sndBar)
  for (const n of SOUNDS) {
    const b = document.createElement('button');
    b.textContent = n;
    b.addEventListener('click', () => {
      sfxLast = n;
      playSfx(n);
    });
    sndBar.appendChild(b);
  }

const on = (id: string, fn: () => unknown) => $(id).addEventListener('click', () => void fn());
on('bDeal', deal);
on('bPick', humanPick);
on('bPlay', humanRandom);
on('bOpp', oppPlays);
on('bDraw', draws);
on('bStack', stack);
on('bSkip', () => need() && send({ type: 'skip', seat: rnd(seats) }));
on('bRev', () => {
  if (!need()) return;
  round!.direction = round!.direction === 1 ? -1 : 1;
  return send({ type: 'reverse', direction: round!.direction });
});
on('bSwap', swap);
on('bRot', rotate);
on('bSweep', sweep);
on('bKu', kuMoment);
on('bCaught', caught);
on('bOpen', toggleOpen);
on('bTeams', toggleTeams);
on('bSideDeal', sideDeal);
on('bPen', () => penaltyWindow());
on('bTake', takePenalty);
on('bShield', shield);
on('bMirror', mirror);
on('bSkipAll', skipAll);
on('bWildColor', wildColor);
on('bCyclone', cycloneHand);
on('bShuffle', reshuffle);
on('bOut', eliminate);
on('bEnd', () => need() && send({ type: 'roundEnd', winner: rnd(seats), points: [0, 0, 0, 0] }));
on('bReset', () => {
  run++;
  round = null;
  openSeat = null;
  pen = null;

  view.reset();
});
on('bRestore', async () => {
  if (!need()) return;
  await view.restore({ round: structuredClone(round!), seats });
  log('restored');
});
$<HTMLSelectElement>('sPlayers').addEventListener('change', (e) => {
  seats = SEATS[Number((e.target as HTMLSelectElement).value)];
  mount();
});
$<HTMLSelectElement>('sFrame').addEventListener('change', (e) => (app.className = (e.target as HTMLSelectElement).value));
$<HTMLSelectElement>('sQ').addEventListener('change', (e) => view.setQuality((e.target as HTMLSelectElement).value as Quality));
$<HTMLSelectElement>('sSpeed').addEventListener('change', (e) => view.setSpeed(Number((e.target as HTMLSelectElement).value)));
$<HTMLSelectElement>('sTable').addEventListener('change', (e) => view.setTableStyle((e.target as HTMLSelectElement).value as TableStyle));
$<HTMLSelectElement>('sBack').addEventListener('change', (e) => view.setCardBack((e.target as HTMLSelectElement).value as CardBack));
$<HTMLInputElement>('cReduced').addEventListener('change', (e) => view.setReducedMotion((e.target as HTMLInputElement).checked));

const qs = new URLSearchParams(location.search);
if (qs.get('frame')) {
  app.className = qs.get('frame')!;
  $<HTMLSelectElement>('sFrame').value = qs.get('frame')!;
}
if (qs.get('q')) $<HTMLSelectElement>('sQ').value = qs.get('q')!;
mount();
if (qs.get('demo') === 'deal') void deal();
