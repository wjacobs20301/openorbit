import {
  CallbackProperty,
  Cartesian2,
  Cartesian3,
  Cartographic,
  Color,
  LabelStyle,
  Math as CesiumMath,
  PolygonHierarchy,
  type Entity,
  type Viewer,
} from 'cesium';
import { formatArea, formatDistance, pathLength, polygonArea, toLonLat, type LonLat } from './geometry';
import { formatHeight, onUnitsChange } from './units';
import { ON_TOP } from './ontop';

export type RulerMode = 'line' | 'path' | 'polygon' | 'circle';

const COLOR = Color.fromCssColorString('#33d1ff');
const MODES: { mode: RulerMode; label: string; tip: string }[] = [
  { mode: 'line', label: 'Line', tip: 'Click two points on the globe.' },
  { mode: 'path', label: 'Path', tip: 'Click points along the way.' },
  { mode: 'polygon', label: 'Polygon', tip: 'Click the corners of the area.' },
  { mode: 'circle', label: 'Circle', tip: 'Click the centre, then the edge.' },
];
const EARTH_RADIUS = 6371008.8;
/** Samples per segment when following the terrain for ground length. */
const SAMPLES = 40;

/** Compass bearing from a to b, in degrees. */
function bearing(a: LonLat, b: LonLat): number {
  const [l1, p1] = a.map(CesiumMath.toRadians);
  const [l2, p2] = b.map(CesiumMath.toRadians);
  const y = Math.sin(l2 - l1) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(l2 - l1);
  return (CesiumMath.toDegrees(Math.atan2(y, x)) + 360) % 360;
}

/** The ring of a circle on the ground, as a polygon. */
export function circlePoints(centre: LonLat, radius: number, steps = 72): LonLat[] {
  const [lon, lat] = centre.map(CesiumMath.toRadians);
  const d = radius / EARTH_RADIUS;
  return Array.from({ length: steps }, (_, i) => {
    const t = (i / steps) * 2 * Math.PI;
    const lat2 = Math.asin(Math.sin(lat) * Math.cos(d) + Math.cos(lat) * Math.sin(d) * Math.cos(t));
    const lon2 = lon + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(lat), Math.cos(d) - Math.sin(lat) * Math.sin(lat2));
    return [CesiumMath.toDegrees(lon2), CesiumMath.toDegrees(lat2)] as LonLat;
  });
}

/**
 * The Ruler window, as in Google Earth: Line, Path, Polygon and Circle tabs, live
 * readouts that follow the pointer, and Save to keep the measurement as a place.
 */
export class Measure {
  private mode: RulerMode = 'line';
  private points: Cartographic[] = [];
  private cursor?: Cartographic;
  private entities: Entity[] = [];
  private readonly panel = document.createElement('div');
  private readonly readout = document.createElement('dl');
  private readonly tip = document.createElement('p');
  /** Called with the measured shape when Save is pressed. */
  onSave?: (kind: 'line' | 'polygon', coords: LonLat[], name: string) => void;
  /** Called when the window's × is pressed. */
  onClose?: () => void;

  constructor(private readonly viewer: Viewer) {
    this.panel.className = 'edit-window ruler';
    this.panel.hidden = true;
    const head = document.createElement('div');
    head.className = 'row';
    const title = document.createElement('h3');
    title.textContent = 'Ruler';
    const close = document.createElement('button');
    close.className = 'close';
    close.textContent = '×';
    close.title = 'Close the ruler (Esc)';
    close.addEventListener('click', () => this.onClose?.());
    head.append(title, close);

    const tabs = document.createElement('div');
    tabs.className = 'tabs';
    tabs.setAttribute('role', 'tablist');
    for (const m of MODES) {
      const tab = document.createElement('button');
      tab.textContent = m.label;
      tab.dataset.mode = m.mode;
      tab.setAttribute('role', 'tab');
      tab.addEventListener('click', () => this.setMode(m.mode));
      tabs.append(tab);
    }
    this.tip.className = 'hint';
    const actions = document.createElement('div');
    actions.className = 'row end';
    const clear = document.createElement('button');
    clear.textContent = 'Clear';
    clear.addEventListener('click', () => this.reset());
    const save = document.createElement('button');
    save.className = 'primary';
    save.textContent = 'Save';
    save.title = 'Keep this measurement in My Places';
    save.addEventListener('click', () => this.save());
    actions.append(clear, save);
    this.panel.append(head, tabs, this.readout, this.tip, actions);
    document.querySelector('#globe')!.append(this.panel);
    onUnitsChange(() => this.update());
  }

  open(): void {
    this.panel.hidden = false;
    this.setMode(this.mode);
  }

  /** Hides the window and removes the measurement. */
  clear(): void {
    this.panel.hidden = true;
    this.reset();
  }

  setMode(mode: RulerMode): void {
    this.mode = mode;
    this.panel.querySelectorAll<HTMLElement>('.tabs button').forEach((b) => {
      b.classList.toggle('active', b.dataset.mode === mode);
      b.setAttribute('aria-selected', String(b.dataset.mode === mode));
    });
    this.reset();
  }

  add(point: Cartographic): void {
    if (this.panel.hidden) this.open();
    // Line and Circle take two clicks; a third starts again.
    if ((this.mode === 'line' || this.mode === 'circle') && this.points.length >= 2) this.reset();
    if (!this.entities.length) this.draw();
    this.points.push(point);
    const marker = this.viewer.entities.add({
      position: Cartographic.toCartesian(point),
      point: { pixelSize: 7, color: Color.WHITE, disableDepthTestDistance: ON_TOP },
    });
    this.entities.push(marker);
    this.update();
  }

  /** Follows the pointer so the readout shows the next point before clicking. */
  move(point: Cartographic | undefined): void {
    if (this.panel.hidden || !this.points.length) return;
    if ((this.mode === 'line' || this.mode === 'circle') && this.points.length >= 2) return;
    this.cursor = point;
    this.update();
  }

  private reset(): void {
    this.entities.forEach((e) => this.viewer.entities.remove(e));
    this.entities = [];
    this.points = [];
    this.cursor = undefined;
    this.update();
    this.viewer.scene.requestRender();
  }

  private all(): Cartographic[] {
    return this.cursor ? [...this.points, this.cursor] : this.points;
  }

  private shape(): LonLat[] {
    const pts = this.all().map(toLonLat);
    if (this.mode === 'circle') return pts.length === 2 ? circlePoints(pts[0], pathLength(pts)) : [];
    return pts;
  }

  /** The draft line, area and the label at the pointer. */
  private draw(): void {
    const closed = this.mode === 'polygon' || this.mode === 'circle';
    const cartesians = () => {
      const pts = this.shape().map(([lon, lat]) => Cartesian3.fromDegrees(lon, lat));
      return closed && pts.length > 2 ? [...pts, pts[0]] : pts;
    };
    this.entities.push(
      this.viewer.entities.add({
        polyline: { positions: new CallbackProperty(cartesians, false), width: 3, material: COLOR, clampToGround: true },
        polygon: closed
          ? {
              show: new CallbackProperty(() => this.shape().length > 2, false),
              hierarchy: new CallbackProperty(
                () => new PolygonHierarchy(this.shape().map(([lon, lat]) => Cartesian3.fromDegrees(lon, lat))),
                false,
              ),
              material: COLOR.withAlpha(0.2),
            }
          : undefined,
      }),
      this.viewer.entities.add({
        position: new CallbackProperty(() => {
          const last = this.all().at(-1);
          return last ? Cartographic.toCartesian(last) : undefined;
        }, false) as never,
        label: {
          text: new CallbackProperty(() => this.headline(), false),
          font: '13px system-ui, sans-serif',
          style: LabelStyle.FILL_AND_OUTLINE,
          outlineWidth: 3,
          outlineColor: Color.BLACK,
          pixelOffset: new Cartesian2(0, -18),
          disableDepthTestDistance: ON_TOP,
        },
      }),
    );
  }

  /** The main number, shown beside the pointer. */
  private headline(): string {
    const pts = this.all().map(toLonLat);
    if (pts.length < 2) return '';
    if (this.mode === 'circle') return `radius ${formatDistance(pathLength(pts))}`;
    if (this.mode === 'polygon') return pts.length > 2 ? formatArea(polygonArea(pts)) : formatDistance(pathLength(pts));
    return formatDistance(pathLength(pts));
  }

  /** Length over the terrain, from the heights of the tiles already loaded. */
  private groundLength(pts: Cartographic[]): number | undefined {
    const { globe } = this.viewer.scene;
    let sum = 0;
    let previous: Cartesian3 | undefined;
    for (let i = 1; i < pts.length; i++) {
      for (let s = i === 1 ? 0 : 1; s <= SAMPLES; s++) {
        const t = s / SAMPLES;
        const c = new Cartographic(
          CesiumMath.lerp(pts[i - 1].longitude, pts[i].longitude, t),
          CesiumMath.lerp(pts[i - 1].latitude, pts[i].latitude, t),
        );
        const h = globe.getHeight(c);
        if (h === undefined) return undefined;
        c.height = h;
        const here = Cartographic.toCartesian(c);
        if (previous) sum += Cartesian3.distance(previous, here);
        previous = here;
      }
    }
    return sum;
  }

  private update(): void {
    const all = this.all();
    const pts = all.map(toLonLat);
    const rows: [string, string][] = [];
    if (this.mode === 'line' || this.mode === 'path') {
      rows.push(['Map length', pts.length > 1 ? formatDistance(pathLength(pts)) : '–']);
      const ground = pts.length > 1 ? this.groundLength(all) : undefined;
      rows.push(['Ground length', ground === undefined ? '–' : formatDistance(ground)]);
      if (this.mode === 'line') rows.push(['Heading', pts.length > 1 ? `${bearing(pts[0], pts[1]).toFixed(2)}°` : '–']);
      if (all.length > 1) {
        const heights = all.map((c) => this.viewer.scene.globe.getHeight(c) ?? c.height);
        rows.push(['Elevation change', formatHeight(heights.at(-1)! - heights[0])]);
      }
    } else if (this.mode === 'polygon') {
      rows.push(['Perimeter', pts.length > 1 ? formatDistance(pathLength(pts, true)) : '–']);
      rows.push(['Area', pts.length > 2 ? formatArea(polygonArea(pts)) : '–']);
    } else {
      const r = pts.length > 1 ? pathLength(pts) : undefined;
      rows.push(['Radius', r === undefined ? '–' : formatDistance(r)]);
      rows.push(['Area', r === undefined ? '–' : formatArea(Math.PI * r * r)]);
      rows.push(['Circumference', r === undefined ? '–' : formatDistance(2 * Math.PI * r)]);
    }
    this.readout.replaceChildren(
      ...rows.flatMap(([k, v]) => {
        const dt = document.createElement('dt');
        dt.textContent = k;
        const dd = document.createElement('dd');
        dd.textContent = v;
        return [dt, dd];
      }),
    );
    this.tip.textContent = MODES.find((m) => m.mode === this.mode)!.tip;
    this.viewer.scene.requestRender();
  }

  private save(): void {
    const pts = this.points.map(toLonLat);
    const needed = this.mode === 'polygon' ? 3 : 2;
    if (pts.length < needed) {
      this.tip.textContent = 'Measure something first.';
      return;
    }
    const name = this.headline();
    if (this.mode === 'circle') this.onSave?.('polygon', circlePoints(pts[0], pathLength(pts)), `Circle, ${name}`);
    else this.onSave?.(this.mode === 'polygon' ? 'polygon' : 'line', pts, `Measured ${name}`);
    this.reset();
  }
}
