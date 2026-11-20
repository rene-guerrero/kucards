/**
 * KuCards table music: a breezy generative bossa-lounge loop in D major. Soft electric-piano
 * comping, a round two-feel bass, a shaker, and a marimba that improvises short call-and-answer
 * motifs. Pure WebAudio, no asset files, original material only.
 *
 * Form: 8-bar sections (~16 s). Each section picks one of four jazz progressions, a comping
 * rhythm, whether the marimba plays, and a fresh motif — so the loop never repeats literally.
 * `musicLift()` (fired on a ¡Ku!) adds a few bars of extra drive.
 *
 * `setMusicMode('frenzy')` (final minute of a timed round) swaps, at the next bar line, to an
 * urgent variation of the same piece: 150 BPM on a 16th grid, four-on-the-floor kick, backbeat
 * clap, octave-pumping bass, short stabs over a rising B-minor sequence and a marimba ostinato.
 *
 * `setMode('menu')` is the title theme, a separate piece: a mellow lo-fi groove at 88 BPM in
 * Bb major on a swung 16th grid. Warm pad, soft keys, round bass, brushed backbeat, and a fixed
 * pentatonic call-and-answer hook on a bell-like key (a nod to the table marimba, not a copy).
 * 8-bar sections vary the progression, comping, drums (breakdowns) and the hook's register.
 * Its voices run through their own bus, faded out when the game music takes over.
 */
let timer: number | null = null;
let out: GainNode | null = null;
let compBus: BiquadFilterNode | null = null;
let shakeBus: BiquadFilterNode | null = null;
let menuBus: GainNode | null = null; // every sustained menu voice, so the scene change can fade them
let menuLP: BiquadFilterNode | null = null; // pad + keys
let brushBus: BiquadFilterNode | null = null;
let noise: AudioBuffer | null = null;
let nextTime = 0;
let step = 0; // 8th notes since start
let liftUntilBar = 0;
export type MusicMode = 'menu' | 'normal' | 'frenzy';
let mode: MusicMode = 'menu'; // what is sounding
let want: MusicMode = 'menu'; // what was asked for; applied at the next bar line (or on start)

const BPM = 118;
const S8 = 60 / BPM / 2; // eighth note
const KEY = 50; // D3 (midi)
const hz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

type Quality = 'maj' | 'min' | 'dom';
type Chord = [root: number, q: Quality];
/** rootless comping voicing (3rd, 5th/7th, 9th) and the pentatonic the marimba draws from */
const VOICING: Record<Quality, number[]> = { maj: [4, 7, 11, 14], min: [3, 7, 10, 14], dom: [4, 10, 14, 21] };
const MELODY: Record<Quality, number[]> = { maj: [0, 2, 4, 7, 9], min: [0, 3, 5, 7, 10], dom: [0, 2, 4, 7, 9] };
const PROGS: Chord[][] = [
  [[0, 'maj'], [9, 'min'], [2, 'min'], [7, 'dom']], // Dmaj7 Bm7 Em7 A7
  [[5, 'maj'], [4, 'min'], [2, 'min'], [7, 'dom']], // Gmaj7 F#m7 Em7 A7
  [[4, 'min'], [9, 'dom'], [2, 'min'], [7, 'dom']], // F#m7 B7 Em7 A7
  [[9, 'min'], [2, 'dom'], [5, 'maj'], [7, 'dom']], // Bm7 E7 Gmaj7 A7
];
// two-bar comping rhythms on the 8th grid (classic bossa pushes)
const COMPS = [
  [0, 3, 6, 10, 13],
  [0, 3, 6, 9, 12],
  [1, 4, 7, 10, 13],
];
const WOOD = [0, 3, 6, 10, 12]; // soft rim pattern over two bars

// ── frenzy ──
const F16 = 60 / 150 / 4; // sixteenth note at 150 BPM
/** rising sequence in the relative minor, ending on its dominant: Bm7 C#m7 D E7 | Bm7 D E7 F#7 */
const FPROG: Chord[] = [[9, 'min'], [11, 'min'], [0, 'maj'], [4, 'dom'], [9, 'min'], [0, 'maj'], [4, 'dom'], [6, 'dom']];
const FCOMP = [0, 3, 6, 10, 13]; // stabs on the 16th grid
// marimba ostinato as pentatonic degrees (-1 = rest): three bars of A, then B as the answer
const OST_A = [0, -1, 2, 0, 3, -1, 2, -1, 0, -1, 2, 0, 4, -1, 3, 2];
const OST_B = [4, -1, 3, 2, -1, 3, 2, 0, 4, -1, 3, 2, -1, 5, 4, -1];

// ── menu ──
const M16 = 60 / 88 / 4; // sixteenth note at 88 BPM
const MKEY = 46; // Bb2
const MPROGS: Chord[][] = [
  [[0, 'maj'], [9, 'min'], [5, 'maj'], [7, 'dom']], // Bbmaj7 Gm7 Ebmaj7 F7
  [[5, 'maj'], [4, 'min'], [2, 'min'], [7, 'dom']], // Ebmaj7 Dm7 Cm7 F7
  [[9, 'min'], [2, 'min'], [5, 'maj'], [7, 'dom']], // Gm7 Cm7 Ebmaj7 F7
  [[0, 'maj'], [4, 'min'], [5, 'maj'], [10, 'maj']], // Bbmaj7 Dm7 Ebmaj7 Abmaj7 (backdoor home)
];
const MCOMPS = [
  [0, 6, 11],
  [0, 7, 10],
  [0, 3, 10],
];
const PENTA = [70, 72, 74, 77, 79, 82, 84, 86]; // Bb major pentatonic from Bb4
/** the hook, two bars each: [16th step, pentatonic degree, seconds] */
const HOOK_CALL = [[0, 2, 0.9], [3, 3, 0.5], [6, 4, 0.9], [10, 3, 0.5], [14, 2, 0.5], [16, 1, 1.2], [22, 0, 0.6], [24, 1, 1.1]];
const HOOK_ANS = [[0, 2, 0.9], [3, 3, 0.5], [6, 4, 0.9], [10, 5, 0.7], [14, 4, 0.5], [16, 3, 1.2], [22, 2, 0.6], [26, 1, 1.2]];
const msec = { prog: MPROGS[0], comp: MCOMPS[0], mel: 1, drums: true, first: true, home: false };
let lastMProg = 0;

function newMenuSection(first: boolean) {
  let p = first ? 0 : Math.floor(rnd() * MPROGS.length);
  if (!first && p === lastMProg) p = (p + 1 + Math.floor(rnd() * 3)) % MPROGS.length;
  lastMProg = p;
  msec.prog = MPROGS[p];
  msec.comp = pick(MCOMPS);
  msec.drums = first || !msec.drums || rnd() > 0.22; // an occasional breakdown, never two in a row
  // 0 = no hook, 1 = hook, 2 = hook an octave up with an echo; breakdowns always carry it
  msec.mel = first ? 1 : !msec.drums ? 2 : msec.mel === 0 || rnd() > 0.3 ? (rnd() < 0.3 ? 2 : 1) : 0;
  msec.first = first;
  msec.home = rnd() < 0.35; // the last answer resolves to the tonic
}

const section = { prog: PROGS[0], comp: COMPS[0], mel: false, wood: false, rhythm: [] as boolean[], contour: [] as number[] };
let lastProg = 0;

const rnd = Math.random;
const pick = <T>(a: T[]): T => a[Math.floor(rnd() * a.length)];

function newSection(first: boolean) {
  let p = first ? 0 : Math.floor(rnd() * PROGS.length);
  if (!first && p === lastProg && rnd() < 0.6) p = (p + 1) % PROGS.length;
  lastProg = p;
  section.prog = PROGS[p];
  section.comp = pick(COMPS);
  section.mel = first ? false : !section.mel || rnd() < 0.6; // never two melody-less sections in a row
  section.wood = !first && rnd() < 0.5;
  // two-bar motif: a rhythm and a stepwise contour, re-fitted to each chord as it passes
  let idx = 2 + Math.floor(rnd() * 4);
  for (let i = 0; i < 16; i++) {
    section.rhythm[i] = i < 13 && rnd() < (i % 2 === 0 ? 0.45 : 0.28); // leave a breath at the end
    idx = Math.max(0, Math.min(9, idx + pick([-2, -1, -1, 1, 1, 2])));
    section.contour[i] = idx;
  }
  section.rhythm[0] = section.rhythm[0] || rnd() < 0.5;
}

/** one enveloped oscillator: the only tonal building block */
function tone(ctx: AudioContext, dest: AudioNode, t: number, freq: number, type: OscillatorType, peak: number, attack: number, dur: number) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.value = freq;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(dest);
  o.start(t);
  o.stop(t + dur + 0.02);
}

function shake(ctx: AudioContext, t: number, peak: number, dur = 0.07, bus: AudioNode = shakeBus!) {
  const s = ctx.createBufferSource();
  s.buffer = noise;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  s.connect(g).connect(bus);
  s.start(t, rnd() * 0.2, dur + 0.02);
}

function kick(ctx: AudioContext, t: number, peak: number, dest: AudioNode = out!) {
  const o = ctx.createOscillator();
  o.frequency.setValueAtTime(130, t);
  o.frequency.exponentialRampToValueAtTime(48, t + 0.09);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
  o.connect(g).connect(dest);
  o.start(t);
  o.stop(t + 0.18);
}

/** fold a pitch class into [lo, lo+12) */
const fold = (m: number, lo: number) => lo + ((((m - lo) % 12) + 12) % 12);

function schedule(ctx: AudioContext) {
  const now = ctx.currentTime;
  if (nextTime < now - 0.2) nextTime = now + 0.05; // timer was throttled: skip ahead, don't burst
  while (nextTime < now + 0.3) {
    // mode changes land on a bar line; the old mode's tails ring out, nothing is doubled
    // (the menu groove also yields at its half bar, so a match never waits long for its music)
    if (want !== mode && step % (mode === 'frenzy' ? 16 : 8) === 0) {
      const g = menuBus!.gain;
      g.cancelScheduledValues(nextTime);
      g.setValueAtTime(1, nextTime);
      if (mode === 'menu') g.linearRampToValueAtTime(0, nextTime + 0.7); // pad and key tails are in Bb: fade them
      mode = want;
      step = 0;
      liftUntilBar = 0;
    }
    if (mode === 'frenzy') frenzyStep(ctx);
    else if (mode === 'menu') menuStep(ctx);
    else normalStep(ctx);
  }
}

function menuStep(ctx: AudioContext) {
  if (step % 128 === 0) newMenuSection(step === 0);
  const bar = Math.floor(step / 16);
  const sb = bar % 8; // bar within the section
  const s = step % 16;
  const [root, q] = msec.prog[bar % 4];
  const rootM = MKEY + root;
  const t = nextTime + (s % 2 ? M16 * 0.16 : 0) + rnd() * 0.008; // light swing
  const bus = menuBus!;
  const lp = menuLP!;

  // pad: a slow swell on every bar
  if (s === 0) for (let i = 0; i < 3; i++) tone(ctx, lp, t, hz(fold(rootM + VOICING[q][i], 58)), 'sawtooth', 0.03, 0.6, M16 * 16 + 0.5);

  // soft keys
  if (msec.comp.includes(s) && (s === 0 || rnd() > 0.12)) {
    const v = 0.034 + rnd() * 0.008;
    for (const n of VOICING[q]) tone(ctx, lp, t, hz(fold(rootM + n, 58)), 'triangle', v, 0.015, s === 0 ? 1.2 : 0.55);
  }

  // bass: root, fifth on 3, a chromatic approach into the next bar
  const bassHz = (m: number) => hz(fold(m, 39));
  if (s === 0) tone(ctx, bus, t, bassHz(rootM), 'sine', 0.3, 0.02, 0.9);
  else if (s === 8) tone(ctx, bus, t, bassHz(rootM + 7), 'sine', 0.22, 0.02, 0.6);
  else if (s === 6 && rnd() < 0.5) tone(ctx, bus, t, bassHz(rootM), 'sine', 0.14, 0.015, 0.25);
  else if (s === 14 && rnd() < 0.6) tone(ctx, bus, t, hz(fold(MKEY + msec.prog[(bar + 1) % 4][0], 39) - 1), 'sine', 0.13, 0.015, 0.22);

  // drums: lazy kick, brushed backbeat, quiet hats (the intro and breakdowns keep only off-beat hats)
  const drums = msec.drums && !(msec.first && sb < 2);
  if (drums) {
    if (s === 0 || s === 10 || (s === 7 && rnd() < 0.25)) kick(ctx, t, s === 0 ? 0.24 : 0.18, bus);
    if (s === 4 || s === 12) shake(ctx, t, 0.085, 0.17, brushBus!);
    else if (s === 15 && rnd() < 0.3) shake(ctx, t, 0.03, 0.1, brushBus!);
    if (s % 2 === 0) shake(ctx, t, s % 4 === 2 ? 0.034 : 0.018);
    else if (rnd() < 0.22) shake(ctx, t, 0.011);
  } else if (s % 4 === 2) shake(ctx, t, 0.022);

  // the hook: call (bars 1-2), answer (bars 3-4), twice a section; the very first section saves it for its second half
  if (msec.mel && !(msec.first && sb < 4)) {
    const pair = sb >> 1;
    const s32 = step % 32;
    for (const [at, deg, dur] of pair % 2 ? HOOK_ANS : HOOK_CALL) {
      if (at !== s32 || (at % 16 !== 0 && rnd() < 0.1)) continue;
      const up = msec.mel === 2;
      const m = PENTA[pair === 3 && at === 26 && msec.home ? 0 : deg] + (up ? 12 : 0);
      const v = (up ? 0.05 : 0.07) + rnd() * 0.012;
      tone(ctx, bus, t, hz(m), 'sine', v, 0.012, dur);
      tone(ctx, bus, t, hz(m) * 2, 'sine', v * 0.15, 0.004, 0.25);
      if (up) tone(ctx, bus, t + M16 * 3, hz(m), 'sine', v * 0.3, 0.012, dur * 0.8); // echo
    }
  }

  nextTime += M16;
  step++;
}

function frenzyStep(ctx: AudioContext) {
  const bar = Math.floor(step / 16);
  const s = step % 16;
  const [root, q] = FPROG[bar % 8];
  const rootM = KEY + root;
  const t = nextTime + rnd() * 0.003;
  const beat = s % 4 === 0;

  if (beat) kick(ctx, t, 0.3);
  // bass pumps in eighths: root on the beat, octave on the "and", a leading tone into the next bar
  if (s === 14) tone(ctx, out!, t, hz(fold(KEY + FPROG[(bar + 1) % 8][0], 35) + 11), 'sine', 0.16, 0.01, 0.15);
  else if (s % 2 === 0) tone(ctx, out!, t, hz(fold(rootM, 35) + (beat ? 0 : 12)), 'sine', beat ? 0.26 : 0.18, 0.01, 0.17);

  // shaker in 16ths with the off-beat eighths accented; clap on 2 and 4
  shake(ctx, t, s % 4 === 2 ? 0.055 : beat ? 0.03 : 0.016 + rnd() * 0.008);
  if (s === 4 || s === 12) {
    shake(ctx, t, 0.1);
    tone(ctx, out!, t, 1100, 'triangle', 0.045, 0.002, 0.07);
  }

  // short three-note stabs
  if (FCOMP.includes(s)) {
    for (let i = 0; i < 3; i++) tone(ctx, compBus!, t, hz(fold(rootM + VOICING[q][i], 57)), 'triangle', 0.036, 0.008, s === 0 ? 0.3 : 0.17);
  }

  // marimba ostinato: enters after two bars, gains an octave sparkle later so the minute keeps building
  const d = (bar % 4 === 3 ? OST_B : OST_A)[s];
  if (bar >= 2 && d >= 0) {
    const m = fold(rootM, 69) + MELODY[q][d % 5] + 12 * Math.floor(d / 5);
    const v = beat ? 0.075 : 0.055;
    tone(ctx, out!, t, hz(m), 'sine', v, 0.004, 0.24);
    if (beat) tone(ctx, out!, t, hz(m) * 4, 'sine', v * 0.16, 0.002, 0.07);
    if (bar >= 16 && s % 8 === 0) tone(ctx, out!, t, hz(m + 12), 'sine', v * 0.3, 0.004, 0.2);
  }

  nextTime += F16;
  step++;
}

function normalStep(ctx: AudioContext) {
  {
    if (step % 64 === 0) newSection(step === 0);
    const barNo = Math.floor(step / 8);
    const s = step % 8; // 8th within the bar
    const s2 = step % 16; // 8th within the two-bar pattern
    const [root, q] = section.prog[barNo % 4];
    const rootM = KEY + root;
    const lift = barNo < liftUntilBar;
    const t = nextTime + rnd() * 0.006;

    // electric-piano comp: four soft notes through a shared low-pass
    if (section.comp.includes(s2) && (rnd() > 0.1 || s2 === 0)) {
      const v = 0.03 + rnd() * 0.008 + (lift ? 0.008 : 0);
      for (const n of VOICING[q]) tone(ctx, compBus!, t, hz(fold(rootM + n, 57)), 'triangle', v, 0.012, s2 === 0 ? 0.9 : 0.42);
    }

    // bass: root on 1, fifth on 3, light pickups on the "ands"
    const bassHz = (m: number) => hz(fold(m, 38));
    if (s === 0) tone(ctx, out!, t, bassHz(rootM), 'sine', 0.3, 0.02, 0.55);
    else if (s === 4) tone(ctx, out!, t, bassHz(rootM + 7), 'sine', 0.24, 0.02, 0.45);
    else if (s === 3 && rnd() < 0.7) tone(ctx, out!, t, bassHz(rootM + 7), 'sine', 0.13, 0.015, 0.2);
    else if (s === 7 && rnd() < 0.6) tone(ctx, out!, t, bassHz(KEY + section.prog[(barNo + 1) % 4][0]), 'sine', 0.14, 0.015, 0.22);

    // shaker on every 8th, off-beats accented; a ghost 16th in between while lifted
    shake(ctx, t, (s % 2 === 1 ? 0.05 : 0.026) * (lift ? 1.5 : 1));
    if (lift) shake(ctx, t + S8 / 2, 0.022);
    if ((section.wood || lift) && WOOD.includes(s2)) tone(ctx, out!, t, 880, 'sine', 0.035, 0.002, 0.06);

    // marimba: the section's motif mapped onto the current chord's pentatonic
    if ((section.mel || lift) && section.rhythm[s2] && rnd() > 0.08) {
      const pcs = MELODY[q];
      const scale: number[] = [];
      for (let m = 69; m <= 90; m++) if (pcs.includes((((m - rootM) % 12) + 12) % 12)) scale.push(m);
      const m = scale[Math.min(scale.length - 1, section.contour[s2])];
      const v = 0.075 + rnd() * 0.02;
      tone(ctx, out!, t, hz(m), 'sine', v, 0.004, 0.5);
      tone(ctx, out!, t, hz(m) * 4, 'sine', v * 0.18, 0.002, 0.09); // marimba bar overtone
      if (lift) tone(ctx, out!, t, hz(m + 12), 'sine', v * 0.35, 0.004, 0.3);
    }

    nextTime += S8;
    step++;
  }
}

/** A few bars of extra drive (ghost shaker, rim, doubled marimba): call on a ¡Ku! moment. */
export function musicLift(bars = 4): void {
  if (timer !== null && mode === 'normal') liftUntilBar = Math.floor(step / 8) + bars;
}

/** Remembered while the music is off; applied at the next bar line while it plays. */
export function setMode(m: MusicMode): void {
  want = m;
}

export function startMusic(ctx: AudioContext, dest: AudioNode): void {
  if (timer !== null) return;
  out = ctx.createGain();
  out.gain.setValueAtTime(0.0001, ctx.currentTime);
  out.gain.exponentialRampToValueAtTime(0.8, ctx.currentTime + 2);
  out.connect(dest);
  compBus = ctx.createBiquadFilter();
  compBus.type = 'lowpass';
  compBus.frequency.value = 1500;
  compBus.connect(out);
  shakeBus = ctx.createBiquadFilter();
  shakeBus.type = 'highpass';
  shakeBus.frequency.value = 6000;
  shakeBus.connect(out);
  menuBus = ctx.createGain();
  menuBus.connect(out);
  menuLP = ctx.createBiquadFilter();
  menuLP.type = 'lowpass';
  menuLP.frequency.value = 1300;
  menuLP.connect(menuBus);
  brushBus = ctx.createBiquadFilter();
  brushBus.type = 'bandpass';
  brushBus.frequency.value = 2400;
  brushBus.Q.value = 0.7;
  brushBus.connect(menuBus);
  if (!noise || noise.sampleRate !== ctx.sampleRate) {
    noise = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.4), ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = rnd() * 2 - 1;
  }
  nextTime = ctx.currentTime + 0.1;
  step = 0;
  liftUntilBar = 0;
  mode = want;
  timer = window.setInterval(() => schedule(ctx), 100);
}

export function stopMusic(): void {
  if (timer === null) return;
  clearInterval(timer);
  timer = null;
  const o = out;
  if (o) {
    const c = o.context;
    o.gain.cancelScheduledValues(c.currentTime);
    o.gain.setValueAtTime(o.gain.value, c.currentTime);
    o.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.4);
    setTimeout(() => o.disconnect(), 600);
  }
  out = null;
  compBus = null;
  shakeBus = null;
  menuBus = menuLP = brushBus = null;
}
