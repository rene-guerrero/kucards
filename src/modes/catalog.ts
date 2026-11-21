/**
 * The online mode catalog, game-independent (shared later with KuDominoes): players publish a mode and
 * get a share code; others search by name or open a code. Storage is behind `CatalogStore` (the room
 * server backs it with a Durable Object's SQLite; tests with a Map). Each game passes its own sanitizer.
 */
import { MODE_NAME_MAX, nameKey, type ModeBase } from './core';

export interface CatalogEntry {
  /** share code (6 letters / digits, no look-alikes) */
  code: string;
  name: string;
  /** nameKey(name): what searches match */
  key: string;
  icon: string;
  /** the game's base mode id (shown as "based on") */
  base: string;
  author: string;
  created: number;
  downloads: number;
  /** the sanitized mode, as JSON */
  json: string;
}

/** what a search returns (no JSON: open a code to get the mode) */
export type CatalogItem = Omit<CatalogEntry, 'json' | 'key'>;

export interface CatalogStore {
  get(code: string): Promise<CatalogEntry | null>;
  put(e: CatalogEntry): Promise<void>;
  search(key: string, limit: number): Promise<CatalogEntry[]>;
  bump(code: string): Promise<void>;
}

export const CATALOG_CODE_LENGTH = 6;
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
/** biggest accepted mode JSON (a real mode is ~1–2 KB) */
export const CATALOG_MAX_JSON = 8000;
export const CATALOG_PAGE = 30;

export const normalizeCatalogCode = (raw: string): string | null => {
  const c = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return c.length === CATALOG_CODE_LENGTH && [...c].every((ch) => ALPHABET.includes(ch)) ? c : null;
};

export function newCatalogCode(rand: () => number): string {
  let s = '';
  for (let i = 0; i < CATALOG_CODE_LENGTH; i++) s += ALPHABET[Math.floor(rand() * ALPHABET.length)];
  return s;
}

const item = ({ json: _j, key: _k, ...rest }: CatalogEntry): CatalogItem => rest;

export class CatalogError extends Error {
  constructor(readonly code: 'bad_request' | 'not_found' | 'too_big' | 'no_free_code') {
    super(code);
  }
}

/** publish a mode: sanitized by the game, stored under a fresh share code */
export async function publishMode<M extends ModeBase & { base?: string }>(
  store: CatalogStore,
  raw: unknown,
  author: unknown,
  sanitize: (raw: unknown) => M,
  rand: () => number,
  now: number,
): Promise<CatalogItem> {
  if (!raw || typeof raw !== 'object') throw new CatalogError('bad_request');
  if (JSON.stringify(raw).length > CATALOG_MAX_JSON) throw new CatalogError('too_big');
  const def = sanitize(raw);
  const name = def.name.trim().slice(0, MODE_NAME_MAX);
  if (!name) throw new CatalogError('bad_request');
  for (let i = 0; i < 12; i++) {
    const code = newCatalogCode(rand);
    if (await store.get(code)) continue;
    const e: CatalogEntry = {
      code,
      name,
      key: nameKey(name),
      icon: def.icon,
      base: String(def.base ?? ''),
      author: typeof author === 'string' ? author.trim().slice(0, 16) : '',
      created: now,
      downloads: 0,
      json: JSON.stringify({ ...def, name }),
    };
    await store.put(e);
    return item(e);
  }
  throw new CatalogError('no_free_code');
}

/** search by name (empty = the most downloaded) */
export async function searchModes(store: CatalogStore, q: string, limit = CATALOG_PAGE): Promise<CatalogItem[]> {
  const list = await store.search(nameKey(q ?? '').slice(0, MODE_NAME_MAX), Math.max(1, Math.min(CATALOG_PAGE, limit)));
  return list.map(item);
}

/** open a share code: the mode (re-sanitized) and one more download */
export async function fetchMode<M>(store: CatalogStore, rawCode: string, sanitize: (raw: unknown) => M): Promise<{ item: CatalogItem; mode: M }> {
  const code = normalizeCatalogCode(rawCode);
  const e = code ? await store.get(code) : null;
  if (!e) throw new CatalogError('not_found');
  await store.bump(e.code);
  return { item: item({ ...e, downloads: e.downloads + 1 }), mode: sanitize(JSON.parse(e.json)) };
}

/** an in-memory store (tests, and the local Wi-Fi host if it ever serves a catalog) */
export function memoryCatalog(): CatalogStore {
  const m = new Map<string, CatalogEntry>();
  return {
    get: async (c) => { const e = m.get(c); return e ? { ...e } : null; },
    put: async (e) => void m.set(e.code, { ...e }),
    search: async (key, limit) =>
      [...m.values()]
        .filter((e) => !key || e.key.includes(key))
        .sort((a, b) => b.downloads - a.downloads || b.created - a.created)
        .slice(0, limit),
    bump: async (c) => {
      const e = m.get(c);
      if (e) e.downloads++;
    },
  };
}
