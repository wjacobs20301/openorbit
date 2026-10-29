import { UrlTemplateImageryProvider, type ImageryTypes, type Request } from 'cesium';

/** Returns true for a [lon, lat] (degrees) where the layer has no business drawing. */
export type OutsideTest = (lon: number, lat: number) => boolean;

/** Channel values at or beyond these count as no-data white/black (JPEG edges aren't exact). */
const WHITE = 248;
const BLACK = 6;

/**
 * Some servers fill areas outside their coverage with solid white or black instead of
 * leaving them empty (USGS does both). This provider makes those areas transparent so
 * the layer below shows through. Only white/black regions connected to the tile edge
 * are cleared, so bright roofs or dark water inside real imagery stay intact.
 */
export class NoDataImageryProvider extends UrlTemplateImageryProvider {
  /** Optional coverage limit: pixels where this returns true are cleared too. */
  outside?: OutsideTest;

  override requestImage(x: number, y: number, level: number, request?: Request): Promise<ImageryTypes> | undefined {
    const pending = super.requestImage(x, y, level, request);
    return pending?.then((image) =>
      clearNoData(image as CanvasImageSource & { width: number; height: number }, x, y, level, this.outside),
    );
  }
}

function clearNoData(
  image: CanvasImageSource & { width: number; height: number },
  tx: number,
  ty: number,
  level: number,
  outside?: OutsideTest,
): HTMLCanvasElement {
  const { width: w, height: h } = image;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(image, 0, 0);
  const pixels = ctx.getImageData(0, 0, w, h);
  const d = pixels.data;

  const kind = (i: number) => {
    const [r, g, b] = [d[i * 4], d[i * 4 + 1], d[i * 4 + 2]];
    if (r >= WHITE && g >= WHITE && b >= WHITE) return 1;
    if (r <= BLACK && g <= BLACK && b <= BLACK) return 2;
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
  return canvas;
}
