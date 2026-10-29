import { Credit, CustomHeightmapTerrainProvider, GeographicTilingScheme, Math as CesiumMath } from 'cesium';
import { viaCache } from './platform';
import { terrainSource } from './sources';

const SAMPLES = 65;
const TILE_PX = 256;
const MAX_LAT = 85.0511;
const CACHE_LIMIT = 256;

/** Decoded Terrarium tiles keyed by z/x/y; a null value means the tile was missing. */
const tileCache = new Map<string, Promise<Float32Array | null>>();
const template = viaCache(terrainSource.url);

function loadTerrariumTile(z: number, x: number, y: number): Promise<Float32Array | null> {
  const key = `${z}/${x}/${y}`;
  const hit = tileCache.get(key);
  if (hit) {
    tileCache.delete(key);
    tileCache.set(key, hit);
    return hit;
  }
  const url = template.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
  const promise = fetch(url)
    .then(async (res) => {
      if (!res.ok) return null;
      const bitmap = await createImageBitmap(await res.blob());
      const canvas = new OffscreenCanvas(TILE_PX, TILE_PX);
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(bitmap, 0, 0);
      const { data } = ctx.getImageData(0, 0, TILE_PX, TILE_PX);
      const heights = new Float32Array(TILE_PX * TILE_PX);
      for (let i = 0; i < heights.length; i++) {
        // Terrarium encoding: (R * 256 + G + B / 256) - 32768 metres.
        heights[i] = data[i * 4] * 256 + data[i * 4 + 1] + data[i * 4 + 2] / 256 - 32768;
      }
      return heights;
    })
    .catch(() => null);
  tileCache.set(key, promise);
  if (tileCache.size > CACHE_LIMIT) tileCache.delete(tileCache.keys().next().value!);
  return promise;
}

/**
 * Terrain from the public AWS Terrain Tiles (Web Mercator, Terrarium PNG), resampled into
 * Cesium's geographic tiling so the poles are covered and no terrain server is needed.
 */
export function createTerrainProvider(): CustomHeightmapTerrainProvider {
  const tilingScheme = new GeographicTilingScheme();

  return new CustomHeightmapTerrainProvider({
    width: SAMPLES,
    height: SAMPLES,
    tilingScheme,
    credit: new Credit(terrainSource.credit),
    callback: async (x, y, level) => {
      const rect = tilingScheme.tileXYToRectangle(x, y, level);
      // A geographic tile at level L is as wide as a Mercator tile at L + 1.
      const z = Math.min(level + 1, terrainSource.maximumLevel);
      const n = 2 ** z;

      const out = new Float32Array(SAMPLES * SAMPLES);
      const lookups: { index: number; tx: number; ty: number; px: number; py: number }[] = [];
      const needed = new Map<string, [number, number]>();

      for (let row = 0; row < SAMPLES; row++) {
        const lat = CesiumMath.toDegrees(rect.north - (row / (SAMPLES - 1)) * rect.height);
        const latR = CesiumMath.toRadians(Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)));
        const my = ((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2) * n;
        for (let col = 0; col < SAMPLES; col++) {
          const lon = CesiumMath.toDegrees(rect.west + (col / (SAMPLES - 1)) * rect.width);
          const mx = ((lon + 180) / 360) * n;
          const tx = Math.min(n - 1, Math.max(0, Math.floor(mx)));
          const ty = Math.min(n - 1, Math.max(0, Math.floor(my)));
          const px = Math.min(TILE_PX - 1, Math.floor((mx - tx) * TILE_PX));
          const py = Math.min(TILE_PX - 1, Math.floor((my - ty) * TILE_PX));
          lookups.push({ index: row * SAMPLES + col, tx, ty, px, py });
          needed.set(`${tx}/${ty}`, [tx, ty]);
        }
      }

      const tiles = new Map<string, Float32Array | null>();
      await Promise.all(
        [...needed].map(async ([key, [tx, ty]]) => tiles.set(key, await loadTerrariumTile(z, tx, ty))),
      );

      for (const { index, tx, ty, px, py } of lookups) {
        const tile = tiles.get(`${tx}/${ty}`);
        out[index] = tile ? tile[py * TILE_PX + px] : 0;
      }
      return out;
    },
  });
}
