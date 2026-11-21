/**
 * The online mode catalog: one Durable Object (name 'catalog') holding every published mode in its SQLite
 * storage. The logic is src/modes/catalog.ts; this class adapts it to the platform.
 *
 *   POST /api/modes            { def, author } → CatalogItem (with its share code)
 *   GET  /api/modes?q=&limit=  → { items: CatalogItem[] }
 *   GET  /api/modes/:code      → { item, mode }
 */
import { DurableObject } from 'cloudflare:workers';
import type { Env } from './config';
import { CatalogError, fetchMode, publishMode, searchModes, type CatalogEntry, type CatalogStore } from '../../src/modes/catalog';
import { sanitizeModeDef } from '../../src/engine/modes';

export class ModeStore extends DurableObject<Env> {
  private store: CatalogStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    sql.exec(
      `CREATE TABLE IF NOT EXISTS modes (code TEXT PRIMARY KEY, name TEXT, key TEXT, icon TEXT, base TEXT, author TEXT, created INTEGER, downloads INTEGER, json TEXT)`,
    );
    sql.exec(`CREATE INDEX IF NOT EXISTS modes_key ON modes(key)`);
    const row = (r: Record<string, SqlStorageValue>): CatalogEntry => ({
      code: String(r.code),
      name: String(r.name),
      key: String(r.key),
      icon: String(r.icon),
      base: String(r.base),
      author: String(r.author),
      created: Number(r.created),
      downloads: Number(r.downloads),
      json: String(r.json),
    });
    this.store = {
      get: async (code) => {
        const r = sql.exec('SELECT * FROM modes WHERE code = ?', code).toArray()[0];
        return r ? row(r) : null;
      },
      put: async (e) => {
        sql.exec('INSERT INTO modes (code, name, key, icon, base, author, created, downloads, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', e.code, e.name, e.key, e.icon, e.base, e.author, e.created, e.downloads, e.json);
      },
      search: async (key, limit) =>
        (key
          ? sql.exec("SELECT * FROM modes WHERE key LIKE ? ORDER BY downloads DESC, created DESC LIMIT ?", `%${key.replace(/[%_]/g, '')}%`, limit)
          : sql.exec('SELECT * FROM modes ORDER BY downloads DESC, created DESC LIMIT ?', limit)
        )
          .toArray()
          .map(row),
      bump: async (code) => void sql.exec('UPDATE modes SET downloads = downloads + 1 WHERE code = ?', code),
    };
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
    try {
      if (url.pathname === '/publish' && req.method === 'POST') {
        const body = (await req.json()) as { def?: unknown; author?: unknown };
        return json(await publishMode(this.store, body?.def, body?.author, sanitizeModeDef, Math.random, Date.now()), 201);
      }
      if (url.pathname === '/search') return json({ items: await searchModes(this.store, url.searchParams.get('q') ?? '', Number(url.searchParams.get('limit')) || undefined) });
      if (url.pathname === '/get') return json(await fetchMode(this.store, url.searchParams.get('code') ?? '', sanitizeModeDef));
      return json({ error: 'not_found' }, 404);
    } catch (e) {
      if (e instanceof CatalogError) return json({ error: e.code }, e.code === 'not_found' ? 404 : e.code === 'too_big' ? 413 : 400);
      return json({ error: 'server' }, 500);
    }
  }
}
