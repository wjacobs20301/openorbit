import {
  Cartesian2,
  Cartesian3,
  Color,
  CustomDataSource,
  HeightReference,
  LabelStyle,
  PolygonHierarchy,
  VerticalOrigin,
  type Cartographic,
  type Entity,
  type Viewer,
} from 'cesium';
import { centroid, formatArea, formatDistance, pathLength, polygonArea, toLonLat, type LonLat } from './geometry';
import { loadSetting, saveTextFile, storeSetting } from './platform';

type FeatureKind = 'point' | 'line' | 'polygon';

/** Something the user saved: a placemark, a path or a polygon. */
interface Feature {
  id: string;
  name: string;
  kind: FeatureKind;
  coords: LonLat[];
  /** CSS hex colour, e.g. #ffcc33. */
  color: string;
  /** Unticked in the Places list. */
  hidden?: boolean;
}

const STORAGE_KEY = 'features';
const DEFAULT_COLORS: Record<FeatureKind, string> = { point: '#ffcc33', line: '#ff5a36', polygon: '#3fa9ff' };
const KIND_ICONS: Record<FeatureKind, string> = { point: '●', line: '〰', polygon: '▱' };
const KIND_NAMES: Record<FeatureKind, string> = { point: 'Placemark', line: 'Path', polygon: 'Polygon' };

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** KML colours are aabbggrr. */
function kmlColor(hex: string, alpha: number): string {
  const [r, g, b] = [1, 3, 5].map((i) => hex.slice(i, i + 2));
  return `${Math.round(alpha * 255).toString(16).padStart(2, '0')}${b}${g}${r}`;
}

function describe(f: Feature): string {
  if (f.kind === 'line') return formatDistance(pathLength(f.coords));
  if (f.kind === 'polygon') return `${formatArea(polygonArea(f.coords))}, perimeter ${formatDistance(pathLength(f.coords, true))}`;
  return `${f.coords[0][1].toFixed(5)}, ${f.coords[0][0].toFixed(5)}`;
}

export function toKml(features: Feature[]): string {
  const coords = (pts: LonLat[]) => pts.map(([lon, lat]) => `${lon},${lat},0`).join(' ');
  const body = features
    .map((f) => {
      const style = `<Style>
        <IconStyle><color>${kmlColor(f.color, 1)}</color></IconStyle>
        <LineStyle><color>${kmlColor(f.color, 1)}</color><width>3</width></LineStyle>
        <PolyStyle><color>${kmlColor(f.color, 0.35)}</color></PolyStyle>
      </Style>`;
      const geometry =
        f.kind === 'point'
          ? `<Point><coordinates>${coords(f.coords)}</coordinates></Point>`
          : f.kind === 'line'
            ? `<LineString><tessellate>1</tessellate><coordinates>${coords(f.coords)}</coordinates></LineString>`
            : `<Polygon><tessellate>1</tessellate><outerBoundaryIs><LinearRing><coordinates>${coords([...f.coords, f.coords[0]])}</coordinates></LinearRing></outerBoundaryIs></Polygon>`;
      return `    <Placemark>
      <name>${escapeXml(f.name)}</name>
      <description>${escapeXml(describe(f))}</description>
      ${style}
      ${geometry}
    </Placemark>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>My Places</name>
${body}
  </Document>
</kml>
`;
}

export class Places {
  private readonly source = new CustomDataSource('My places');
  private features: Feature[] = [];
  private readonly list = document.querySelector<HTMLUListElement>('#placemark-list')!;
  /** Called with a path's name and points when its 📈 button is clicked. */
  onProfile?: (name: string, positions: Cartesian3[]) => void;

  constructor(private readonly viewer: Viewer) {
    viewer.dataSources.add(this.source);
    this.features = this.load();
    this.features.forEach((f) => this.addEntity(f));
    this.render();

    document.querySelector('#kml-export')!.addEventListener('click', () => void this.exportKml());
  }

  /** Saves My Places as a KML file (File > Save, or the Places panel button). */
  exportKml(): Promise<void> {
    return saveTextFile('My Places.kml', toKml(this.features));
  }

  addPoint(at: Cartographic): void {
    this.addFeature('point', [toLonLat(at)]);
  }

  addShape(kind: 'line' | 'polygon', coords: LonLat[]): void {
    this.addFeature(kind, coords);
  }

  private addFeature(kind: FeatureKind, coords: LonLat[]): void {
    const count = this.features.filter((f) => f.kind === kind).length + 1;
    const f: Feature = { id: crypto.randomUUID(), name: `${KIND_NAMES[kind]} ${count}`, kind, coords, color: DEFAULT_COLORS[kind] };
    this.features.push(f);
    this.addEntity(f);
    this.persist();
    this.render();
    this.list.querySelector<HTMLInputElement>(`[data-id="${f.id}"] input[type="text"]`)?.select();
  }

  private load(): Feature[] {
    try {
      return JSON.parse(loadSetting(STORAGE_KEY) || '[]');
    } catch {
      return [];
    }
  }

  private addEntity(f: Feature): Entity {
    const color = Color.fromCssColorString(f.color);
    const positions = f.coords.map(([lon, lat]) => Cartesian3.fromDegrees(lon, lat));
    const anchor = f.kind === 'line' ? f.coords[Math.floor(f.coords.length / 2)] : centroid(f.coords);

    return this.source.entities.add({
      id: f.id,
      name: f.name,
      show: !f.hidden,
      description: describe(f),
      position: Cartesian3.fromDegrees(...anchor),
      point:
        f.kind === 'point'
          ? {
              pixelSize: 11,
              color,
              outlineColor: Color.BLACK,
              outlineWidth: 1.5,
              heightReference: HeightReference.CLAMP_TO_GROUND,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            }
          : undefined,
      polyline:
        f.kind === 'point'
          ? undefined
          : {
              positions: f.kind === 'polygon' ? [...positions, positions[0]] : positions,
              width: 3,
              material: color,
              clampToGround: true,
            },
      polygon: f.kind === 'polygon' ? { hierarchy: new PolygonHierarchy(positions), material: color.withAlpha(0.3) } : undefined,
      label: {
        text: f.name,
        font: '14px system-ui, sans-serif',
        style: LabelStyle.FILL_AND_OUTLINE,
        outlineWidth: 3,
        outlineColor: Color.BLACK,
        verticalOrigin: VerticalOrigin.BOTTOM,
        pixelOffset: new Cartesian2(0, f.kind === 'point' ? -12 : 0),
        heightReference: HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
  }

  private replaceEntity(f: Feature): void {
    this.source.entities.removeById(f.id);
    this.addEntity(f);
  }

  private persist(): void {
    storeSetting(STORAGE_KEY, JSON.stringify(this.features));
  }

  private render(): void {
    this.list.innerHTML = '';
    if (!this.features.length) {
      this.list.innerHTML = '<li class="hint">Use Add Placemark, Polygon or Path in the toolbar.</li>';
      return;
    }
    for (const f of this.features) {
      const li = document.createElement('li');
      li.dataset.id = f.id;
      li.title = describe(f);

      const visible = document.createElement('input');
      visible.type = 'checkbox';
      visible.checked = !f.hidden;
      visible.title = 'Show on the map';
      visible.addEventListener('change', () => {
        f.hidden = !visible.checked;
        this.source.entities.getById(f.id)!.show = visible.checked;
        this.persist();
      });

      const icon = document.createElement('span');
      icon.className = 'kind-icon';
      icon.textContent = KIND_ICONS[f.kind];
      icon.style.color = f.color;

      const name = document.createElement('input');
      name.type = 'text';
      name.value = f.name;
      name.addEventListener('change', () => {
        f.name = name.value.trim() || f.name;
        this.replaceEntity(f);
        this.persist();
      });

      const color = document.createElement('input');
      color.type = 'color';
      color.value = f.color;
      color.title = 'Colour';
      color.addEventListener('input', () => {
        f.color = color.value;
        icon.style.color = f.color;
        this.replaceEntity(f);
        this.persist();
      });

      const go = button('Go', 'Fly here', () => {
        if (f.kind === 'point') {
          this.viewer.camera.flyTo({ destination: Cartesian3.fromDegrees(...f.coords[0], 2500) });
        } else {
          void this.viewer.flyTo(this.source.entities.getById(f.id)!);
        }
      });
      const remove = button('×', `Delete ${KIND_NAMES[f.kind].toLowerCase()}`, () => {
        this.features = this.features.filter((x) => x.id !== f.id);
        this.source.entities.removeById(f.id);
        this.persist();
        this.render();
      });
      li.append(visible, icon, name, color, go);
      if (f.kind === 'line') {
        li.append(
          button('📈', 'Show elevation profile', () =>
            this.onProfile?.(f.name, f.coords.map(([lon, lat]) => Cartesian3.fromDegrees(lon, lat))),
          ),
        );
      }
      li.append(remove);
      this.list.append(li);
    }
  }
}

function button(text: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = text;
  b.title = title;
  b.addEventListener('click', onClick);
  return b;
}
