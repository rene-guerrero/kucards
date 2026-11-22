/**
 * Voice callouts ("Draw two!", "Skip!", "Reverse!") with the Web Speech API. Always English, whatever the
 * UI language. No asset files and no network: it uses the voices the OS/WebView already has, picks the
 * most natural English one, and stays silent where there are none. Each callout cancels the previous one,
 * so nothing ever queues up.
 */
import type { GameEvent } from '../contracts';

let enabled = true;
let voice: SpeechSynthesisVoice | null = null;
let voiceKey = '';

const synth = (): SpeechSynthesis | null => (typeof window !== 'undefined' && 'speechSynthesis' in window ? window.speechSynthesis : null);

const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];

/** "Draw two!"; totals above twenty fall back to a generic call */
export function drawPhrase(n: number): string {
  // only these four callouts: Draw two / four / six, anything else is "Draw cards!"
  return n === 2 || n === 4 || n === 6 ? `Draw ${WORDS[n]}!` : 'Draw cards!';
}

const COLOR_WORD: Record<string, string> = { coral: 'Red', mar: 'Blue', sol: 'Yellow', palma: 'Green' };

/**
 * the callout for a game event, or null. Skip, reverse and a wild's chosen colour (also the automatic
 * pick) speak on the card play; "Draw N!" speaks only when the penalty is actually drawn, with the final total.
 * A multi-play puts one 'play' event per card down: every card but the last carries `more: true`, and only
 * the last one speaks, so several skips / reverses / +2s fired in one move make a single callout.
 */
export function phraseFor(ev: GameEvent): string | null {
  if (ev.type === 'draw') return ev.reason === 'penalty' ? drawPhrase(ev.count) : null;
  if (ev.type !== 'play' || ev.more) return null;
  const f = ev.card.face;
  if (f.kind === 'skip' || f.kind === 'skipAll') return 'Skip!';
  if (f.kind === 'reverse') return 'Reverse!';
  const c = f.color === null && ev.color ? COLOR_WORD[ev.color] : undefined;
  return c ? `${c}!` : null;
}

export function setVoiceEnabled(on: boolean): void {
  enabled = on;
  if (!on) cancelVoice();
}

export function cancelVoice(): void {
  for (const t of pending) clearTimeout(t);
  pending.clear();
  try {
    clip?.pause();
    synth()?.cancel();
  } catch {
    /* ignore */
  }
}

/** best English voice: natural-sounding named ones first, then any en-US / en-GB, then any English */
function pickVoice(s: SpeechSynthesis): SpeechSynthesisVoice | null {
  const all = s.getVoices().filter((v) => /^en([-_]|$)/i.test(v.lang));
  if (!all.length) return null;
  const key = all.map((v) => v.voiceURI).join('|');
  if (voice && key === voiceKey) return voice;
  const score = (v: SpeechSynthesisVoice) => {
    let p = 0;
    if (/natural|neural|online/i.test(v.name)) p += 50;
    if (/google/i.test(v.name)) p += 40;
    if (/samantha|daniel|karen|alex|aria|guy|jenny|ryan|zira|david/i.test(v.name)) p += 30;
    if (/^en[-_](us|gb)$/i.test(v.lang)) p += 20;
    if (v.localService) p += 5;
    return p;
  };
  voiceKey = key;
  voice = all.slice().sort((a, b) => score(b) - score(a))[0];
  return voice;
}

let onSpeak: (() => void) | null = null;
/** called whenever a callout starts (the effects duck under it) */
export function setVoiceHook(fn: (() => void) | null): void {
  onSpeak = fn;
}

let lastText = '';
let lastAt = 0;

/**
 * Recorded voices win: a phrase plays `voices/<slug>.wav` when that file exists (e.g. "Draw two!" →
 * voices/draw-two.wav, "Red!" → voices/red.wav); the system speech voice is only the fallback. Missing
 * files are remembered so each one is tried once. See public/voices/README.md for the list.
 */
export function voiceSlug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
const missing = new Set<string>();
let clip: HTMLAudioElement | null = null;
/** pending delayed callouts, so leaving/resetting a game can silence them all */
const pending = new Set<ReturnType<typeof setTimeout>>();

function playFile(text: string, fallback: () => void): void {
  const slug = voiceSlug(text);
  if (missing.has(slug) || typeof Audio === 'undefined') return fallback();
  try {
    clip?.pause();
    const a = new Audio(`${import.meta.env.BASE_URL ?? './'}voices/${slug}.wav`);
    clip = a;
    a.volume = VOICE_VOLUME;
    // a missing clip reports twice (the element's error and play()'s rejection): fall back only once
    let fell = false;
    const fail = () => {
      missing.add(slug);
      if (fell || clip !== a) return;
      fell = true;
      clip = null;
      fallback();
    };
    a.addEventListener('error', fail, { once: true });
    void a.play().catch(fail);
  } catch {
    missing.add(slug);
    fallback();
  }
}

export function speak(text: string): void {
  if (!enabled) return;
  // one owner per event, plus a guard: the same phrase twice within 400 ms is ignored
  const now = Date.now();
  if (text === lastText && now - lastAt < 400) return;
  lastText = text;
  lastAt = now;
  onSpeak?.();
  playFile(text, () => speakSynth(text));
}

function speakSynth(text: string): void {
  const s = synth();
  if (!s || typeof SpeechSynthesisUtterance === 'undefined') return;
  try {
    s.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-US';
    const v = pickVoice(s);
    if (v) {
      u.voice = v;
      u.lang = v.lang;
    }
    u.rate = 1.15;
    u.pitch = 1.2;
    u.volume = VOICE_VOLUME;
    s.speak(u);
  } catch {
    /* no voices / blocked: stay silent */
  }
}

/** a short beat after the card's animation before the callout */
export const VOICE_DELAY_MS = 140;
/** callouts sit a little under the music and effects */
const VOICE_VOLUME = 0.38;

/** call after the table has animated an event (never for restores or snapshots) */
export function voiceForEvent(ev: GameEvent, delayMs = 0): void {
  const p = enabled ? phraseFor(ev) : null;
  if (!p) return;
  if (delayMs > 0) {
    const timer = setTimeout(() => {
      pending.delete(timer);
      if (enabled) speak(p);
    }, delayMs);
    pending.add(timer);
  } else speak(p);
}

if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
  // some engines load their voice list lazily
  try {
    window.speechSynthesis.addEventListener('voiceschanged', () => (voiceKey = ''));
  } catch {
    /* ignore */
  }
}
