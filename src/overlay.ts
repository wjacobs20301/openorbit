import {
  Credit,
  DefaultProxy,
  Event,
  ImageryLayer,
  WebMercatorTilingScheme,
  type ImageryProvider,
  type Viewer,
} from 'cesium';
import type { VectorTile } from '@mapbox/vector-tile';
import { vectorTiles } from './sources';
import { features, loadVectorTile } from './vectortiles';

const TILE_SIZE = 512;

export type Painter = (ctx: CanvasRenderingContext2D, layer: string, props: Record<string, unknown>, z: number) => boolean;

/** Where a line overlay's vector tiles come from. */
export interface TileSource {
  load: (z: number, x: number, y: number) => Promise<VectorTile | null>;
  /** Most detailed zoom the source has; deeper tiles are drawn from it, scaled up. */
  maxZoom: number;
  credit: string;
}

const openMapTiles: TileSource = { load: loadVectorTile, maxZoom: vectorTiles.maximumLevel, credit: vectorTiles.credit };

/** Country and state borders. */
const paintBorders: Painter = (ctx, layer, p, z) => {
  if (layer !== 'boundary' || p.maritime === 1) return false;
  if (p.admin_level === 2) {
    ctx.setLineDash(p.disputed === 1 ? [6, 4] : []);
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.lineWidth = 4;
    return true;
  }
  if (p.admin_level === 4 && z >= 3) {
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
    ctx.lineWidth = 1.4;
    return true;
  }
  return false;
};

/** Second pass for country borders, drawn over their dark casing. */
const paintBorderCores: Painter = (ctx, layer, p) => {
  if (layer !== 'boundary' || p.maritime === 1 || p.admin_level !== 2) return false;
  ctx.setLineDash(p.disputed === 1 ? [6, 4] : []);
  ctx.strokeStyle = '#ffe17a';
  ctx.lineWidth = 1.8;
  return true;
};

const ROAD_STYLES: Record<string, { minZoom: number; width: number; color: string }> = {
  motorway: { minZoom: 6, width: 3, color: 'rgba(255, 196, 70, 0.95)' },
  trunk: { minZoom: 7, width: 2.6, color: 'rgba(255, 214, 110, 0.9)' },
  primary: { minZoom: 8, width: 2.2, color: 'rgba(255, 230, 150, 0.85)' },
  secondary: { minZoom: 10, width: 1.8, color: 'rgba(255, 255, 255, 0.8)' },
  tertiary: { minZoom: 11, width: 1.5, color: 'rgba(255, 255, 255, 0.75)' },
  minor: { minZoom: 13, width: 1.2, color: 'rgba(255, 255, 255, 0.6)' },
  service: { minZoom: 14, width: 0.9, color: 'rgba(255, 255, 255, 0.45)' },
};

const paintRoads: Painter = (ctx, layer, p, z) => {
  const style = layer === 'transportation' ? ROAD_STYLES[p.class as string] : undefined;
  if (!style || z < style.minZoom) return false;
  ctx.setLineDash(p.brunnel === 'tunnel' ? [4, 3] : []);
  ctx.strokeStyle = style.color;
  ctx.lineWidth = style.width;
  return true;
};

/**
 * Draws line features from vector tiles onto image tiles. Zoom levels beyond the
 * source's data reuse its most detailed tile, scaled up.
 */
export class VectorLineProvider {
  readonly tilingScheme = new WebMercatorTilingScheme();
  readonly rectangle = this.tilingScheme.rectangle;
  readonly tileWidth = TILE_SIZE;
  readonly tileHeight = TILE_SIZE;
  readonly minimumLevel = 0;
  readonly maximumLevel = 18;
  readonly tileDiscardPolicy = undefined;
  readonly errorEvent = new Event();
  readonly credit: Credit;
  readonly proxy = new DefaultProxy('');
  readonly hasAlphaChannel = true;

  constructor(
    private readonly layers: string[],
    private readonly passes: Painter[],
    private readonly source: TileSource = openMapTiles,
  ) {
    this.credit = new Credit(source.credit);
  }

  getTileCredits(): Credit[] {
    return [];
  }

  pickFeatures(): undefined {
    return undefined;
  }

  async requestImage(x: number, y: number, level: number): Promise<HTMLCanvasElement> {
    const dz = Math.max(0, level - this.source.maxZoom);
    const z = level - dz;
    const [sx, sy] = [x >> dz, y >> dz];
    const scale = 2 ** dz;
    const [ox, oy] = [x - sx * scale, y - sy * scale];

    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = TILE_SIZE;
    const tile = await this.source.load(z, sx, sy);
    if (!tile) return canvas;

    const ctx = canvas.getContext('2d')!;
    ctx.lineJoin = ctx.lineCap = 'round';
    const items = features(tile, this.layers);
    for (const paint of this.passes) {
      for (const { layer, feature, extent } of items) {
        if (feature.type !== 2 || !paint(ctx, layer, feature.properties, level)) continue;
        const k = (TILE_SIZE / extent) * scale;
        ctx.beginPath();
        for (const ring of feature.loadGeometry()) {
          ring.forEach((pt, i) => {
            const px = pt.x * k - ox * TILE_SIZE;
            const py = pt.y * k - oy * TILE_SIZE;
            if (i === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
          });
        }
        ctx.stroke();
      }
    }
    return canvas;
  }
}

export interface OverlayLayers {
  borders: ImageryLayer;
  roads: ImageryLayer;
}

/** Adds the borders and roads overlays on top of the imagery. */
export function addVectorOverlays(viewer: Viewer): OverlayLayers {
  const make = (layers: string[], passes: Painter[]) =>
    viewer.imageryLayers.addImageryProvider(new VectorLineProvider(layers, passes) as unknown as ImageryProvider);
  const roads = make(['transportation'], [paintRoads]);
  const borders = make(['boundary'], [paintBorders, paintBorderCores]);
  roads.show = false;
  return { borders, roads };
}
