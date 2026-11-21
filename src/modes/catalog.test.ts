import { describe, it, expect } from 'vitest';
import { CatalogError, fetchMode, memoryCatalog, publishMode, searchModes } from './catalog';
import { sanitizeModeDef } from '../engine/modes';
import { Rng } from '../engine/rng';

describe('online mode catalog', () => {
  it('publish → search by name (accents / case ignored) → open the code (counts a download)', async () => {
    const store = memoryCatalog();
    const rng = new Rng(3);
    const it1 = await publishMode(store, { id: 'custom-a', name: 'Ciclón Loco', icon: 'flame', base: 'cyclone' }, 'Rene', sanitizeModeDef, () => rng.next(), 1);
    await publishMode(store, { id: 'custom-b', name: 'Tranquilo', base: 'classic' }, '', sanitizeModeDef, () => rng.next(), 2);
    expect(it1.code).toMatch(/^[A-Z2-9]{6}$/);
    expect((await searchModes(store, 'ciclon')).map((x) => x.name)).toEqual(['Ciclón Loco']);
    expect(await searchModes(store, '')).toHaveLength(2);
    const got = await fetchMode(store, it1.code.toLowerCase(), sanitizeModeDef);
    expect(got.mode).toMatchObject({ name: 'Ciclón Loco', icon: 'flame', base: 'cyclone' });
    expect(got.item.downloads).toBe(1);
    expect((await searchModes(store, ''))[0].name).toBe('Ciclón Loco');
  });

  it('refuses nameless, oversized and unknown', async () => {
    const store = memoryCatalog();
    await expect(publishMode(store, { name: '  ' }, '', sanitizeModeDef, Math.random, 0)).rejects.toBeInstanceOf(CatalogError);
    await expect(publishMode(store, { name: 'x', rules: { big: 'y'.repeat(9000) } }, '', sanitizeModeDef, Math.random, 0)).rejects.toThrow('too_big');
    await expect(fetchMode(store, 'ZZZZZZ', sanitizeModeDef)).rejects.toThrow('not_found');
  });
});
