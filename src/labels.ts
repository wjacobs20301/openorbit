import {
  Cartesian2,
  Cartesian3,
  Color,
  Ellipsoid,
  EllipsoidalOccluder,
  HeightReference,
  LabelCollection,
  LabelStyle,
  Math as CesiumMath,
  SceneTransforms,
  VerticalOrigin,
  type Viewer,
} from 'cesium';
import { features, loadVectorTile, tilePointToLonLat } from './vectortiles';

interface PlaceStyle {
  /** Lower draws first and wins overlaps. */
  priority: number;
  font: string;
  color: string;
  upper?: boolean;
}

const STYLES: Record<string, PlaceStyle> = {
  ocean: { priority: 0, font: 'italic 15px system-ui, sans-serif', color: '#bfe3ff', upper: true },
  continent: { priority: 0, font: '600 15px system-ui, sans-serif', color: '#ffffff', upper: true },
  country: { priority: 1, font: '600 14px system-ui, sans-serif', color: '#ffffff', upper: true },
  sea: { priority: 2, font: 'italic 13px system-ui, sans-serif', color: '#bfe3ff' },
  state: { priority: 3, font: 'italic 12px system-ui, sans-serif', color: '#f2f2f2' },
  city: { priority: 4, font: '600 14px system-ui, sans-serif', color: '#ffffff' },
  town: { priority: 5, font: '13px system-ui, sans-serif', color: '#ffffff' },
  village: { priority: 6, font: '12px system-ui, sans-serif', color: '#f0f0f0' },
  suburb: { priority: 7, font: '12px system-ui, sans-serif', color: '#e8e8e8' },
  quarter: { priority: 8, font: '11px system-ui, sans-serif', color: '#e0e0e0' },
  neighbourhood: { priority: 8, font: '11px system-ui, sans-serif', color: '#e0e0e0' },
  hamlet: { priority: 9, font: '11px system-ui, sans-serif', color: '#e0e0e0' },
  island: { priority: 6, font: 'italic 12px system-ui, sans-serif', color: '#ffffff' },
  lake: { priority: 6, font: 'italic 12px system-ui, sans-serif', color: '#bfe3ff' },
  bay: { priority: 7, font: 'italic 12px system-ui, sans-serif', color: '#bfe3ff' },
};

const MAX_TILES = 24;
const MAX_LABELS = 250;
const PADDING = 6;

interface Candidate {
  text: string;
  lon: number;
  lat: number;
  style: PlaceStyle;
  rank: number;
}

/** Vector-tile zoom that roughly matches what the camera can resolve. */
function zoomForHeight(height: number): number {
  return Math.max(1, Math.min(14, Math.round(Math.log2(3e7 / Math.max(height, 1)))));
}

/**
 * Place names from OpenStreetMap vector tiles, drawn as upright labels. Rebuilt after
 * the camera stops moving, keeping the most important names that don't overlap.
 */
export class PlaceLabels {
  private readonly labels: LabelCollection;
  private generation = 0;
  private timer?: number;
  private enabled = true;

  constructor(private readonly viewer: Viewer) {
    this.labels = viewer.scene.primitives.add(new LabelCollection({ scene: viewer.scene }));
    viewer.camera.moveEnd.addEventListener(() => this.schedule());
    viewer.camera.percentageChanged = 0.2;
    viewer.camera.changed.addEventListener(() => this.schedule());
    this.schedule();
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.labels.show = on;
    this.viewer.scene.requestRender();
    if (on) this.schedule();
  }

  private schedule(): void {
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.update(), 250);
  }

  private async update(): Promise<void> {
    if (!this.enabled) return;
    const generation = ++this.generation;
    const { camera } = this.viewer;
    const view = camera.computeViewRectangle();
    if (!view) return;

    let z = zoomForHeight(camera.positionCartographic.height);
    let tiles = tileRange(view, z);
    while (tiles.length > MAX_TILES && z > 1) tiles = tileRange(view, --z);

    const candidates: Candidate[] = [];
    const seen = new Set<string>();
    await Promise.all(
      tiles.map(async ([x, y]) => {
        const tile = await loadVectorTile(z, x, y);
        if (!tile) return;
        for (const { feature, extent } of features(tile, ['place', 'water_name'])) {
          const p = feature.properties;
          const style = STYLES[p.class as string];
          const name = (p['name:en'] ?? p.name_en ?? p.name) as string | undefined;
          if (!style || !name || feature.type !== 1) continue;
          const pt = feature.loadGeometry()[0][0];
          const [lon, lat] = tilePointToLonLat(z, x, y, pt.x, pt.y, extent);
          const key = `${name}|${lon.toFixed(2)}|${lat.toFixed(2)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          candidates.push({ text: style.upper ? name.toUpperCase() : name, lon, lat, style, rank: Number(p.rank ?? 99) });
        }
      }),
    );
    if (generation !== this.generation) return;

    candidates.sort((a, b) => a.style.priority - b.style.priority || a.rank - b.rank);
    this.place(candidates);
  }

  /** Greedy placement in priority order, skipping labels that would overlap on screen. */
  private place(candidates: Candidate[]): void {
    const { scene, camera } = this.viewer;
    const occluder = new EllipsoidalOccluder(Ellipsoid.WGS84, camera.positionWC);
    const boxes: [number, number, number, number][] = [];
    const { clientWidth: width, clientHeight: height } = scene.canvas;
    this.labels.removeAll();

    for (const c of candidates) {
      if (this.labels.length >= MAX_LABELS) break;
      const position = Cartesian3.fromDegrees(c.lon, c.lat);
      if (!occluder.isPointVisible(position)) continue;
      const screen = SceneTransforms.worldToWindowCoordinates(scene, position);
      if (!screen || screen.x < 0 || screen.y < 0 || screen.x > width || screen.y > height) continue;

      const size = parseInt(c.style.font.match(/(\d+)px/)![1], 10);
      const w = c.text.length * size * 0.58 + PADDING;
      const box: [number, number, number, number] = [screen.x - w / 2, screen.y - size - PADDING, screen.x + w / 2, screen.y + PADDING];
      if (boxes.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) continue;
      boxes.push(box);

      this.labels.add({
        position,
        text: c.text,
        font: c.style.font,
        fillColor: Color.fromCssColorString(c.style.color),
        outlineColor: Color.BLACK.withAlpha(0.85),
        outlineWidth: 3,
        style: LabelStyle.FILL_AND_OUTLINE,
        verticalOrigin: VerticalOrigin.BOTTOM,
        heightReference: HeightReference.CLAMP_TO_GROUND,
        // Lift labels toward the camera so terrain doesn't swallow them.
        eyeOffset: new Cartesian3(0, 0, -200),
        pixelOffset: new Cartesian2(0, -2),
      });
    }
    scene.requestRender();
  }
}

/** Web Mercator tiles at zoom z that cover a view rectangle (radians). */
function tileRange(view: { west: number; south: number; east: number; north: number }, z: number): [number, number][] {
  const n = 2 ** z;
  const toX = (lon: number) => Math.min(n - 1, Math.max(0, Math.floor(((CesiumMath.toDegrees(lon) + 180) / 360) * n)));
  const toY = (lat: number) => {
    const r = Math.max(-1.4844, Math.min(1.4844, lat));
    return Math.min(n - 1, Math.max(0, Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n)));
  };
  const xs = view.east >= view.west ? [[toX(view.west), toX(view.east)]] : [[toX(view.west), n - 1], [0, toX(view.east)]];
  const out: [number, number][] = [];
  for (const [x0, x1] of xs) {
    for (let x = x0; x <= x1; x++) for (let y = toY(view.north); y <= toY(view.south); y++) out.push([x, y]);
  }
  return out;
}
