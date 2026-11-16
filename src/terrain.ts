import { Credit, CustomHeightmapTerrainProvider, GeographicTilingScheme, Math as CesiumMath } from 'cesium';
import { viaCache } from './platform';
import { bathymetrySource, terrainSource } from './sources';

const SAMPLES = 65;
const MAX_LAT = 85.0511;
const CACHE_LIMIT = 256;
/** How many levels up a missing land tile may borrow from before it counts as sea. */
const MAX_ANCESTORS = 4;

interface TileSet {
  template: string;
  size: number;
  maxZoom: number;
}

const LAND: TileSet = { template: viaCache(terrainSource.url), size: terrainSource.tileSize, maxZoom: terrainSource.maximumLevel };
const SEA: TileSet = {
  template: viaCache(bathymetrySource.url),
  size: bathymetrySource.tileSize,
  maxZoom: bathymetrySource.maximumLevel,
};

/** Decoded Terrarium tiles keyed by set and z/x/y; a null value means the tile was missing. */
const tileCache = new Map<string, Promise<Float32Array | null>>();
/** Land tiles known to be missing ("z/x/y"). Their descendants are missing too. */
const missingLand = new Set<string>();

function loadTile(set: TileSet, z: number, x: number, y: number): Promise<Float32Array | null> {
  const key = `${set.template}|${z}/${x}/${y}`;
  const hit = tileCache.get(key);
  if (hit) {
    tileCache.delete(key);
    tileCache.set(key, hit);
    return hit;
  }
  const url = set.template.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
  const promise = fetch(url)
    .then(async (res) => {
      if (!res.ok) return null;
      const bitmap = await createImageBitmap(await res.blob());
      const canvas = new OffscreenCanvas(set.size, set.size);
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(bitmap, 0, 0, set.size, set.size);
      const { data } = ctx.getImageData(0, 0, set.size, set.size);
      const heights = new Float32Array(set.size * set.size);
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

function landKnownMissing(z: number, x: number, y: number): boolean {
  for (let k = 0; k <= z; k++) if (missingLand.has(`${z - k}/${x >> k}/${y >> k}`)) return true;
  return false;
}

/**
 * The land tile covering z/x/y, or its nearest existing ancestor (up to MAX_ANCESTORS
 * levels up: past Mapterhorn's deepest survey data it stops at a coarser zoom).
 */
async function landTile(z: number, x: number, y: number): Promise<{ data: Float32Array; z: number } | null> {
  for (let up = 0; up <= MAX_ANCESTORS && up <= z; up++) {
    const [tz, tx, ty] = [z - up, x >> up, y >> up];
    if (landKnownMissing(tz, tx, ty)) continue;
    const data = await loadTile(LAND, tz, tx, ty);
    if (data) return { data, z: tz };
    missingLand.add(`${tz}/${tx}/${ty}`);
  }
  return null;
}

/** Heights at Web Mercator [0, 1] points from one tile set at one zoom; null where missing. */
async function sample(
  points: { mx: number; my: number }[],
  z: number,
  load: (z: number, x: number, y: number) => Promise<{ data: Float32Array; z: number } | null>,
  size: number,
): Promise<(number | null)[]> {
  const n = 2 ** z;
  const tiles = new Map<string, Promise<{ data: Float32Array; z: number } | null>>();
  const tileFor = (tx: number, ty: number) => {
    const key = `${tx}/${ty}`;
    if (!tiles.has(key)) tiles.set(key, load(z, tx, ty));
    return tiles.get(key)!;
  };
  return Promise.all(
    points.map(async ({ mx, my }) => {
      const tx = Math.min(n - 1, Math.floor(mx * n));
      const ty = Math.min(n - 1, Math.floor(my * n));
      const tile = await tileFor(tx, ty);
      if (!tile) return null;
      // The tile may be an ancestor: locate the point within it.
      const tn = 2 ** tile.z;
      const local = (v: number) => v * tn - Math.min(tn - 1, Math.floor(v * tn));
      const px = Math.min(size - 1, Math.floor(local(mx) * size));
      const py = Math.min(size - 1, Math.floor(local(my) * size));
      return tile.data[py * size + px];
    }),
  );
}

/**
 * Terrain from public Terrarium tiles (Web Mercator), resampled into Cesium's geographic
 * tiling so the poles are covered and no terrain server is needed. Land comes from
 * Mapterhorn; the sea floor, which Mapterhorn leaves at 0, from the AWS Terrain Tiles.
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
      const points: { mx: number; my: number }[] = [];
      for (let row = 0; row < SAMPLES; row++) {
        const lat = CesiumMath.toDegrees(rect.north - (row / (SAMPLES - 1)) * rect.height);
        const latR = CesiumMath.toRadians(Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)));
        const my = (1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2;
        for (let col = 0; col < SAMPLES; col++) {
          const lon = CesiumMath.toDegrees(rect.west + (col / (SAMPLES - 1)) * rect.width);
          points.push({ mx: (lon + 180) / 360, my });
        }
      }

      // A geographic tile at level L is as wide as a 256 px Mercator tile at L + 1, or a
      // 512 px one at L - 1 drawn at twice the 65 samples across.
      const landZoom = Math.max(0, Math.min(level - 1, LAND.maxZoom));
      const land = await sample(points, landZoom, landTile, LAND.size);

      const out = new Float32Array(SAMPLES * SAMPLES);
      const seaIndexes: number[] = [];
      land.forEach((h, i) => {
        if (h === null || h === 0) seaIndexes.push(i);
        else out[i] = h;
      });
      if (seaIndexes.length) {
        const seaZoom = Math.max(0, Math.min(level + 1, SEA.maxZoom));
        const loadSea = async (z: number, tx: number, ty: number) => {
          const data = await loadTile(SEA, z, tx, ty);
          return data && { data, z };
        };
        const sea = await sample(seaIndexes.map((i) => points[i]), seaZoom, loadSea, SEA.size);
        seaIndexes.forEach((index, j) => {
          const depth = sea[j] ?? 0;
          // Where Mapterhorn says 0 it is sea or at sea level: only take depths from the
          // coarser sea-floor data, never heights, so coastlines stay Mapterhorn's.
          out[index] = land[index] === null ? depth : Math.min(0, depth);
        });
      }
      return out;
    },
  });
}
