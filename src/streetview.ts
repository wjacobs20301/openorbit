import { Viewer as SphereViewer } from '@photo-sphere-viewer/core';
import '@photo-sphere-viewer/core/index.css';
import { Cartesian3, Color, type Entity, type Viewer } from 'cesium';
import { Viewer as MapillaryViewer } from 'mapillary-js';
import 'mapillary-js/dist/mapillary.css';
import { loadSetting, openExternal } from './platform';
import { streetSources } from './sources';

interface PanoramaxItem {
  id: string;
  geometry: { coordinates: [number, number] };
  assets: Record<string, { href: string }>;
  links: { rel: string; href: string }[];
  providers?: { name: string }[];
  properties: {
    datetime?: string;
    license?: string;
    'pers:interior_orientation'?: { field_of_view?: number };
  };
}

/**
 * Street-level photos. Uses Mapillary when the user has entered a token, otherwise
 * Panoramax (no key needed). Google Street View is always one click away in the browser.
 */
export class StreetView {
  private readonly panel = document.querySelector<HTMLElement>('#street-panel')!;
  private readonly container = document.querySelector<HTMLDivElement>('#street-viewer')!;
  private readonly title = document.querySelector<HTMLElement>('#street-title')!;
  private readonly credit = document.querySelector<HTMLElement>('#street-credit')!;
  private readonly prev = document.querySelector<HTMLButtonElement>('#street-prev')!;
  private readonly next = document.querySelector<HTMLButtonElement>('#street-next')!;

  private sphere?: SphereViewer;
  private mapillary?: MapillaryViewer;
  private item?: PanoramaxItem;
  private marker?: Entity;
  private position: [number, number] = [0, 0];

  constructor(private readonly viewer: Viewer) {
    document.querySelector('#street-close')!.addEventListener('click', () => this.close());
    document.querySelector('#street-google')!.addEventListener('click', () => {
      const [lon, lat] = this.position;
      void openExternal(`https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat},${lon}`);
    });
    this.prev.addEventListener('click', () => void this.step('prev'));
    this.next.addEventListener('click', () => void this.step('next'));
  }

  async openAt(lon: number, lat: number): Promise<void> {
    this.position = [lon, lat];
    this.panel.hidden = false;
    this.title.textContent = 'Looking for photos…';
    this.credit.textContent = '';

    const token = loadSetting('mapillaryToken');
    if (token && (await this.tryMapillary(token, lon, lat))) return;
    if (await this.tryPanoramax(lon, lat)) return;

    this.reset();
    this.title.textContent = 'No open street photos here';
    this.credit.textContent = 'Try Google for this spot, or click closer to a road.';
    this.placeMarker(lon, lat);
  }

  close(): void {
    this.panel.hidden = true;
    this.reset();
    if (this.marker) this.viewer.entities.remove(this.marker);
    this.marker = undefined;
  }

  private reset(): void {
    this.sphere?.destroy();
    this.sphere = undefined;
    this.mapillary?.remove();
    this.mapillary = undefined;
    this.item = undefined;
    this.container.innerHTML = '';
    this.prev.hidden = this.next.hidden = true;
  }

  private async tryMapillary(token: string, lon: number, lat: number): Promise<boolean> {
    const d = 0.0005;
    const url =
      `${streetSources.mapillaryGraph}/images?access_token=${encodeURIComponent(token)}` +
      `&fields=id,computed_geometry,geometry&limit=50&bbox=${lon - d},${lat - d},${lon + d},${lat + d}`;
    try {
      const res = await fetch(url);
      if (!res.ok) return false;
      const { data } = (await res.json()) as {
        data: { id: string; computed_geometry?: { coordinates: [number, number] }; geometry: { coordinates: [number, number] } }[];
      };
      if (!data.length) return false;
      const dist = (c: [number, number]) => (c[0] - lon) ** 2 + (c[1] - lat) ** 2;
      const nearest = data.reduce((a, b) =>
        dist((a.computed_geometry ?? a.geometry).coordinates) <= dist((b.computed_geometry ?? b.geometry).coordinates) ? a : b,
      );

      this.reset();
      this.title.textContent = 'Mapillary';
      this.credit.innerHTML = 'Photos © <a href="https://www.mapillary.com" target="_blank">Mapillary</a> contributors, CC BY-SA 4.0';
      this.mapillary = new MapillaryViewer({ accessToken: token, container: this.container, imageId: nearest.id });
      this.mapillary.on('image', (e) => {
        const ll = e.image.computedLngLat ?? e.image.lngLat;
        this.position = [ll.lng, ll.lat];
        this.placeMarker(ll.lng, ll.lat);
      });
      return true;
    } catch {
      return false;
    }
  }

  private async tryPanoramax(lon: number, lat: number): Promise<boolean> {
    for (const range of ['0-50', '0-250']) {
      try {
        const url = `${streetSources.panoramaxSearch}?place_position=${lon},${lat}&place_distance=${range}&limit=1`;
        const { features } = (await (await fetch(url)).json()) as { features: PanoramaxItem[] };
        if (features.length) {
          this.reset();
          await this.showPanoramax(features[0]);
          return true;
        }
      } catch {
        return false;
      }
    }
    return false;
  }

  private async step(rel: 'prev' | 'next'): Promise<void> {
    const href = this.item?.links.find((l) => l.rel === rel)?.href;
    if (!href) return;
    const item = (await (await fetch(href)).json()) as PanoramaxItem;
    await this.showPanoramax(item);
  }

  private async showPanoramax(item: PanoramaxItem): Promise<void> {
    this.item = item;
    const [lon, lat] = item.geometry.coordinates;
    this.position = [lon, lat];
    const is360 = item.properties['pers:interior_orientation']?.field_of_view === 360;
    const date = item.properties.datetime ? new Date(item.properties.datetime).toLocaleDateString() : '';
    this.title.textContent = `Panoramax${date ? ` · ${date}` : ''}${is360 ? ' · 360°' : ''}`;
    const author = item.providers?.map((p) => p.name).join(', ') ?? 'contributors';
    this.credit.innerHTML = `Photo by ${author} via <a href="https://panoramax.fr" target="_blank">Panoramax</a>, ${item.properties.license ?? 'open licence'}`;
    this.prev.hidden = !item.links.some((l) => l.rel === 'prev');
    this.next.hidden = !item.links.some((l) => l.rel === 'next');
    this.placeMarker(lon, lat);

    const url = (item.assets.hd ?? item.assets.sd).href;
    if (is360) {
      if (this.sphere) {
        await this.sphere.setPanorama(url);
      } else {
        this.container.innerHTML = '';
        this.sphere = new SphereViewer({ container: this.container, panorama: url, navbar: ['zoom', 'fullscreen'] });
      }
    } else {
      this.sphere?.destroy();
      this.sphere = undefined;
      const img = document.createElement('img');
      img.src = item.assets.sd?.href ?? url;
      img.alt = 'Street-level photo';
      this.container.replaceChildren(img);
    }
  }

  private placeMarker(lon: number, lat: number): void {
    if (this.marker) this.viewer.entities.remove(this.marker);
    this.marker = this.viewer.entities.add({
      position: Cartesian3.fromDegrees(lon, lat),
      point: {
        pixelSize: 14,
        color: Color.fromCssColorString('#ff7a1a'),
        outlineColor: Color.WHITE,
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
  }
}
