/**
 * Client for the online mode catalog (room server: /api/modes). A server without the catalog (not yet
 * redeployed) answers 404 for every path: that reads as 'unavailable'.
 */
import { serverUrl } from './config';
import type { CatalogItem } from '../modes/catalog';
import { sanitizeModeDef, type ModeDef } from '../engine/modes';

export type CatalogFail = 'offline' | 'unavailable' | 'not_found' | 'server';
export class CatalogNetError extends Error {
  constructor(readonly reason: CatalogFail) {
    super(reason);
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${serverUrl()}/api/modes${path}`, { ...init, headers: { 'content-type': 'application/json' } });
  } catch {
    throw new CatalogNetError('offline');
  }
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  if (res.status === 404) throw new CatalogNetError(body?.error === 'not_found' && path.length > 1 && !path.startsWith('?') ? 'not_found' : 'unavailable');
  if (!res.ok || !body) throw new CatalogNetError('server');
  return body as T;
}

export const publishOnline = (def: ModeDef, author: string): Promise<CatalogItem> => call('', { method: 'POST', body: JSON.stringify({ def, author }) });

export async function searchOnline(q: string): Promise<CatalogItem[]> {
  const r = await call<{ items: CatalogItem[] }>(`?${new URLSearchParams({ q })}`);
  return Array.isArray(r.items) ? r.items : [];
}

export async function openOnline(code: string): Promise<{ item: CatalogItem; mode: ModeDef }> {
  const r = await call<{ item: CatalogItem; mode: unknown }>(`/${encodeURIComponent(code)}`);
  return { item: r.item, mode: sanitizeModeDef(r.mode) };
}
