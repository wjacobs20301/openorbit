import { ArcType, Cartesian2, Cartesian3, Color, CustomDataSource, EllipsoidGeodesic, HeightReference, LabelStyle, Math as CesiumMath, Rectangle, type Viewer } from 'cesium';
import { pickGround } from './globe';
import { getCoordFormat, onUnitsChange } from './units';

/** Spacings to choose from, in degrees, coarsest first. */
const SPACINGS = [30, 10, 5, 2, 1, 0.5, 0.25, 0.1, 0.05, 0.02, 0.01, 0.005];
/** Aim for about this many lines across the view (when the spacing can't be measured). */
const LINES = 6;
/** Lines at least this far apart on screen, so their labels don't run together. */
const MIN_GAP_PX = 120;
const LINE_COLOR = Color.WHITE.withAlpha(0.55);

/** Latitude and longitude lines with labels (View › Grid), redrawn as the view changes. */
export class Grid {
  private readonly source = new CustomDataSource('Grid');
  private on = false;
  /** False when the last draw couldn't measure the view (e.g. before terrain loaded). */
  private measured = true;

  constructor(private readonly viewer: Viewer) {
    viewer.dataSources.add(this.source);
    viewer.camera.moveEnd.addEventListener(() => this.draw());
    onUnitsChange(() => this.draw());
    viewer.scene.globe.tileLoadProgressEvent.addEventListener((queued: number) => {
      if (queued === 0 && this.on && !this.measured) this.draw();
    });
  }

  get shown(): boolean {
    return this.on;
  }

  setShown(on: boolean): void {
    this.on = on;
    this.draw();
  }

  private draw(): void {
    const entities = this.source.entities;
    entities.suspendEvents();
    entities.removeAll();
    const view = this.on ? this.viewer.camera.computeViewRectangle() : undefined;
    if (view) {
      let west = CesiumMath.toDegrees(view.west);
      let east = CesiumMath.toDegrees(view.east);
      if (east < west) east += 360;
      const south = Math.max(-89.9, CesiumMath.toDegrees(view.south));
      const north = Math.min(89.9, CesiumMath.toDegrees(view.north));
      // The whole globe in view: show it all.
      if (east - west > 300) [west, east] = [-180, 180];
      // Labels run through the middle of the screen.
      const { clientWidth: w, clientHeight: h } = this.viewer.canvas;
      const centre = pickGround(this.viewer, new Cartesian2(w / 2, h / 2)) ?? Rectangle.center(view);
      const midLon = CesiumMath.toDegrees(centre.longitude);
      const midLat = CesiumMath.toDegrees(centre.latitude);
      // Space the lines by how far apart they'll be on screen, so longitude labels fit.
      const right = pickGround(this.viewer, new Cartesian2(w / 2 + 100, h / 2));
      const metresPerPx = right ? new EllipsoidGeodesic(centre, right).surfaceDistance / 100 : undefined;
      const pxPerDegree = metresPerPx ? (111320 * Math.cos(centre.latitude)) / metresPerPx : undefined;
      this.measured = !!pxPerDegree;
      const step = pxPerDegree
        ? ([...SPACINGS].reverse().find((s) => s * pxPerDegree >= MIN_GAP_PX) ?? SPACINGS[0])
        : (SPACINGS.find((s) => Math.max(east - west, north - south) / s >= LINES) ?? SPACINGS.at(-1)!);
      // A tilted view reaches the horizon: keep to a few dozen lines around the middle.
      const reach = step * 30;
      const unwrapped = midLon < west ? midLon + 360 : midLon;
      west = Math.max(west, unwrapped - reach);
      east = Math.min(east, unwrapped + reach);
      const southEdge = Math.max(south, midLat - reach);
      const northEdge = Math.min(north, midLat + reach);

      for (let lon = Math.ceil(west / step) * step; lon <= east; lon += step) {
        const l = wrap(lon);
        entities.add({
          polyline: {
            positions: Cartesian3.fromDegreesArray([l, southEdge, l, (southEdge + northEdge) / 2, l, northEdge]),
            width: 1,
            material: LINE_COLOR,
            arcType: ArcType.RHUMB,
            clampToGround: true,
          },
          position: Cartesian3.fromDegrees(l, midLat),
          label: label(formatAngle(l, 'E', 'W', step)),
        });
      }
      for (let lat = Math.ceil(southEdge / step) * step; lat <= northEdge; lat += step) {
        const positions: number[] = [];
        for (let lon = west; lon <= east + 1e-9; lon += Math.min(step, (east - west) / 16)) positions.push(lon, lat);
        entities.add({
          polyline: { positions: Cartesian3.fromDegreesArray(positions), width: 1, material: LINE_COLOR, arcType: ArcType.RHUMB, clampToGround: true },
          position: Cartesian3.fromDegrees(midLon, lat),
          label: label(formatAngle(lat, 'N', 'S', step)),
        });
      }
    }
    entities.resumeEvents();
    this.viewer.scene.requestRender();
  }
}

function wrap(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/** "49°N", "121°30'W" or "49.25°N", depending on the chosen coordinate format. */
function formatAngle(deg: number, pos: string, neg: string, step: number): string {
  const a = Math.abs(deg);
  const hemi = deg === 0 ? '' : deg > 0 ? pos : neg;
  if (getCoordFormat() === 'decimal' || getCoordFormat() === 'utm') {
    const digits = Math.max(0, Math.ceil(-Math.log10(step)));
    return `${a.toFixed(digits)}°${hemi}`;
  }
  const d = Math.floor(a + 1e-9);
  const minutes = (a - d) * 60;
  if (minutes < 1e-6) return `${d}°${hemi}`;
  const m = Math.floor(minutes + 1e-6);
  const s = Math.round((minutes - m) * 60);
  return s ? `${d}°${m}'${s}"${hemi}` : `${d}°${m}'${hemi}`;
}

function label(text: string) {
  return {
    text,
    font: '12px system-ui, sans-serif',
    fillColor: Color.WHITE,
    style: LabelStyle.FILL_AND_OUTLINE,
    outlineColor: Color.BLACK.withAlpha(0.8),
    outlineWidth: 3,
    heightReference: HeightReference.CLAMP_TO_GROUND,
    disableDepthTestDistance: Number.POSITIVE_INFINITY,
  };
}
