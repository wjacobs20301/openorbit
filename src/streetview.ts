import type { Viewer as SphereViewer } from '@photo-sphere-viewer/core';
import { Cartesian3, Color, type Entity, type Viewer } from 'cesium';
import type { Viewer as MapillaryViewer } from 'mapillary-js';
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

/** How long to wait for the first (standard-size) photo before giving up. */
const PHOTO_TIMEOUT = 20_000;
/** The full-size upgrade can take longer; it only replaces the photo if it arrives. */
const HD_TIMEOUT = 120_000;
/** Search half-widths in degrees for Mapillary: right at the click, and wider as a fallback. */
const MAPILLARY_NEAR = 0.0005;
const MAPILLARY_WIDE = 0.002;

/** Downloads an image within `ms`, returning an object URL (the caller revokes it). */
async function fetchImage(url: string, ms: number): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return URL.createObjectURL(await res.blob());
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
  /** Bumped per photo, so slow downloads for a photo no longer shown are ignored. */
  private loadId = 0;
  private objectUrls: string[] = [];

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
    this.loadId++;
    this.releaseUrls();
    this.sphere?.destroy();
    this.sphere = undefined;
    this.mapillary?.remove();
    this.mapillary = undefined;
    this.item = undefined;
    this.container.innerHTML = '';
    this.prev.hidden = this.next.hidden = true;
  }

  private async tryMapillary(token: string, lon: number, lat: number, d = MAPILLARY_NEAR): Promise<boolean> {
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

      // Loaded on first use to keep startup light.
      const [{ Viewer: MapillaryViewer }] = await Promise.all([
        import('mapillary-js'),
        import('mapillary-js/dist/mapillary.css'),
      ]);
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

    // Standard size first (fast), then swap in full size for 360° photos if it arrives.
    const id = ++this.loadId;
    const first = (item.assets.sd ?? item.assets.hd).href;
    const full = is360 && item.assets.hd && item.assets.hd.href !== first ? item.assets.hd.href : null;
    this.releaseUrls();
    this.showMessage('Loading photo…');

    let src: string;
    try {
      src = await fetchImage(first, PHOTO_TIMEOUT);
    } catch {
      if (id === this.loadId) await this.photoFailed(item);
      return;
    }
    if (id !== this.loadId) return URL.revokeObjectURL(src);
    this.objectUrls.push(src);

    if (is360) {
      await this.showSphere(src);
      if (full) {
        fetchImage(full, HD_TIMEOUT)
          .then(async (hd) => {
            if (id !== this.loadId || !this.sphere) return URL.revokeObjectURL(hd);
            this.objectUrls.push(hd);
            await this.sphere.setPanorama(hd, { transition: false, showLoader: false });
          })
          .catch(() => {
            // Keep showing the standard-size photo.
          });
      }
    } else {
      this.sphere?.destroy();
      this.sphere = undefined;
      const img = document.createElement('img');
      img.src = src;
      img.alt = 'Street-level photo';
      this.container.replaceChildren(img);
    }
  }

  /** A Panoramax photo didn't load: try Mapillary around the same spot, or explain what to do. */
  private async photoFailed(item: PanoramaxItem): Promise<void> {
    const [lon, lat] = item.geometry.coordinates;
    const token = loadSetting('mapillaryToken');
    if (token) {
      this.showMessage("Panoramax isn't responding. Trying Mapillary…");
      if (await this.tryMapillary(token, lon, lat, MAPILLARY_WIDE)) return;
    }
    const advice = token
      ? "The photo server isn't responding, and Mapillary found nothing nearby (or the token in Settings isn't valid). Try again later, or open this spot in Google."
      : "The photo server isn't responding. Add a Mapillary token in Settings to see other photos here, or open this spot in Google.";
    this.showMessage(advice, () => void this.showPanoramax(item));
  }

  private async showSphere(src: string): Promise<void> {
    if (this.sphere) {
      await this.sphere.setPanorama(src, { transition: false });
      return;
    }
    const [{ Viewer: SphereViewer }] = await Promise.all([
      import('@photo-sphere-viewer/core'),
      import('@photo-sphere-viewer/core/index.css'),
    ]);
    this.container.innerHTML = '';
    this.sphere = new SphereViewer({ container: this.container, panorama: src, navbar: ['zoom', 'fullscreen'] });
  }

  /** Replaces the viewer with a short message, plus a Retry button when `retry` is given. */
  private showMessage(text: string, retry?: () => void): void {
    this.sphere?.destroy();
    this.sphere = undefined;
    const box = document.createElement('div');
    box.className = 'street-message';
    box.textContent = text;
    if (retry) {
      const again = document.createElement('button');
      again.textContent = 'Retry';
      again.addEventListener('click', retry);
      box.append(again);
    }
    this.container.replaceChildren(box);
  }

  private releaseUrls(): void {
    this.objectUrls.forEach((u) => URL.revokeObjectURL(u));
    this.objectUrls = [];
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
