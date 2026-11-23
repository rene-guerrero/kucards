/**
 * The CPU characters the player picks from. Pure data: shared by the app (levels, styles), the UI
 * (names, faces, cards) and the engine tests. Same ten characters, faces and levels as Kudominoes; the
 * play styles and descriptions are KuCards' own (card play).
 */
import type { Difficulty, Lineup } from './contracts';
import { sanitizeFace, type FaceSpec } from 'kuavatars/faces';

/**
 * The characters' faces. KuAvatars only provides the options; each game picks its own looks. These are
 * the user's picks (the same cast and looks as Kudominoes).
 */
const FACES: Record<string, FaceSpec> = Object.fromEntries(
  Object.entries({
    lola: { iris: '#2F9B63', skin: '#F3D2A2', freckles: true, flower: true, hair: 'pigtails', hairColor: 'ginger', mouth: 'teeth', lashes: true },
    pepe: { iris: '#5B3FA8', skin: '#D5AB88', brows: 'raised', smirk: true, hair: 'spiky', hairColor: 'black', mouth: 'buck' },
    nico: { iris: '#3F7FD9', skin: '#F7DECE', freckles: true, eyes: 'big', hat: 'cap', hatColor: '#3F74D6' },
    elena: { iris: '#B8741F', skin: '#AF7E57', lashes: true, hair: 'bob', hairColor: 'black', mouth: 'lips', lipColor: '#B8435A' },
    andres: { iris: '#7A4A22', skin: '#AF7E57', brows: 'thick', hair: 'sidePart', hairColor: 'black', eyewear: 'square', mouth: 'thin' },
    rosa: { iris: '#1E9C9C', skin: '#F7DECE', lashes: true, hair: 'bun', hairColor: 'grey', eyewear: 'catEye', mouth: 'lips', lipColor: '#C2304A' },
    carlos: { iris: '#3F7FD9', skin: '#AF7E57', stache: 'black', stacheStyle: 'walrus', hair: 'short', hairColor: 'black', eyewear: 'sunglasses', brows: 'aviator' },
    marta: { iris: '#6F8FB0', skin: '#7C533E', lashes: true, brows: 'raised', smirk: true, mole: true, cool: true, hair: 'long', hairColor: 'black', mouth: 'lips', lipColor: '#7A2A4A' },
    julio: { iris: '#8B5A2B', skin: '#AF7E57', glasses: true, stache: 'white', stacheStyle: 'walrus', hair: 'short', hairColor: 'white', hat: 'straw', browColor: '#E9E6DE' },
    zorg: { iris: '#101418', alien: true },
  }).map(([id, f]) => [id, sanitizeFace(f as unknown as FaceSpec)]),
);

type L10n = { es: string; en: string };

export type { PlayStyle } from './contracts';
import type { PlayStyle } from './contracts';

/** Faces come from the shared KuAvatars library (pure data); names, levels and styles stay here. */
export type { FaceSpec } from 'kuavatars/faces';

export interface Character {
  id: string;
  name: string;
  /** short form for tight spots (phone-width grid) */
  short?: string;
  level: Difficulty;
  style: PlayStyle;
  face: FaceSpec;
  /** style tag shown on the card (gendered in Spanish) */
  tag: L10n;
  /** one-line description */
  desc: L10n;
  /** how often the character talks (speech bubbles), 0–1 */
  chat: number;
  /** grammatical gender, for "Compañero/Compañera" */
  fem: boolean;
}

export const ROSTER: Character[] = [
  {
    id: 'lola', name: 'Lola', level: 'easy', style: 'carefree',
    face: FACES.lola,
    tag: { es: 'Despreocupada', en: 'Carefree' },
    desc: { es: 'Juega por diversión: pone la primera carta que sirve y elige colores al azar.', en: 'Plays for fun: puts down the first card that fits and picks colors at random.' },
    chat: 0.5, fem: true,
  },
  {
    id: 'pepe', name: 'Pepe', level: 'easy', style: 'impulsive',
    face: FACES.pepe,
    tag: { es: 'Impulsivo', en: 'Impulsive' },
    desc: { es: 'Se deshace rápido de los números altos y a veces olvida decir ¡Ku!', en: 'Dumps his high numbers fast and sometimes forgets to call ¡Ku!' },
    chat: 0.6, fem: false,
  },
  {
    id: 'nico', name: 'Nico', level: 'easy', style: 'beginner',
    face: FACES.nico,
    tag: { es: 'Principiante', en: 'Beginner' },
    desc: { es: 'Todavía está aprendiendo. Combina bien los colores, pero gasta los comodines enseguida.', en: 'Still learning. Matches colors well but burns through his wilds right away.' },
    chat: 0.4, fem: false,
  },
  {
    id: 'elena', name: 'Elena', level: 'normal', style: 'balanced',
    face: FACES.elena,
    tag: { es: 'Equilibrada', en: 'Balanced' },
    desc: { es: 'Guarda un poco de cada color para no quedarse nunca sin jugada.', en: 'Keeps a bit of every color so she always has a play.' },
    chat: 0.4, fem: true,
  },
  {
    id: 'andres', name: 'Andrés', level: 'normal', style: 'byTheBook',
    face: FACES.andres,
    tag: { es: 'Clásico', en: 'By the book' },
    desc: { es: 'Números primero y cartas especiales solo cuando hacen falta. Sólido y predecible.', en: 'Numbers first, action cards only when needed. Solid and predictable.' },
    chat: 0.3, fem: false,
  },
  {
    id: 'rosa', name: 'Rosa', level: 'normal', style: 'chatty',
    face: FACES.rosa,
    tag: { es: 'Habladora', en: 'Chatty' },
    desc: { es: 'Grita ¡Ku! antes de tiempo y nunca deja pasar a quien se olvida.', en: 'Calls ¡Ku! early and never lets anyone who forgets get away with it.' },
    chat: 0.9, fem: true,
  },
  {
    id: 'carlos', name: 'Carlos', level: 'hard', style: 'aggressive',
    face: FACES.carlos,
    tag: { es: 'Agresivo', en: 'Aggressive' },
    desc: { es: 'Castigos primero: lanza +2 y +4 al que va ganando sin pensarlo dos veces.', en: 'Penalties first: throws +2s and +4s at the leader without a second thought.' },
    chat: 0.6, fem: false,
  },
  {
    id: 'marta', name: 'Marta', level: 'hard', style: 'hoarder',
    face: FACES.marta,
    tag: { es: 'Acaparadora', en: 'Hoarder' },
    desc: { es: 'Guarda los comodines hasta el final y siempre tiene uno cuando más duele.', en: 'Keeps her wilds to the very end and always has one when it hurts most.' },
    chat: 0.2, fem: true,
  },
  {
    id: 'julio', name: 'Don Julio', short: 'Julio', level: 'hard', style: 'teamPlayer',
    face: FACES.julio,
    tag: { es: 'De equipo', en: 'Team player' },
    desc: { es: 'Recuerda cada color que falta y protege a su pareja de los castigos.', en: 'Remembers every missing color and shields his partner from penalties.' },
    chat: 0.4, fem: false,
  },
  {
    id: 'zorg', name: 'Papi Zorg', short: 'Zorg', level: 'master', style: 'perfect',
    face: FACES.zorg,
    tag: { es: 'Perfecto', en: 'Perfect' },
    desc: { es: 'El jugador perfecto. Vino de muy lejos solo para contar tus cartas.', en: 'The perfect player. Came from very far away just to count your cards.' },
    chat: 0.5, fem: false,
  },
];

/** The faces the human picks from (Ajustes → Juego): KuAvatars' list. */
export { HUMAN_FACES, FACE_COUNT } from 'kuavatars/faces';

const BY_ID = new Map(ROSTER.map((c) => [c.id, c]));
export const character = (id: string): Character => BY_ID.get(id) ?? ROSTER[3];
export const isCharacter = (id: unknown): id is string => typeof id === 'string' && BY_ID.has(id);

/** what the engine needs to play a character */
export const profileOf = (id: string): { level: Difficulty; style: PlayStyle } => {
  const c = character(id);
  return { level: c.level, style: c.style };
};

/** default lineup: Carlos right, Elena across, Andrés left */
export const DEFAULT_LINEUP: Required<Lineup> = { 1: 'carlos', 2: 'elena', 3: 'andres' };

/** three different known characters, else null */
export function sanitizeLineup(v: unknown): Required<Lineup> | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const ids = [o[1], o[2], o[3]];
  if (!ids.every(isCharacter) || new Set(ids).size !== 3) return null;
  return { 1: ids[0] as string, 2: ids[1] as string, 3: ids[2] as string };
}

/** a random lineup; `keep` pins some seats (the rest are drawn from the characters not yet seated) */
export function randomLineup(keep: Lineup = {}, rnd: () => number = Math.random): Required<Lineup> {
  const used = new Set(Object.values(keep));
  const pool = ROSTER.map((c) => c.id).filter((id) => !used.has(id));
  const draw = () => pool.splice(Math.floor(rnd() * pool.length), 1)[0];
  return { 1: keep[1] ?? draw(), 2: keep[2] ?? draw(), 3: keep[3] ?? draw() };
}

export const LEVEL_STARS: Record<Difficulty, number> = { easy: 1, normal: 2, hard: 3, master: 4 };
