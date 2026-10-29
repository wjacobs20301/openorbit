import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { viaCache } from './platform';
import { streetSources } from './sources';
import { tilePointToLonLat } from './vectortiles';

/** Where a street photo was taken, without the photo itself. */
export interface PhotoSpot {
  id: string;
  /** Capture trip (sequence) the photo belongs to. */
  sequence: string;
  lon: number;
  lat: number;
}

/** Most detailed zoom of Panoramax's map tiles. */
export const PHOTO_TILE_ZOOM = 15;
const ZOOM = PHOTO_TILE_ZOOM;
const CACHE_LIMIT = 24;
const tiles = new Map<string, Promise<VectorTile | null>>();
const spotCache = new Map<string, Promise<PhotoSpot[]>>();

/** One Panoramax map tile (photo positions and capture-trip lines), memoised. */
export function loadPhotoTile(z: number, x: number, y: number): Promise<VectorTile | null> {
  const key = `${z}/${x}/${y}`;
  const hit = tiles.get(key);
  if (hit) return hit;
  const url = streetSources.panoramaxTiles.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
  const promise = fetch(viaCache(url))
    .then(async (res) => (res.ok && res.status !== 204 ? new VectorTile(new PbfReader(await res.arrayBuffer())) : null))
    .catch(() => {
      tiles.delete(key);
      return null;
    });
  tiles.set(key, promise);
  if (tiles.size > CACHE_LIMIT) tiles.delete(tiles.keys().next().value!);
  return promise;
}

function loadTile(x: number, y: number): Promise<PhotoSpot[]> {
  const key = `${x}/${y}`;
  const hit = spotCache.get(key);
  if (hit) return hit;
  const promise = loadPhotoTile(ZOOM, x, y).then((tile) => {
    const layer = tile?.layers.pictures;
    const spots: PhotoSpot[] = [];
    for (let i = 0; layer && i < layer.length; i++) {
      const f = layer.feature(i);
      const pt = f.loadGeometry()[0][0];
      const [lon, lat] = tilePointToLonLat(ZOOM, x, y, pt.x, pt.y, layer.extent);
      spots.push({ id: String(f.properties.id), sequence: String(f.properties.first_sequence ?? ''), lon, lat });
    }
    return spots;
  });
  spotCache.set(key, promise);
  if (spotCache.size > CACHE_LIMIT) spotCache.delete(spotCache.keys().next().value!);
  return promise;
}

/** The photo nearest a point within `radius` metres, or null. */
export async function nearestPhoto(lon: number, lat: number, radius: number): Promise<PhotoSpot | null> {
  const kx = 111_320 * Math.cos((lat * Math.PI) / 180);
  let best: PhotoSpot | null = null;
  let bestDist = radius;
  for (const s of await photosNear(lon, lat, radius)) {
    const d = Math.hypot((s.lon - lon) * kx, (s.lat - lat) * 111_320);
    if (d <= bestDist) [best, bestDist] = [s, d];
  }
  return best;
}

/** Photo positions within `radius` metres, from Panoramax's map tiles (positions only). */
export async function photosNear(lon: number, lat: number, radius: number): Promise<PhotoSpot[]> {
  const n = 2 ** ZOOM;
  const metresPerDegLat = 111_320;
  const dLat = radius / metresPerDegLat;
  const dLon = radius / (metresPerDegLat * Math.cos((lat * Math.PI) / 180));
  const toX = (lo: number) => Math.floor(((lo + 180) / 360) * n);
  const toY = (la: number) => {
    const r = (la * Math.PI) / 180;
    return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
  };
  const tiles: [number, number][] = [];
  for (let x = toX(lon - dLon); x <= toX(lon + dLon); x++) {
    for (let y = toY(lat + dLat); y <= toY(lat - dLat); y++) tiles.push([x, y]);
  }
  const all = (await Promise.all(tiles.map(([x, y]) => loadTile(x, y)))).flat();
  return all.filter((s) => Math.abs(s.lon - lon) <= dLon && Math.abs(s.lat - lat) <= dLat);
}
