import { VectorTile, type VectorTileFeature } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { loadSetting, storeSetting, viaCache } from './platform';
import { vectorTiles } from './sources';

/** Decoded tiles keep their raw buffer (up to ~0.5 MB for dense z14 tiles). */
const CACHE_LIMIT = 120;
const cache = new Map<string, Promise<VectorTile | null>>();
let template: Promise<string | null> | undefined;

/** The current tile URL template, remembered so cached tiles still resolve offline. */
export function tileTemplate(): Promise<string | null> {
  template ??= fetch(vectorTiles.tileJsonUrl)
    .then((res) => res.json() as Promise<{ tiles: string[] }>)
    .then(({ tiles }) => {
      storeSetting('vectorTileTemplate', tiles[0]);
      return tiles[0];
    })
    .catch(() => loadSetting('vectorTileTemplate') || null);
  return template;
}

/** Fetches and decodes one vector tile (z ≤ 14), memoised with a small LRU. */
export function loadVectorTile(z: number, x: number, y: number): Promise<VectorTile | null> {
  const key = `${z}/${x}/${y}`;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const promise = tileTemplate().then(async (url) => {
    if (!url) return null;
    try {
      const res = await fetch(viaCache(url.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y))));
      return res.ok ? new VectorTile(new PbfReader(await res.arrayBuffer())) : null;
    } catch {
      return null;
    }
  });
  cache.set(key, promise);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  return promise;
}

export interface TileFeature {
  layer: string;
  feature: VectorTileFeature;
  extent: number;
}

/** All features in the named layers of a tile. */
export function features(tile: VectorTile, layers: string[]): TileFeature[] {
  const out: TileFeature[] = [];
  for (const name of layers) {
    const layer = tile.layers[name];
    if (!layer) continue;
    for (let i = 0; i < layer.length; i++) out.push({ layer: name, feature: layer.feature(i), extent: layer.extent });
  }
  return out;
}

/** Converts a point inside tile z/x/y (in tile units) to [longitude, latitude]. */
export function tilePointToLonLat(z: number, x: number, y: number, px: number, py: number, extent: number): [number, number] {
  const n = 2 ** z;
  const lon = ((x + px / extent) / n) * 360 - 180;
  const merc = Math.PI * (1 - (2 * (y + py / extent)) / n);
  return [lon, (Math.atan(Math.sinh(merc)) * 180) / Math.PI];
}
