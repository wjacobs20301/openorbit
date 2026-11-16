import { ImageryProvider, UrlTemplateImageryProvider, type ImageryTypes, type Request } from 'cesium';

/** Returns true for a [lon, lat] (degrees) where the layer has no business drawing. */
export type OutsideTest = (lon: number, lat: number) => boolean;

/** Channel values at or beyond these count as no-data white/black (JPEG edges aren't exact). */
const WHITE = 248;
const BLACK = 6;
/** How far a pixel may stray from a source's own fill colour and still count as fill. */
const FILL_TOLERANCE = 4;

export type Image = CanvasImageSource & { width: number; height: number };

/** What a regional layer should leave transparent, beyond plain white/black fill. */
export interface CoverageOptions {
  /** Pixels where this returns true are cleared. */
  outside?: OutsideTest;
  /** A flat colour the server paints where it has no imagery (besides white and black). */
  fillColour?: [number, number, number];
  /** Outline the layer is clipped to: rings of flat [lon, lat, ...] (even-odd fill). */
  mask?: number[][];
  /** Outlines the layer leaves out, where another layer's country is drawn instead. */
  exclude?: number[][][];
  /**
   * A missing tile (404) is filled from its parent up to `levels` levels up (never above
   * `minLevel`), and otherwise left empty. Cesium's own fallback would reach all the way
   * back to world-scale tiles, which for some servers show neighbouring countries.
   */
  missing?: { template: string; minLevel: number; levels: number };
}

/** An empty tile, for places a layer has nothing to draw. */
const EMPTY = (() => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  return canvas;
})();

/**
 * The tile on a canvas with north at the top. Cesium loads imagery as ImageBitmaps that
 * are already flipped upside down for WebGL (where it can; otherwise as plain images).
 * A canvas is uploaded with WebGL's own flip, so the result displays the same either way.
 */
function upright(image: Image): HTMLCanvasElement {
  if (image instanceof HTMLCanvasElement) return image;
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  if (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap) {
    ctx.translate(0, image.height);
    ctx.scale(1, -1);
  }
  ctx.drawImage(image, 0, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return canvas;
}

/** Web Mercator [0, 1] coordinates of a latitude, as in the tile y axis. */
function mercatorY(lat: number): number {
  const r = (Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180;
  return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2;
}

/** A coverage outline in Web Mercator [0, 1] coordinates, with per-ring bounding boxes. */
class Mask {
  private readonly rings: { points: Float64Array; box: [number, number, number, number] }[];

  constructor(rings: number[][]) {
    this.rings = rings.map((flat) => {
      const points = new Float64Array(flat.length);
      const box: [number, number, number, number] = [1, 1, 0, 0];
      for (let i = 0; i < flat.length; i += 2) {
        const x = (flat[i] + 180) / 360;
        const y = mercatorY(flat[i + 1]);
        points[i] = x;
        points[i + 1] = y;
        box[0] = Math.min(box[0], x);
        box[1] = Math.min(box[1], y);
        box[2] = Math.max(box[2], x);
        box[3] = Math.max(box[3], y);
      }
      return { points, box };
    });
  }

  private ringsIn(x: number, y: number, level: number) {
    const n = 2 ** level;
    const [w, s, e, nn] = [x / n, (y + 1) / n, (x + 1) / n, y / n];
    return this.rings.filter(({ box }) => box[0] < e && box[2] > w && box[1] < s && box[3] > nn);
  }

  /** Whether any part of the outline reaches into this tile. */
  touches(x: number, y: number, level: number): boolean {
    return this.ringsIn(x, y, level).length > 0;
  }

  /** Clears everything in the tile outside the outline (or inside it, with `inside`). */
  clip(ctx: CanvasRenderingContext2D, x: number, y: number, level: number, w: number, h: number, inside = false): void {
    const rings = this.ringsIn(x, y, level);
    if (inside && !rings.length) return;
    const n = 2 ** level;
    const path = new Path2D();
    for (const { points } of rings) {
      path.moveTo((points[0] * n - x) * w, (points[1] * n - y) * h);
      for (let i = 2; i < points.length; i += 2) path.lineTo((points[i] * n - x) * w, (points[i + 1] * n - y) * h);
      path.closePath();
    }
    ctx.globalCompositeOperation = inside ? 'destination-out' : 'destination-in';
    ctx.fill(path, 'evenodd');
    ctx.globalCompositeOperation = 'source-over';
  }
}

/**
 * Some servers fill areas outside their coverage with solid white or black instead of
 * leaving them empty (USGS does both). This provider makes those areas transparent so
 * the layer below shows through. Only white/black regions connected to the tile edge
 * are cleared, so bright roofs or dark water inside real imagery stay intact. It can
 * also clip a layer to a country outline and stop missing tiles reaching far back.
 */
export class NoDataImageryProvider extends UrlTemplateImageryProvider {
  private coverage: CoverageOptions = {};
  private mask?: Mask;
  private exclude: Mask[] = [];

  setCoverage(options: CoverageOptions): void {
    this.coverage = options;
    this.mask = options.mask ? new Mask(options.mask) : undefined;
    this.exclude = (options.exclude ?? []).map((rings) => new Mask(rings));
  }

  override requestImage(x: number, y: number, level: number, request?: Request): Promise<ImageryTypes> | undefined {
    // Nothing of the country in this tile: skip the download altogether.
    if (this.mask && !this.mask.touches(x, y, level)) return Promise.resolve(EMPTY);
    const pending = this.loadTile(x, y, level, request);
    if (!pending) return undefined;
    const loaded: Promise<Image | undefined> = this.coverage.missing
      ? pending.catch(() => this.fromParent(x, y, level))
      : pending;
    return loaded.then((image) => (image ? this.clean(image, x, y, level) : EMPTY));
  }

  /**
   * Fetches one tile; undefined when throttled (Cesium asks again later). A promise that
   * resolves to undefined means the tile doesn't exist. Subclasses read other sources.
   */
  protected loadTile(x: number, y: number, level: number, request?: Request): Promise<Image | undefined> | undefined {
    return super.requestImage(x, y, level, request) as Promise<Image> | undefined;
  }

  /** The matching quarter (or smaller) of a parent tile, scaled up; undefined if none. */
  private async fromParent(x: number, y: number, level: number): Promise<Image | undefined> {
    const { template, minLevel, levels } = this.coverage.missing!;
    for (let up = 1; up <= levels && level - up >= minLevel; up++) {
      const [px, py, pz] = [x >> up, y >> up, level - up];
      const url = template.replace('{z}', String(pz)).replace('{x}', String(px)).replace('{y}', String(py));
      try {
        const loaded = (await ImageryProvider.loadImage(this, url)) as Image | undefined;
        if (!loaded) continue;
        const parent = upright(loaded);
        const size = parent.width / 2 ** up;
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = parent.width;
        canvas.getContext('2d')!.drawImage(
          parent,
          (x - (px << up)) * size,
          (y - (py << up)) * size,
          size,
          size,
          0,
          0,
          parent.width,
          parent.width,
        );
        return canvas;
      } catch {
        // Missing too: try one level further up.
      }
    }
    return undefined;
  }

  private clean(image: Image, tx: number, ty: number, level: number): HTMLCanvasElement {
    const canvas = upright(image);
    const { width: w, height: h } = canvas;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    clearNoData(ctx, w, h, tx, ty, level, this.coverage);
    this.mask?.clip(ctx, tx, ty, level, w, h);
    for (const other of this.exclude) other.clip(ctx, tx, ty, level, w, h, true);
    return canvas;
  }
}

function clearNoData(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  tx: number,
  ty: number,
  level: number,
  { outside, fillColour }: CoverageOptions,
): void {
  const pixels = ctx.getImageData(0, 0, w, h);
  const d = pixels.data;

  const kind = (i: number) => {
    const [r, g, b] = [d[i * 4], d[i * 4 + 1], d[i * 4 + 2]];
    if (d[i * 4 + 3] === 0) return 0;
    if (r >= WHITE && g >= WHITE && b >= WHITE) return 1;
    if (r <= BLACK && g <= BLACK && b <= BLACK) return 2;
    if (
      fillColour &&
      Math.abs(r - fillColour[0]) <= FILL_TOLERANCE &&
      Math.abs(g - fillColour[1]) <= FILL_TOLERANCE &&
      Math.abs(b - fillColour[2]) <= FILL_TOLERANCE
    )
      return 3;
    return 0;
  };

  // Flood fill inward from every edge pixel through pixels of the same no-data colour.
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  for (let x = 0; x < w; x++) stack.push(x, (h - 1) * w + x);
  for (let y = 0; y < h; y++) stack.push(y * w, y * w + w - 1);
  let cleared = 0;
  while (stack.length) {
    const i = stack.pop()!;
    if (seen[i]) continue;
    seen[i] = 1;
    if (!kind(i)) continue;
    d[i * 4 + 3] = 0;
    cleared++;
    const x = i % w;
    if (x > 0) stack.push(i - 1);
    if (x < w - 1) stack.push(i + 1);
    if (i >= w) stack.push(i - w);
    if (i < w * (h - 1)) stack.push(i + w);
  }

  if (outside) {
    // Web Mercator tile: longitude per column, latitude per row.
    const n = 2 ** level;
    const lons = Array.from({ length: w }, (_, px) => ((tx + (px + 0.5) / w) / n) * 360 - 180);
    for (let py = 0; py < h; py++) {
      const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (ty + (py + 0.5) / h)) / n))) * 180) / Math.PI;
      for (let px = 0; px < w; px++) {
        if (outside(lons[px], lat)) {
          d[(py * w + px) * 4 + 3] = 0;
          cleared++;
        }
      }
    }
  }

  if (cleared) ctx.putImageData(pixels, 0, 0);
}
