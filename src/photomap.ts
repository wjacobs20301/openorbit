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

const ZOOM = 15;
const CACHE_LIMIT = 16;
const cache = new Map<string, Promise<PhotoSpot[]>>();

function loadTile(x: number, y: number): Promise<PhotoSpot[]> {
  const key = `${x}/${y}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const url = streetSources.panoramaxTiles.replace('{z}', String(ZOOM)).replace('{x}', String(x)).replace('{y}', String(y));
  const promise = fetch(viaCache(url))
    .then(async (res) => {
      if (!res.ok) return [];
      const layer = new VectorTile(new PbfReader(await res.arrayBuffer())).layers.pictures;
      const spots: PhotoSpot[] = [];
      for (let i = 0; layer && i < layer.length; i++) {
        const f = layer.feature(i);
        const pt = f.loadGeometry()[0][0];
        const [lon, lat] = tilePointToLonLat(ZOOM, x, y, pt.x, pt.y, layer.extent);
        spots.push({ id: String(f.properties.id), sequence: String(f.properties.first_sequence ?? ''), lon, lat });
      }
      return spots;
    })
    .catch(() => {
      cache.delete(key);
      return [];
    });
  cache.set(key, promise);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  return promise;
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
