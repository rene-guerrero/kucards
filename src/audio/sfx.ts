/**
 * Procedural sound effects — everything synthesized with WebAudio, no asset files.
 * Call `initAudio()` once; the context unlocks on the first pointer/key gesture.
 * `playSfx(name)` is what gets passed to the renderer as TableViewOptions.onSfx.
 */
import type { SfxName } from '../contracts';
import { startMusic, stopMusic } from './music';

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let sfxBus: GainNode | null = null;
let musicBus: GainNode | null = null;
let noiseBuf: AudioBuffer | null = null;

const state = { sound: true, music: false, vibration: true, musicWanted: false, suspended: false };
const lastPlayed = new Map<SfxName, number>();

export function initAudio(opts: { sound: boolean; music: boolean; vibration: boolean }): void {
  Object.assign(state, opts);
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
  musicBus = ctx.createGain();
  musicBus.gain.value = 0.32;
  musicBus.connect(master);
  // 1s of white noise reused by every noisy sound
  noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return ctx;
}

export function setAudioPrefs(p: Partial<{ sound: boolean; music: boolean; vibration: boolean }>): void {
  Object.assign(state, p);
  syncMusic();
}

/** Pause/resume all audio (app hidden, game paused for music). */
export function setAudioSuspended(s: boolean): void {
  state.suspended = s;
  if (!ctx) return;
  if (s) void ctx.suspend();
  else void ctx.resume();
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

const N = (semi: number) => 261.63 * Math.pow(2, semi / 12); // semitones from C4

// ───────────────────────── public ─────────────────────────

export function playSfx(name: SfxName): void {
  if (import.meta.env.DEV) {
    const w = window as unknown as { __sfx?: Record<string, number> };
    (w.__sfx ??= {})[name] = (w.__sfx[name] ?? 0) + 1;
  }
  haptic(name);
  if (!state.sound) return;
  const c = ensureCtx();
  if (!c || c.state !== 'running' || !sfxBus || !noiseBuf) return;
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
