import {
  Cartesian2,
  Cartesian3,
  Color,
  CustomDataSource,
  HeightReference,
  LabelStyle,
  Math as CesiumMath,
  VerticalOrigin,
  type Cartographic,
  type Viewer,
} from 'cesium';
import { loadSetting, saveTextFile, storeSetting } from './platform';

interface Placemark {
  id: string;
  name: string;
  lon: number;
  lat: number;
}

const STORAGE_KEY = 'placemarks';

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function toKml(placemarks: Placemark[]): string {
  const body = placemarks
    .map(
      (p) => `    <Placemark>
      <name>${escapeXml(p.name)}</name>
      <Point><coordinates>${p.lon},${p.lat},0</coordinates></Point>
    </Placemark>`,
    )
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
  private placemarks: Placemark[] = [];
  private readonly list = document.querySelector<HTMLUListElement>('#placemark-list')!;

  constructor(private readonly viewer: Viewer) {
    viewer.dataSources.add(this.source);
    try {
      this.placemarks = JSON.parse(loadSetting(STORAGE_KEY) || '[]');
    } catch {
      this.placemarks = [];
    }
    this.placemarks.forEach((p) => this.addEntity(p));
    this.render();

    document.querySelector('#kml-export')!.addEventListener('click', () => {
      void saveTextFile('My Places.kml', toKml(this.placemarks));
    });
  }

  add(at: Cartographic): void {
    const p: Placemark = {
      id: crypto.randomUUID(),
      name: `Placemark ${this.placemarks.length + 1}`,
      lon: CesiumMath.toDegrees(at.longitude),
      lat: CesiumMath.toDegrees(at.latitude),
    };
    this.placemarks.push(p);
    this.addEntity(p);
    this.persist();
    this.render();
    this.list.querySelector<HTMLInputElement>(`[data-id="${p.id}"] input`)?.select();
  }

  private addEntity(p: Placemark): void {
    this.source.entities.add({
      id: p.id,
      name: p.name,
      position: Cartesian3.fromDegrees(p.lon, p.lat),
      point: {
        pixelSize: 11,
        color: Color.fromCssColorString('#ffcc33'),
        outlineColor: Color.BLACK,
        outlineWidth: 1.5,
        heightReference: HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: {
        text: p.name,
        font: '14px system-ui, sans-serif',
        style: LabelStyle.FILL_AND_OUTLINE,
        outlineWidth: 3,
        outlineColor: Color.BLACK,
        verticalOrigin: VerticalOrigin.BOTTOM,
        pixelOffset: new Cartesian2(0, -12),
        heightReference: HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
  }

  private persist(): void {
    storeSetting(STORAGE_KEY, JSON.stringify(this.placemarks));
  }

  private render(): void {
    this.list.innerHTML = '';
    if (!this.placemarks.length) {
      this.list.innerHTML = '<li class="hint">Use the Placemark tool to save places.</li>';
      return;
    }
    for (const p of this.placemarks) {
      const li = document.createElement('li');
      li.dataset.id = p.id;
      const name = document.createElement('input');
      name.value = p.name;
      name.addEventListener('change', () => {
        p.name = name.value.trim() || p.name;
        const entity = this.source.entities.getById(p.id)!;
        entity.name = p.name;
        entity.label!.text = p.name as never;
        this.persist();
      });
      const go = button('Go', 'Fly here', () =>
        this.viewer.camera.flyTo({ destination: Cartesian3.fromDegrees(p.lon, p.lat, 2500) }),
      );
      const remove = button('×', 'Delete placemark', () => {
        this.placemarks = this.placemarks.filter((x) => x.id !== p.id);
        this.source.entities.removeById(p.id);
        this.persist();
        this.render();
      });
      li.append(name, go, remove);
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
