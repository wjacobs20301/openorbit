import { classifyRings } from '@mapbox/vector-tile';
import {
  Cartesian3,
  Cartographic,
  Color,
  ColorGeometryInstanceAttribute,
  GeometryInstance,
  PerInstanceColorAppearance,
  PolygonGeometry,
  PolygonHierarchy,
  Primitive,
  sampleTerrain,
  Math as CesiumMath,
  type Viewer,
} from 'cesium';
import { features, loadVectorTile, tilePointToLonLat } from './vectortiles';

/** Buildings exist in the vector tiles at this zoom. */
const TILE_ZOOM = 14;
/** Only show buildings when the camera is this close to the ground (metres). */
const MAX_VIEW_HEIGHT = 6000;
const MAX_TILES = 16;
const KEEP_TILES = 48;
const DEFAULT_COLOR = Color.fromCssColorString('#ece6da');
const DEFAULT_HEIGHT = 6;
/** Terrain level sampled for building bases (about 10 m detail). */
const TERRAIN_LEVEL = 13;

/**
 * OpenStreetMap buildings extruded in 3D from the vector tiles, built per z14 tile as
 * one batched primitive. Bases follow the terrain under each building.
 */
export class Buildings {
  private readonly tiles = new Map<string, Promise<Primitive | null>>();
  private visible = new Set<string>();
  private timer?: number;
  private enabled = true;

  constructor(private readonly viewer: Viewer) {
    viewer.camera.moveEnd.addEventListener(() => this.schedule());
    viewer.camera.changed.addEventListener(() => this.schedule());
    this.schedule();
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (on) this.schedule();
    else this.showOnly(new Set());
  }

  private schedule(): void {
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.update(), 300);
  }

  private update(): void {
    const { camera } = this.viewer;
    const ground = this.viewer.scene.globe.getHeight(camera.positionCartographic) ?? 0;
    const view = camera.computeViewRectangle();
    if (!this.enabled || !view || camera.positionCartographic.height - ground > MAX_VIEW_HEIGHT) {
      this.showOnly(new Set());
      return;
    }

    // Nearest tiles to the camera first, so a tilted view fills in from the foreground.
    const here = camera.positionCartographic;
    const n = 2 ** TILE_ZOOM;
    const cx = ((CesiumMath.toDegrees(here.longitude) + 180) / 360) * n;
    const cy = mercatorY(here.latitude) * n;
    const wanted = tileRange(view)
      .sort(([ax, ay], [bx, by]) => (ax + 0.5 - cx) ** 2 + (ay + 0.5 - cy) ** 2 - ((bx + 0.5 - cx) ** 2 + (by + 0.5 - cy) ** 2))
      .slice(0, MAX_TILES);

    const keys = new Set(wanted.map(([x, y]) => `${x}/${y}`));
    this.showOnly(keys);
    for (const [x, y] of wanted) {
      const key = `${x}/${y}`;
      if (this.tiles.has(key)) continue;
      const built = this.build(x, y);
      this.tiles.set(key, built);
      void built.then((p) => p && (p.show = this.enabled && this.visible.has(key)));
    }
    this.evict(keys);
  }

  private showOnly(keys: Set<string>): void {
    this.visible = keys;
    for (const [key, promise] of this.tiles) {
      void promise.then((p) => p && (p.show = this.enabled && this.visible.has(key)));
    }
  }

  /** Drops the oldest hidden tiles once more than KEEP_TILES are built. */
  private evict(keep: Set<string>): void {
    for (const key of this.tiles.keys()) {
      if (this.tiles.size <= KEEP_TILES) break;
      if (keep.has(key)) continue;
      const promise = this.tiles.get(key)!;
      this.tiles.delete(key);
      void promise.then((p) => p && this.viewer.scene.primitives.remove(p));
    }
  }

  private async build(x: number, y: number): Promise<Primitive | null> {
    const tile = await loadVectorTile(TILE_ZOOM, x, y);
    if (!tile) return null;

    interface Footprint {
      rings: [number, number][][];
      bottom: number;
      top: number;
      color: Color;
    }
    const footprints: Footprint[] = [];
    for (const { feature, extent } of features(tile, ['building'])) {
      const p = feature.properties;
      if (feature.type !== 3 || p.hide_3d === true) continue;
      const top = Number(p.render_height ?? DEFAULT_HEIGHT);
      const bottom = Number(p.render_min_height ?? 0);
      if (top <= bottom) continue;
      // OSM colours are often pure black or white; soften them towards a neutral stone.
      const tagged = typeof p.colour === 'string' ? Color.fromCssColorString(p.colour) : undefined;
      const color = tagged ? Color.lerp(tagged, DEFAULT_COLOR, 0.35, new Color()) : DEFAULT_COLOR;
      for (const polygon of classifyRings(feature.loadGeometry())) {
        const rings = polygon.map((ring) => ring.map((pt) => tilePointToLonLat(TILE_ZOOM, x, y, pt.x, pt.y, extent)));
        if (rings[0].length >= 4) footprints.push({ rings, bottom, top, color });
      }
    }
    if (!footprints.length) return null;

    // Ground height under each building, from the same terrain the globe draws.
    const grounds = await sampleTerrain(
      this.viewer.terrainProvider,
      TERRAIN_LEVEL,
      footprints.map((f) => Cartographic.fromDegrees(...f.rings[0][0])),
    ).catch(() => []);

    const toCartesians = (ring: [number, number][]) => Cartesian3.fromDegreesArray(ring.flat());
    const instances = footprints.map(({ rings: [outer, ...holes], bottom, top, color }, i) => {
      const base = grounds[i]?.height ?? 0;
      return new GeometryInstance({
        geometry: new PolygonGeometry({
          polygonHierarchy: new PolygonHierarchy(
            toCartesians(outer),
            holes.map((h) => new PolygonHierarchy(toCartesians(h))),
          ),
          height: base + bottom,
          extrudedHeight: base + top,
          vertexFormat: PerInstanceColorAppearance.VERTEX_FORMAT,
        }),
        attributes: { color: ColorGeometryInstanceAttribute.fromColor(color) },
      });
    });
    if (!instances.length) return null;

    return this.viewer.scene.primitives.add(
      new Primitive({
        geometryInstances: instances,
        appearance: new PerInstanceColorAppearance({ translucent: false, closed: true }),
        asynchronous: true,
        show: false,
      }),
    );
  }
}

function mercatorY(lat: number): number {
  const r = Math.max(-1.4844, Math.min(1.4844, lat));
  return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2;
}

function tileRange(view: { west: number; south: number; east: number; north: number }): [number, number][] {
  const n = 2 ** TILE_ZOOM;
  const toX = (lon: number) => Math.min(n - 1, Math.max(0, Math.floor(((CesiumMath.toDegrees(lon) + 180) / 360) * n)));
  const out: [number, number][] = [];
  const [y0, y1] = [Math.floor(mercatorY(view.north) * n), Math.floor(mercatorY(view.south) * n)];
  for (let x = toX(view.west); x <= toX(view.east); x++) for (let y = y0; y <= y1; y++) out.push([x, y]);
  return out;
}
