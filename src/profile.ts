import {
  Cartesian3,
  Cartographic,
  Color,
  EllipsoidGeodesic,
  EllipsoidTerrainProvider,
  HeightReference,
  sampleTerrain,
  type Entity,
  type Viewer,
} from 'cesium';
import { formatDistance } from './geometry';
import { formatHeight } from './units';

/** Samples along the line; enough for a smooth chart without many terrain requests. */
const SAMPLES = 240;
/** Terrain level sampled (about 10 m detail), matching the 3D buildings. */
const TERRAIN_LEVEL = 13;
const CHART_W = 1000;
const CHART_H = 140;

interface Sample {
  carto: Cartographic;
  /** Metres from the start. */
  along: number;
  height: number;
}

/** Evenly spaced points along a line (by ground distance), keeping every corner's shape. */
function resample(points: Cartographic[]): { carto: Cartographic; along: number }[] {
  const legs = points.slice(1).map((p, i) => new EllipsoidGeodesic(points[i], p));
  const total = legs.reduce((s, g) => s + g.surfaceDistance, 0);
  if (!total) return [];
  const out: { carto: Cartographic; along: number }[] = [];
  let leg = 0;
  let legStart = 0;
  for (let i = 0; i <= SAMPLES; i++) {
    const along = (total * i) / SAMPLES;
    while (leg < legs.length - 1 && along > legStart + legs[leg].surfaceDistance) {
      legStart += legs[leg].surfaceDistance;
      leg++;
    }
    const g = legs[leg];
    const t = g.surfaceDistance ? Math.min(1, (along - legStart) / g.surfaceDistance) : 0;
    out.push({ carto: g.interpolateUsingFraction(t), along });
  }
  return out;
}

/**
 * Elevation profile along a path or line, like Google Earth's: a chart docked at the
 * bottom of the map with distance, elevation range, climb/descent and steepest slope.
 * Hovering the chart marks that point on the map.
 */
export class ElevationProfile {
  private readonly panel = document.createElement('section');
  private readonly title = document.createElement('strong');
  private readonly stats = document.createElement('span');
  private readonly chart = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  private readonly readout = document.createElement('div');
  private samples: Sample[] = [];
  private marker?: Entity;
  private loadId = 0;

  constructor(private readonly viewer: Viewer) {
    this.panel.id = 'profile-panel';
    this.panel.hidden = true;
    const head = document.createElement('header');
    const close = document.createElement('button');
    close.textContent = '×';
    close.title = 'Close the elevation profile';
    close.addEventListener('click', () => this.close());
    head.append(this.title, this.stats, close);
    this.chart.setAttribute('viewBox', `0 0 ${CHART_W} ${CHART_H}`);
    this.chart.setAttribute('preserveAspectRatio', 'none');
    this.readout.className = 'profile-readout';
    const body = document.createElement('div');
    body.className = 'profile-body';
    body.append(this.chart, this.readout);
    this.panel.append(head, body);
    document.querySelector('#globe')!.append(this.panel);

    this.chart.addEventListener('mousemove', (e) => this.hover(e));
    this.chart.addEventListener('mouseleave', () => this.hover());
  }

  /** Shows the profile of a line given as positions on the globe. */
  async show(name: string, positions: Cartesian3[]): Promise<void> {
    const id = ++this.loadId;
    this.panel.hidden = false;
    this.title.textContent = `Elevation profile · ${name}`;
    this.stats.textContent = 'Sampling terrain…';
    this.chart.innerHTML = '';
    this.readout.textContent = '';
    const points = resample(positions.map((p) => Cartographic.fromCartesian(p)));
    if (points.length < 2) {
      this.stats.textContent = 'This line is too short for a profile.';
      return;
    }
    if (this.viewer.terrainProvider instanceof EllipsoidTerrainProvider) {
      this.stats.textContent = 'Turn on Terrain in Layers to see elevations.';
      return;
    }
    const sampled = await sampleTerrain(
      this.viewer.terrainProvider,
      TERRAIN_LEVEL,
      points.map((p) => p.carto.clone()),
    ).catch(() => null);
    if (id !== this.loadId) return;
    if (!sampled) {
      this.stats.textContent = "Couldn't load terrain for this line.";
      return;
    }
    this.samples = sampled.map((carto, i) => ({ carto, along: points[i].along, height: carto.height ?? 0 }));
    this.draw();
  }

  close(): void {
    this.panel.hidden = true;
    this.loadId++;
    this.clearMarker();
  }

  private draw(): void {
    const s = this.samples;
    const total = s[s.length - 1].along;
    const heights = s.map((p) => p.height);
    const min = Math.min(...heights);
    const max = Math.max(...heights);
    let gain = 0;
    let loss = 0;
    let steepest = 0;
    for (let i = 1; i < s.length; i++) {
      const dh = s[i].height - s[i - 1].height;
      if (dh > 0) gain += dh;
      else loss -= dh;
      const run = s[i].along - s[i - 1].along;
      if (run > 0) steepest = Math.max(steepest, Math.abs(dh / run));
    }
    this.stats.textContent =
      `${formatDistance(total)} · ${formatHeight(min)} to ${formatHeight(max)} · ` +
      `climb ${formatHeight(gain)}, descent ${formatHeight(loss)} · steepest ${(steepest * 100).toFixed(0)}%`;

    // Scale with a little headroom so flat lines don't hug the edges.
    const pad = Math.max(10, (max - min) * 0.1);
    const lo = min - pad;
    const hi = max + pad;
    const x = (along: number) => (along / total) * CHART_W;
    const y = (h: number) => CHART_H - ((h - lo) / (hi - lo)) * CHART_H;
    const line = s.map((p, i) => `${i ? 'L' : 'M'}${x(p.along).toFixed(1)},${y(p.height).toFixed(1)}`).join('');
    this.chart.innerHTML = `
      <path d="${line}L${CHART_W},${CHART_H}L0,${CHART_H}Z" class="profile-area" />
      <path d="${line}" class="profile-line" vector-effect="non-scaling-stroke" />
      <line class="profile-cursor" y1="0" y2="${CHART_H}" vector-effect="non-scaling-stroke" visibility="hidden" />`;
    this.readout.textContent = `${formatHeight(max)}\n\n${formatHeight(min)}`;
  }

  /** Marks the hovered point on the chart and on the map. */
  private hover(e?: MouseEvent): void {
    const cursor = this.chart.querySelector<SVGLineElement>('.profile-cursor');
    if (!e || !this.samples.length || !cursor) {
      cursor?.setAttribute('visibility', 'hidden');
      this.clearMarker();
      return;
    }
    const box = this.chart.getBoundingClientRect();
    const share = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width));
    const sample = this.samples[Math.round(share * (this.samples.length - 1))];
    cursor.setAttribute('x1', String(share * CHART_W));
    cursor.setAttribute('x2', String(share * CHART_W));
    cursor.setAttribute('visibility', 'visible');
    this.readout.textContent = `${formatDistance(sample.along)}\n${formatHeight(sample.height)}`;

    const position = Cartographic.toCartesian(sample.carto);
    if (this.marker) this.marker.position = position as never;
    else {
      this.marker = this.viewer.entities.add({
        position,
        point: {
          pixelSize: 11,
          color: Color.fromCssColorString('#ff3b30'),
          outlineColor: Color.WHITE,
          outlineWidth: 2,
          heightReference: HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    }
    this.viewer.scene.requestRender();
  }

  private clearMarker(): void {
    if (this.marker) this.viewer.entities.remove(this.marker);
    this.marker = undefined;
    this.viewer.scene.requestRender();
  }
}
