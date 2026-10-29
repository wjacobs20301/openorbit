import { Math as CesiumMath, type Rectangle, type Viewer } from 'cesium';
import { isDesktop, viaCache } from './platform';
import { imagerySources, terrainSource } from './sources';

/** Upper bound per download, to stay a polite user of free tile services. */
const MAX_TILES = 4000;
const CONCURRENCY = 4;

interface Bounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

function lonToX(lon: number, z: number): number {
  return Math.floor(((lon + 180) / 360) * 2 ** z);
}

function latToY(lat: number, z: number): number {
  const r = CesiumMath.toRadians(Math.max(-85.0511, Math.min(85.0511, lat)));
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
}

/** Web Mercator tile URLs covering `b` at zoom `z`. */
function tileUrls(template: string, b: Bounds, z: number): string[] {
  const max = 2 ** z - 1;
  const [x0, x1] = [lonToX(b.west, z), Math.min(max, lonToX(b.east, z))];
  const [y0, y1] = [latToY(b.north, z), Math.min(max, latToY(b.south, z))];
  const urls: string[] = [];
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      urls.push(template.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y)));
    }
  }
  return urls;
}

function intersect(a: Bounds, b?: [number, number, number, number]): Bounds | null {
  if (!b) return a;
  const r = { west: Math.max(a.west, b[0]), south: Math.max(a.south, b[1]), east: Math.min(a.east, b[2]), north: Math.min(a.north, b[3]) };
  return r.west < r.east && r.south < r.north ? r : null;
}

/**
 * Plans the download: from the zoom where the view is about one tile wide, add levels
 * of detail until the next level would pass MAX_TILES. The few coarser tiles above the
 * area are included too, since the globe needs them before it can draw finer ones.
 */
export function planDownload(view: Rectangle, extraLevels: number): { urls: string[]; maxZoom: number } {
  const b: Bounds = {
    west: CesiumMath.toDegrees(view.west),
    south: CesiumMath.toDegrees(view.south),
    east: CesiumMath.toDegrees(view.east),
    north: CesiumMath.toDegrees(view.north),
  };
  if (b.east < b.west) b.east = 180; // View crosses the antimeridian; keep the western part.
  const startZoom = Math.max(0, Math.floor(Math.log2(360 / Math.max(b.east - b.west, 1e-6))));

  const sources = [
    ...imagerySources.filter((s) => s.offline && s.enabledByDefault),
    { url: terrainSource.url, maximumLevel: terrainSource.maximumLevel, bounds: undefined },
  ];

  const levelUrls = (z: number) =>
    sources.flatMap((s) => {
      const area = intersect(b, s.bounds);
      const visible = z <= s.maximumLevel && z >= ('showFromLevel' in s ? (s.showFromLevel ?? 0) : 0);
      return area && visible ? tileUrls(s.url, area, z) : [];
    });

  let urls: string[] = [];
  for (let z = 0; z < startZoom; z++) urls = urls.concat(levelUrls(z));
  let maxZoom = startZoom;
  for (let z = startZoom; z <= startZoom + extraLevels; z++) {
    const level = levelUrls(z);
    if (!level.length || urls.length + level.length > MAX_TILES) break;
    urls = urls.concat(level);
    maxZoom = z;
  }
  return { urls, maxZoom };
}

/** "Save this view for offline": prefetches tiles through the desktop disk cache. */
export function setupOffline(viewer: Viewer): void {
  const panel = document.querySelector<HTMLElement>('#offline-panel')!;
  panel.hidden = !isDesktop;
  if (!isDesktop) return;

  const detail = document.querySelector<HTMLSelectElement>('#offline-detail')!;
  const start = document.querySelector<HTMLButtonElement>('#offline-start')!;
  const status = document.querySelector<HTMLElement>('#offline-status')!;
  let running = false;
  let cancelled = false;

  start.addEventListener('click', async () => {
    if (running) {
      cancelled = true;
      return;
    }
    const view = viewer.camera.computeViewRectangle();
    if (!view) {
      status.textContent = 'Point the camera at the ground first.';
      return;
    }
    const { urls, maxZoom } = planDownload(view, Number(detail.value));
    if (!urls.length) {
      status.textContent = 'This view is too large. Zoom in and try again.';
      return;
    }

    running = true;
    cancelled = false;
    start.textContent = 'Cancel';
    let done = 0;
    let failed = 0;
    const queue = [...urls];
    const worker = async () => {
      while (queue.length && !cancelled) {
        const url = queue.shift()!;
        try {
          const res = await fetch(viaCache(url));
          if (!res.ok && res.status !== 404) failed++;
          await res.arrayBuffer();
        } catch {
          failed++;
        }
        done++;
        status.textContent = `Saving ${done.toLocaleString()} of ${urls.length.toLocaleString()} tiles…`;
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    status.textContent = cancelled
      ? `Stopped after ${done.toLocaleString()} tiles.`
      : `Saved ${done.toLocaleString()} tiles (detail to zoom ${maxZoom})${failed ? `, ${failed} failed` : ''}. This area now works offline.`;
    start.textContent = 'Save this view for offline';
    running = false;
  });
}
