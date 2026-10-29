import type { Viewer as SphereViewer } from '@photo-sphere-viewer/core';
import { Cartesian3, Color, type Entity, type Viewer } from 'cesium';
import type { Viewer as MapillaryViewer } from 'mapillary-js';
import { isTyping, loadSetting, openExternal } from './platform';
import { streetSources } from './sources';

interface PanoramaxItem {
  id: string;
  /** The sequence (one capture trip) the photo belongs to. */
  collection?: string;
  geometry: { coordinates: [number, number] };
  assets: Record<string, { href: string }>;
  links: { rel: string; href: string }[];
  providers?: { name: string }[];
  properties: {
    datetime?: string;
    license?: string;
    'pers:interior_orientation'?: { field_of_view?: number };
    /** Compass direction (degrees) of the photo's centre. */
    'view:azimuth'?: number;
  };
}

/** Where the person is looking: compass heading (degrees), pitch (radians) and zoom. */
interface Look {
  heading: number;
  pitch: number;
  zoom?: number;
}

/** How long to wait for the first (standard-size) photo before giving up. */
const PHOTO_TIMEOUT = 20_000;
/** The full-size upgrade can take longer; it only replaces the photo if it arrives. */
const HD_TIMEOUT = 120_000;
/** Search half-widths in degrees for Mapillary: right at the click, and wider as a fallback. */
const MAPILLARY_NEAR = 0.0005;
const MAPILLARY_WIDE = 0.002;
/** Rough camera height above the road, for turning a click below the horizon into a distance. */
const CAMERA_HEIGHT = 2.5;
const MIN_STEP = 4;
const MAX_STEP = 60;
/** Distance used when clicking at or above the horizon. */
const DEFAULT_STEP = 20;
/** Field of view assumed for flat photos that don't record one. */
const FLAT_FOV = 70;
/** Metres a photo from another capture trip must be closer by to be chosen over the current trip. */
const OTHER_TRIP_PENALTY = 8;
const DEG = 180 / Math.PI;

const azimuth = (item: PanoramaxItem) => item.properties['view:azimuth'] ?? 0;
const is360 = (item: PanoramaxItem) => item.properties['pers:interior_orientation']?.field_of_view === 360;

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
  private readonly stage = document.querySelector<HTMLElement>('#street-stage')!;

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
    const expand = document.querySelector<HTMLButtonElement>('#street-expand')!;
    const toggleExpand = () => {
      const on = this.panel.classList.toggle('expanded');
      expand.textContent = on ? 'Shrink' : 'Expand';
    };
    expand.addEventListener('click', toggleExpand);

    // Keyboard while the viewer is open: ↑/W forward, ↓/S back, F expand. Left/right
    // turn the 360° view (handled by the photo viewer itself).
    document.addEventListener('keydown', (e) => {
      if (this.panel.hidden || isTyping(e)) return;
      const key = e.key.toLowerCase();
      if (key === 'arrowup' || key === 'w') void this.step('next');
      else if (key === 'arrowdown' || key === 's') void this.step('prev');
      else if (key === 'f') toggleExpand();
      else return;
      e.preventDefault();
    });
  }

  /** True while the viewer is open, so other keyboard shortcuts can stand aside. */
  get isOpen(): boolean {
    return !this.panel.hidden;
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
    this.setLoading(false);
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
    const look = this.currentLook();
    this.setLoading(true);
    try {
      const item = (await (await fetch(href, { signal: AbortSignal.timeout(PHOTO_TIMEOUT) })).json()) as PanoramaxItem;
      await this.showPanoramax(item, look);
    } catch {
      this.setLoading(false);
    }
  }

  /** The direction currently being looked at, in compass terms, so the next photo can match it. */
  private currentLook(): Look | undefined {
    if (!this.item) return undefined;
    if (!this.sphere) return { heading: azimuth(this.item), pitch: 0 };
    const { yaw, pitch } = this.sphere.getPosition();
    return { heading: azimuth(this.item) + yaw * DEG, pitch, zoom: this.sphere.getZoomLevel() };
  }

  /**
   * Click-to-move: a click below the horizon is turned into a distance along the ground
   * (from the camera height), and the nearest photo around that spot is shown, keeping
   * the current viewing direction.
   */
  private async moveToward(heading: number, pitch: number): Promise<void> {
    if (!this.item) return;
    const distance =
      pitch < -0.03 ? Math.min(MAX_STEP, Math.max(MIN_STEP, CAMERA_HEIGHT / Math.tan(-pitch))) : DEFAULT_STEP;
    const [lon, lat] = this.position;
    const rad = heading / DEG;
    const target: [number, number] = [
      lon + (distance * Math.sin(rad)) / (111_320 * Math.cos(lat / DEG)),
      lat + (distance * Math.cos(rad)) / 111_320,
    ];
    const look = this.currentLook();
    const currentId = this.item.id;
    this.setLoading(true);
    try {
      const url = `${streetSources.panoramaxSearch}?place_position=${target[0]},${target[1]}&place_distance=0-30&limit=10`;
      const { features } = (await (await fetch(url, { signal: AbortSignal.timeout(PHOTO_TIMEOUT) })).json()) as {
        features: PanoramaxItem[];
      };
      const metres = (c: [number, number], d: [number, number]) =>
        Math.hypot((c[0] - d[0]) * 111_320 * Math.cos(lat / DEG), (c[1] - d[1]) * 111_320);
      // Nearest photo to the clicked spot that isn't (practically) where we already are,
      // preferring the same capture trip so lighting and date don't jump around.
      const collection = this.item.collection;
      const score = (f: PanoramaxItem) =>
        metres(f.geometry.coordinates, target) + (f.collection === collection ? 0 : OTHER_TRIP_PENALTY);
      const best = features
        .filter((f) => f.id !== currentId && metres(f.geometry.coordinates, this.position) > 2)
        .sort((a, b) => score(a) - score(b))[0];
      if (best) {
        await this.showPanoramax(best, look);
        return;
      }
      this.flash('No photo there. Try clicking further along the road.');
    } catch {
      this.flash("Couldn't reach Panoramax.");
    }
    this.setLoading(false);
  }

  /** Shows a short note over the photo for a few seconds. */
  private flash(text: string): void {
    const note = document.createElement('div');
    note.className = 'street-flash';
    note.textContent = text;
    this.stage.append(note);
    window.setTimeout(() => note.remove(), 2500);
  }

  private setLoading(on: boolean): void {
    this.stage.classList.toggle('loading', on);
  }

  private async showPanoramax(item: PanoramaxItem, look?: Look): Promise<void> {
    this.item = item;
    const [lon, lat] = item.geometry.coordinates;
    this.position = [lon, lat];
    const spherical = is360(item);
    const date = item.properties.datetime ? new Date(item.properties.datetime).toLocaleDateString() : '';
    // Say whether it's a 360° photo: flat ones can't be turned.
    this.title.textContent = `Panoramax${date ? ` · ${date}` : ''} · ${
      spherical ? '360° · drag to look, click the road to move' : 'photo, not 360° · click the road to move'
    }`;
    const author = item.providers?.map((p) => p.name).join(', ') ?? 'contributors';
    this.credit.innerHTML = `Photo by ${author} via <a href="https://panoramax.fr" target="_blank">Panoramax</a>, ${item.properties.license ?? 'open licence'}`;
    this.prev.hidden = !item.links.some((l) => l.rel === 'prev');
    this.next.hidden = !item.links.some((l) => l.rel === 'next');
    this.placeMarker(lon, lat);

    // Standard size first (fast), then swap in full size for 360° photos if it arrives.
    // The current photo stays up (with a loading badge) until the new one is ready.
    const id = ++this.loadId;
    const first = (item.assets.sd ?? item.assets.hd).href;
    const full = spherical && item.assets.hd && item.assets.hd.href !== first ? item.assets.hd.href : null;
    this.setLoading(true);

    let src: string;
    try {
      src = await fetchImage(first, PHOTO_TIMEOUT);
    } catch {
      if (id === this.loadId) {
        this.setLoading(false);
        await this.photoFailed(item);
      }
      return;
    }
    if (id !== this.loadId) return URL.revokeObjectURL(src);
    const previous = this.objectUrls;
    this.objectUrls = [src];

    if (spherical) {
      // Turn the new photo to face the same compass direction as before.
      const position = look ? { yaw: (look.heading - azimuth(item)) / DEG, pitch: look.pitch } : undefined;
      await this.showSphere(src, position, look?.zoom);
      if (full) {
        fetchImage(full, HD_TIMEOUT)
          .then(async (hd) => {
            if (id !== this.loadId || !this.sphere) return URL.revokeObjectURL(hd);
            this.objectUrls.push(hd);
            const sphere = this.sphere;
            await sphere.setPanorama(hd, {
              transition: false,
              showLoader: false,
              position: sphere.getPosition(),
              zoom: sphere.getZoomLevel(),
            });
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
      img.addEventListener('click', (e) => this.flatClick(img, e, item));
      this.container.replaceChildren(img);
    }
    previous.forEach((u) => URL.revokeObjectURL(u));
    this.setLoading(false);
  }

  /** Click-to-move on a flat photo: estimate the direction from where in the frame it was clicked. */
  private flatClick(img: HTMLImageElement, e: MouseEvent, item: PanoramaxItem): void {
    const box = img.getBoundingClientRect();
    // The image is letterboxed (object-fit: contain); find the drawn area.
    const scale = Math.min(box.width / img.naturalWidth, box.height / img.naturalHeight);
    const [w, h] = [img.naturalWidth * scale, img.naturalHeight * scale];
    const fx = (e.clientX - box.left - (box.width - w) / 2) / w;
    const fy = (e.clientY - box.top - (box.height - h) / 2) / h;
    if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return;
    const fov = item.properties['pers:interior_orientation']?.field_of_view ?? FLAT_FOV;
    const verticalFov = (fov * h) / w;
    void this.moveToward(azimuth(item) + (fx - 0.5) * fov, (-(fy - 0.5) * verticalFov) / DEG);
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

  private async showSphere(src: string, position?: { yaw: number; pitch: number }, zoom?: number): Promise<void> {
    if (this.sphere) {
      await this.sphere.setPanorama(src, { transition: false, showLoader: false, position, zoom });
      return;
    }
    const [{ Viewer: SphereViewer }] = await Promise.all([
      import('@photo-sphere-viewer/core'),
      import('@photo-sphere-viewer/core/index.css'),
    ]);
    this.container.innerHTML = '';
    this.sphere = new SphereViewer({
      container: this.container,
      panorama: src,
      defaultYaw: position?.yaw ?? 0,
      defaultPitch: position?.pitch ?? 0,
      defaultZoomLvl: zoom ?? 50,
      navbar: ['moveLeft', 'moveRight', 'zoomOut', 'zoomIn'],
      // Arrow keys turn the view without clicking it first; up/down step along the route.
      // (PSV doesn't export its ACTIONS enum, so its string values are cast.)
      keyboard: 'always',
      keyboardActions: {
        ArrowLeft: 'ROTATE_LEFT' as never,
        ArrowRight: 'ROTATE_RIGHT' as never,
        '+': 'ZOOM_IN' as never,
        '-': 'ZOOM_OUT' as never,
      },
    });
    // Click a spot on the road to move there (drags don't count as clicks).
    this.sphere.addEventListener('click', ({ data }) => {
      if (!data.rightclick && this.item) void this.moveToward(azimuth(this.item) + data.yaw * DEG, data.pitch);
    });
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
