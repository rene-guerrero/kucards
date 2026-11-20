/**
 * Procedural sound effects — everything synthesized with WebAudio, no asset files.
 * Call `initAudio()` once; the context unlocks on the first pointer/key gesture.
 * `playSfx(name)` is what gets passed to the renderer as TableViewOptions.onSfx.
 */
import type { CardKind, Color, GameEvent, SfxName } from '../contracts';
import { setVoiceEnabled, setVoiceHook } from './voice';
import { musicLift, setMode, startMusic, stopMusic } from './music';

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let sfxBus: GainNode | null = null;
let musicBus: GainNode | null = null;
/** power-card stingers: their own bus, ducked while a voice callout speaks */
let powBus: GainNode | null = null;
let noiseBuf: AudioBuffer | null = null;

const state = { sound: true, voice: true, music: false, vibration: true, musicWanted: false, suspended: false };
const lastPlayed = new Map<SfxName, number>();

export function initAudio(opts: { sound: boolean; voice?: boolean; music: boolean; vibration: boolean }): void {
  Object.assign(state, opts);
  syncVoice();
  const unlock = () => {
    ensureCtx();
    if (ctx && ctx.state === 'suspended' && !state.suspended) void ctx.resume();
    syncMusic();
  };
  window.addEventListener('pointerdown', unlock, { passive: true });
  window.addEventListener('keydown', unlock);
}

function ensureCtx(): AudioContext | null {
  if (ctx) return ctx;
  const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  ctx = new AC({ latencyHint: 'interactive' });
  master = ctx.createGain();
  master.gain.value = 0.9;
  // gentle glue compressor so stacked clacks don't clip
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.ratio.value = 4;
  comp.attack.value = 0.002;
  comp.release.value = 0.15;
  master.connect(comp).connect(ctx.destination);
  sfxBus = ctx.createGain();
  sfxBus.connect(master);
  powBus = ctx.createGain();
  powBus.connect(sfxBus);
  musicBus = ctx.createGain();
  musicBus.gain.value = 0.32;
  musicBus.connect(master);
  // 1s of white noise reused by every noisy sound
  noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return ctx;
}

export function setAudioPrefs(p: Partial<{ sound: boolean; voice: boolean; music: boolean; vibration: boolean }>): void {
  Object.assign(state, p);
  syncVoice();
  syncMusic();
}

/** Pause/resume all audio (app hidden, game paused for music). */
export function setAudioSuspended(s: boolean): void {
  state.suspended = s;
  syncVoice();
  if (!ctx) return;
  if (s) void ctx.suspend();
  else void ctx.resume();
}

/** 'frenzy' for the final minute of a timed round; remembered while the music is off. */
export function setMusicMode(mode: 'normal' | 'frenzy'): void {
  gameMode = mode;
  setMode(scene === 'menu' ? 'menu' : gameMode);
}

let scene: 'menu' | 'game' = 'menu';
let gameMode: 'normal' | 'frenzy' = 'normal';
/** The title theme on the menus and lobby, the table music during a match; switches on a bar line. */
export function setMusicScene(s: 'menu' | 'game'): void {
  scene = s;
  if (s === 'menu') gameMode = 'normal';
  setMode(s === 'menu' ? 'menu' : gameMode);
}

/** callouts follow both their own toggle and the master sound switch */
function syncVoice() {
  setVoiceEnabled(state.sound && state.voice && !state.suspended);
}

function syncMusic() {
  if (!ctx || !musicBus) return;
  if (state.music) startMusic(ctx, musicBus);
  else stopMusic();
}

// ───────────────────────── building blocks ─────────────────────────

const rnd = (a: number, b: number) => a + Math.random() * (b - a);

function noise(t: number, dur: number, opts: { type: BiquadFilterType; freq: number; q?: number; gain: number; attack?: number; dest?: AudioNode }) {
  const c = ctx!;
  const src = c.createBufferSource();
  src.buffer = noiseBuf;
  src.playbackRate.value = rnd(0.9, 1.1);
  const f = c.createBiquadFilter();
  f.type = opts.type;
  f.frequency.value = opts.freq;
  f.Q.value = opts.q ?? 1;
  const g = c.createGain();
  const a = opts.attack ?? 0.001;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(opts.gain, t + a);
  g.gain.exponentialRampToValueAtTime(0.0001, t + a + dur);
  src.connect(f).connect(g).connect(opts.dest ?? sfxBus!);
  src.start(t, Math.random() * 0.5);
  src.stop(t + a + dur + 0.02);
}

function tone(
  t: number,
  dur: number,
  opts: { type?: OscillatorType; f0: number; f1?: number; gain: number; attack?: number; dest?: AudioNode; sweep?: number },
) {
  const c = ctx!;
  const o = c.createOscillator();
  o.type = opts.type ?? 'sine';
  o.frequency.setValueAtTime(opts.f0, t);
  if (opts.f1) o.frequency.exponentialRampToValueAtTime(opts.f1, t + (opts.sweep ?? dur));
  const g = c.createGain();
  const a = opts.attack ?? 0.002;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(opts.gain, t + a);
  g.gain.exponentialRampToValueAtTime(0.0001, t + a + dur);
  o.connect(g).connect(opts.dest ?? sfxBus!);
  o.start(t);
  o.stop(t + a + dur + 0.02);
}

/** A card flicked onto the pile: papery snap (band-passed noise) + a soft low "thup" as it lands. */
function flick(t: number, body = 1) {
  const p = rnd(0.9, 1.12);
  noise(t, 0.03, { type: 'bandpass', freq: 3000 * p, q: 1.1, gain: 0.42 });
  noise(t, 0.008, { type: 'highpass', freq: 6500, gain: 0.12 });
  // the landing: low-passed noise puff, no pitched ring
  noise(t + 0.004, 0.03 * body, { type: 'lowpass', freq: 220 * p, q: 0.7, gain: 0.5 * body });
}

/** A card sliding: filtered noise whose band falls over ~70 ms. */
function slide(t: number, gain = 0.2, dur = 0.075) {
  const c = ctx!;
  const src = c.createBufferSource();
  src.buffer = noiseBuf;
  const f = c.createBiquadFilter();
  f.type = 'bandpass';
  f.Q.value = 1.3;
  const f0 = rnd(4200, 5200);
  f.frequency.setValueAtTime(f0, t);
  f.frequency.exponentialRampToValueAtTime(f0 * 0.38, t + dur);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(g).connect(sfxBus!);
  src.start(t, Math.random() * 0.8);
  src.stop(t + dur + 0.02);
}

/** Bell-ish partial stack for metal (shield). */
function clang(t: number, f0: number, gain: number) {
  [1, 2.76, 5.4, 8.93].forEach((m, i) => tone(t, 0.5 / (1 + i * 0.6), { f0: f0 * m, gain: gain / (1 + i), type: 'sine' }));
}

/** Marimba-ish note: sine fundamental + quick 4x partial. */
function mallet(t: number, freq: number, gain = 0.22, dur = 0.5) {
  tone(t, dur, { f0: freq, gain });
  tone(t, dur * 0.25, { f0: freq * 4, gain: gain * 0.25 });
  tone(t, dur * 0.6, { f0: freq * 2, gain: gain * 0.2, type: 'triangle' });
}

/** Noise whose band sweeps f[0] → f[1] (→ f[2]) with a bell-shaped level; optional left/right travel. */
function whoosh(t: number, dur: number, f: number[], gain: number, q = 2, pan?: [number, number]) {
  const c = ctx!;
  const src = c.createBufferSource();
  src.buffer = noiseBuf;
  const bp = c.createBiquadFilter();
  bp.type = 'bandpass';
  bp.Q.value = q;
  const step = dur / (f.length - 1);
  bp.frequency.setValueAtTime(f[0], t);
  for (let i = 1; i < f.length; i++) bp.frequency.exponentialRampToValueAtTime(f[i], t + step * i);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + dur * 0.45);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  let out: AudioNode = src.connect(bp).connect(g);
  if (pan && typeof c.createStereoPanner === 'function') {
    const p = c.createStereoPanner();
    p.pan.setValueAtTime(pan[0], t);
    p.pan.linearRampToValueAtTime(pan[1], t + dur);
    out = out.connect(p);
  }
  out.connect(powBus!);
  src.start(t, Math.random() * 0.5);
  src.stop(t + dur + 0.02);
}

/** Brassy stab: detuned saws through a low-pass that barks open and closes again. */
function brass(t: number, freqs: number[], dur: number, gain: number) {
  const c = ctx!;
  const lp = c.createBiquadFilter();
  lp.type = 'lowpass';
  lp.Q.value = 2;
  lp.frequency.setValueAtTime(260, t);
  lp.frequency.exponentialRampToValueAtTime(1500, t + 0.03);
  lp.frequency.exponentialRampToValueAtTime(320, t + dur);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  lp.connect(g).connect(powBus!);
  for (const fr of freqs) {
    const o = c.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = fr;
    o.detune.value = rnd(-9, 9);
    o.connect(lp);
    o.start(t);
    o.stop(t + dur + 0.02);
  }
}

/** A penalty card landing: the brass grows with the total, one more stab per card in the stack. */
function penaltyHit(t: number, size: 2 | 4 | 6) {
  const lv = Math.max(1, Math.min(chain, 4));
  const root = 98 * Math.pow(2, (lv - 1) / 12); // G2, a semitone up per stacked card
  const dur = size === 2 ? 0.15 : size === 4 ? 0.22 : 0.3;
  brass(t, size === 2 ? [root * 2, root * 3] : [root, root * 2, root * 3], dur, size === 2 ? 0.2 : 0.26);
  for (let i = 1; i < lv; i++) brass(t + i * 0.055, [root * 2 * Math.pow(2, (i * 3) / 12)], 0.11, 0.13);
  if (size >= 4) tone(t, 0.2, { f0: 120, f1: 50, gain: 0.45, sweep: 0.14, dest: powBus! });
  if (size === 6) {
    tone(t, 0.42, { f0: 85, f1: 34, gain: 0.75, sweep: 0.3, dest: powBus! });
    noise(t, 0.16, { type: 'lowpass', freq: 200, q: 0.6, gain: 0.5, dest: powBus! });
    // the riser: air climbing above the voice's range
    whoosh(t + 0.04, 0.55, [2600, 8000], 0.11, 3);
  }
}

/** a sparkle chord per colour (semitones over F6): red bold major, blue a cool minor 9, yellow lydian, green open */
const WILD_CHORD: Record<Color, number[]> = {
  coral: [0, 4, 7, 12], mar: [0, 3, 7, 14], sol: [0, 4, 6, 11], palma: [0, 2, 7, 9],
  // the night side: darker cousins
  rosa: [0, 4, 9, 11], naranja: [0, 5, 7, 12], celeste: [0, 2, 7, 14], morado: [0, 3, 6, 10],
};
const DRAW_N: Partial<Record<CardKind, number>> = { draw2: 2, wild4: 4, draw6: 6, draw10: 10 };
let chain = 0;
let chainTotal = 0;
let tint: Color = 'coral';

/**
 * The stinger for a power card, right as it lands (the voice callout follows ~140 ms later). Call after the
 * table has animated the event. Sweep, swap and Eclipse sound from the table's own animations.
 */
export function powerSfxForEvent(ev: GameEvent): void {
  if (ev.type === 'deal' || ev.type === 'shield' || (ev.type === 'draw' && ev.reason === 'penalty')) chain = chainTotal = 0;
  if (ev.type !== 'play' || typeof window === 'undefined') return;
  const f = ev.card.face;
  const n = DRAW_N[f.kind];
  if (n) {
    chain++;
    chainTotal += n;
    playSfx(chainTotal >= 6 ? 'hit6' : chainTotal >= 4 ? 'hit4' : 'hit2');
  } else if (f.kind === 'skip' || f.kind === 'skipAll') playSfx('skip');
  else if (f.kind === 'reverse') playSfx('reverse');
  if (f.color === null && ev.color) {
    tint = ev.color;
    playSfx('wild');
  }
}

/** dip the stingers while a callout speaks */
setVoiceHook(() => {
  if (!ctx || !powBus) return;
  const t = ctx.currentTime;
  powBus.gain.cancelScheduledValues(t);
  powBus.gain.setTargetAtTime(0.4, t, 0.02);
  powBus.gain.setTargetAtTime(1, t + 0.5, 0.12);
});

const N = (semi: number) => 261.63 * Math.pow(2, semi / 12); // semitones from C4

// ───────────────────────── public ─────────────────────────

export function playSfx(name: SfxName): void {
  if (import.meta.env.DEV) {
    const w = window as unknown as { __sfx?: Record<string, number> };
    (w.__sfx ??= {})[name] = (w.__sfx[name] ?? 0) + 1;
  }
  haptic(name);
  if (name === 'ku') musicLift();
  if (!state.sound) return;
  const c = ensureCtx();
  if (!c || c.state !== 'running' || !sfxBus || !powBus || !noiseBuf) return;
  // dedupe identical sounds fired twice by different layers within 120ms
  const now = performance.now();
  if ((name === 'winHand' || name === 'loseHand' || name === 'winMatch' || name === 'loseMatch' || name === 'tranque') && now - (lastPlayed.get(name) ?? 0) < 1500) return;
  if (now - (lastPlayed.get(name) ?? 0) < 25) return;
  lastPlayed.set(name, now);

  const t = c.currentTime + 0.005;
  switch (name) {
    case 'clack':
      flick(t);
      break;
    case 'slam':
      // emphatic play: the same snap with more body and a light thump
      flick(t, 1.8);
      noise(t, 0.05, { type: 'lowpass', freq: 160, q: 0.6, gain: 0.55 });
      break;
    case 'thump':
      // big penalty (+4 and up): a low felt thump under the snap
      flick(t, 1.6);
      tone(t, 0.22, { f0: 110, f1: 48, gain: 0.7, sweep: 0.16 });
      noise(t, 0.12, { type: 'lowpass', freq: 240, q: 0.6, gain: 0.5 });
      break;
    case 'charge':
      tone(t, 0.05, { f0: 520, f1: 900, gain: 0.1, sweep: 0.04, type: 'triangle' });
      break;
    case 'pass':
      // a soft tap on the cards
      noise(t, 0.03, { type: 'lowpass', freq: 900, q: 0.7, gain: 0.22 });
      noise(t, 0.012, { type: 'bandpass', freq: 2400, q: 1.2, gain: 0.08 });
      break;
    case 'shuffle': {
      // riffle: a quick train of tiny ticks, then the bridge whoosh as the halves fall together
      const n = 24;
      for (let i = 0; i < n; i++) {
        const tt = t + i * 0.019 + rnd(0, 0.006);
        noise(tt, 0.009, { type: 'bandpass', freq: rnd(2600, 4200) * (1 - i * 0.008), q: 2, gain: rnd(0.07, 0.14) });
      }
      noise(t + n * 0.019, 0.22, { type: 'bandpass', freq: 1600, q: 0.7, gain: 0.12, attack: 0.05 });
      break;
    }
    case 'deal':
      slide(t, 0.16, 0.06);
      break;
    case 'draw':
      slide(t, 0.2, 0.085);
      noise(t + 0.08, 0.012, { type: 'bandpass', freq: 2200, q: 1.4, gain: 0.07 });
      break;
    case 'select':
      // a light card lift
      slide(t, 0.09, 0.05);
      break;
    case 'invalid':
      noise(t, 0.02, { type: 'lowpass', freq: 600, q: 0.8, gain: 0.28 });
      noise(t + 0.085, 0.02, { type: 'lowpass', freq: 520, q: 0.8, gain: 0.24 });
      break;
    case 'ku':
      // bright two-note sting (a fifth up)
      mallet(t, N(19), 0.2, 0.25);
      mallet(t + 0.11, N(26), 0.22, 0.45);
      tone(t + 0.11, 0.3, { f0: N(38), gain: 0.04 });
      break;
    case 'shield':
      clang(t, 520, 0.16);
      noise(t, 0.02, { type: 'highpass', freq: 5000, gain: 0.12 });
      break;
    case 'mirror': {
      // glassy whoosh: a rising band of noise plus two high glints
      const c2 = ctx!;
      const src = c2.createBufferSource();
      src.buffer = noiseBuf;
      const f = c2.createBiquadFilter();
      f.type = 'bandpass';
      f.Q.value = 3;
      f.frequency.setValueAtTime(900, t);
      f.frequency.exponentialRampToValueAtTime(5200, t + 0.32);
      const g = c2.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.16, t + 0.12);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.36);
      src.connect(f).connect(g).connect(sfxBus!);
      src.start(t, Math.random() * 0.5);
      src.stop(t + 0.4);
      tone(t + 0.2, 0.28, { f0: 2637, gain: 0.05 });
      tone(t + 0.26, 0.3, { f0: 3520, gain: 0.04 });
      break;
    }
    case 'skip':
      // "blocked": a zap falling through the mids before the voice, a soft thud under it
      tone(t, 0.1, { type: 'square', f0: 3200, f1: 240, gain: 0.07, sweep: 0.09, dest: powBus! });
      tone(t + 0.07, 0.14, { f0: 150, f1: 55, gain: 0.5, sweep: 0.1, dest: powBus! });
      noise(t + 0.07, 0.03, { type: 'lowpass', freq: 260, q: 0.7, gain: 0.3, dest: powBus! });
      break;
    case 'reverse':
      // swirls up and comes back
      whoosh(t, 0.36, [500, 4600, 600], 0.2, 2.5, [-0.6, 0.6]);
      tone(t + 0.24, 0.12, { f0: 190, f1: 95, gain: 0.22, dest: powBus! });
      break;
    case 'hit2':
      penaltyHit(t, 2);
      break;
    case 'hit4':
      penaltyHit(t, 4);
      break;
    case 'hit6':
      penaltyHit(t, 6);
      break;
    case 'wild':
      WILD_CHORD[tint].forEach((s2, i) => tone(t + 0.04 + i * 0.03, 0.32, { f0: N(29 + s2), gain: 0.055, dest: powBus! }));
      noise(t + 0.04, 0.12, { type: 'highpass', freq: 7500, gain: 0.05, attack: 0.02, dest: powBus! });
      break;
    case 'sweep':
      // cards cascading away: falling ticks over a falling whoosh
      for (let i = 0; i < 8; i++) noise(t + i * 0.028, 0.012, { type: 'bandpass', freq: 5200 - i * 420, q: 2, gain: 0.13, dest: powBus! });
      whoosh(t, 0.32, [3600, 900], 0.16, 1.4);
      break;
    case 'flip':
      // Eclipse: day sinks into night
      tone(t, 0.75, { f0: 110, f1: 52, gain: 0.5, attack: 0.3, sweep: 0.9, dest: powBus! });
      whoosh(t, 0.95, [180, 1100, 140], 0.22, 1.2);
      tone(t + 0.25, 0.5, { f0: 3136, f1: 2093, gain: 0.03, attack: 0.1, dest: powBus! });
      break;
    case 'swap':
      // two hands crossing
      whoosh(t, 0.3, [600, 4200], 0.18, 2.2, [-0.8, 0.8]);
      whoosh(t + 0.07, 0.32, [4200, 600], 0.18, 2.2, [0.8, -0.8]);
      break;
    case 'winHand':
      // rising arpeggio
      [0, 4, 7, 12, 16].forEach((s2, i) => mallet(t + i * 0.075, N(s2 + 12), 0.18, 0.45));
      break;
    case 'loseHand':
      // gentle falling arpeggio
      [7, 4, 0, -5].forEach((s2, i) => mallet(t + i * 0.13, N(s2), 0.15, 0.6));
      break;
    case 'winMatch':
      [0, 4, 7, 12, 16, 19, 24].forEach((s2, i) => mallet(t + i * 0.07, N(s2), 0.18));
      [0, 4, 7, 12].forEach((s2) => mallet(t + 0.6, N(s2), 0.13, 1.3));
      break;
    case 'loseMatch':
      [12, 10, 7, 3, 0].forEach((s2, i) => mallet(t + i * 0.18, N(s2 - 5), 0.16, 0.7));
      break;
    case 'tranque':
      // blocked round (kept for the shared name): two muted taps and a low settle
      noise(t, 0.03, { type: 'lowpass', freq: 700, gain: 0.25 });
      noise(t + 0.16, 0.03, { type: 'lowpass', freq: 600, gain: 0.25 });
      [0, 6].forEach((s2) => mallet(t + 0.3, N(s2 - 12), 0.12, 0.7));
      break;
  }
}

/** UI button press: a soft tick. */
export function uiClick(): void {
  if (!state.sound) return;
  const c = ensureCtx();
  if (!c || c.state !== 'running' || !sfxBus) return;
  const t = c.currentTime + 0.003;
  tone(t, 0.035, { f0: 520, f1: 760, gain: 0.08, sweep: 0.02, type: 'triangle' });
}

/** a light tick (it is your turn), when vibration is enabled */
export function hapticTick(): void {
  if (!state.vibration || !('vibrate' in navigator)) return;
  try {
    navigator.vibrate(10);
  } catch {
    /* ignore */
  }
}

function haptic(name: SfxName) {
  if (!state.vibration || !('vibrate' in navigator)) return;
  const pattern: Partial<Record<SfxName, number | number[]>> = {
    clack: 10,
    slam: [40, 30, 60],
    thump: [70, 30, 110],
    ku: [20, 40, 30],
    shield: 25,
    charge: 15,
    tranque: [20, 60, 20, 60, 40],
    winMatch: [40, 60, 40, 60, 120],
    invalid: [15, 40, 15],
  };
  const p = pattern[name];
  if (p !== undefined) {
    try {
      navigator.vibrate(p);
    } catch {
      /* ignore */
    }
  }
}
