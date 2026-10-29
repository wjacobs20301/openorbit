import {
  Cartesian2,
  Cartesian3,
  Color,
  HeightReference,
  ImageryLayer,
  Math as CesiumMath,
  PerspectiveFrustum,
  VerticalOrigin,
  type Entity,
  type ImageryProvider,
  type Viewer,
} from 'cesium';
import { pickGround } from './globe';
import { PERSON_ICON } from './icons';
import { VectorLineProvider, type Painter } from './overlay';
import { loadPhotoTile, nearestPhoto, PHOTO_TILE_ZOOM, type PhotoSpot } from './photomap';
import type { StreetView } from './streetview';

/** How far (screen pixels) the person reaches to snap onto a photo. */
const SNAP_PIXELS = 28;
const MIN_SNAP = 8;
const MAX_SNAP = 250;
/** Coverage lines appear from about city zoom; wider views would download a lot. */
const COVERAGE_MIN_LEVEL = 11;

const paintCoverage: Painter = (ctx, layer, _props, z) => {
  if (layer !== 'sequences') return false;
  ctx.setLineDash([]);
  // Thin and translucent: busy streets have many overlapping capture trips.
  ctx.strokeStyle = 'rgba(40, 140, 255, 0.55)';
  ctx.lineWidth = z >= 15 ? 2.5 : 1.8;
  return true;
};

/**
 * Google-style street view person: drag it from the map controls onto the map. While
 * dragging, blue lines show where photos exist and the person snaps to the nearest
 * photo; dropping it opens street view there.
 */
export class Pegman {
  readonly coverage: ImageryLayer;
  private readonly ghost = document.createElement('img');
  private snapMarker?: Entity;
  private snapped: PhotoSpot | null = null;
  private lookup = 0;
  private timer?: number;

  constructor(
    private readonly viewer: Viewer,
    private readonly street: StreetView,
  ) {
    const provider = new VectorLineProvider(['sequences'], [paintCoverage], {
      load: loadPhotoTile,
      maxZoom: PHOTO_TILE_ZOOM,
      credit: 'Street photos: <a href="https://panoramax.fr">Panoramax</a>',
    });
    this.coverage = new ImageryLayer(provider as unknown as ImageryProvider, { minimumTerrainLevel: COVERAGE_MIN_LEVEL });
    this.coverage.show = false;
    viewer.imageryLayers.add(this.coverage);

    const button = document.createElement('button');
    button.id = 'pegman';
    button.title = 'Drag onto a blue line to see street-level photos';
    button.innerHTML = `<img src="${PERSON_ICON}" alt="" draggable="false" />`;
    document.querySelector('#nav-controls')?.prepend(button);

    this.ghost.src = PERSON_ICON;
    this.ghost.className = 'pegman-ghost';
    this.ghost.hidden = true;
    document.body.append(this.ghost);

    button.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      button.setPointerCapture(e.pointerId);
      this.startDrag(e);
    });
    button.addEventListener('pointermove', (e) => {
      if (button.hasPointerCapture(e.pointerId)) this.moveDrag(e);
    });
    button.addEventListener('pointerup', (e) => {
      if (!button.hasPointerCapture(e.pointerId)) return;
      button.releasePointerCapture(e.pointerId);
      void this.endDrag(e);
    });

    street.onVisibilityChange((open) => this.showCoverage(open));
  }

  /** Blue coverage lines: shown while dragging, while street view is open, or on request. */
  showCoverage(on: boolean): void {
    this.coverage.show = on || this.street.isOpen;
    this.viewer.scene.requestRender();
  }

  private startDrag(e: PointerEvent): void {
    this.snapped = null;
    this.ghost.hidden = false;
    this.ghost.dataset.state = 'none';
    this.placeGhost(e);
    this.coverage.show = true;
    this.viewer.scene.requestRender();
  }

  private moveDrag(e: PointerEvent): void {
    this.placeGhost(e);
    // Look for a photo once the pointer pauses briefly, not on every pixel of movement.
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.findSnap(e.clientX, e.clientY), 90);
  }

  private async endDrag(e: PointerEvent): Promise<void> {
    window.clearTimeout(this.timer);
    this.ghost.hidden = true;
    const ground = this.groundAt(e.clientX, e.clientY);
    const spot = ground ? (this.snapped ?? (await this.findSnap(e.clientX, e.clientY))) : null;
    // Ignore any lookups still in flight, then remove the drag preview.
    this.lookup++;
    this.clearSnapMarker();
    this.snapped = null;
    if (spot) await this.street.openSpot(spot);
    else if (ground) {
      // No Panoramax photo here; street view still tries Mapillary and shows the outcome.
      await this.street.openAt(CesiumMath.toDegrees(ground.longitude), CesiumMath.toDegrees(ground.latitude));
    }
    this.showCoverage(false);
  }

  private placeGhost(e: PointerEvent): void {
    this.ghost.style.left = `${e.clientX}px`;
    this.ghost.style.top = `${e.clientY}px`;
  }

  private groundAt(clientX: number, clientY: number) {
    const box = this.viewer.canvas.getBoundingClientRect();
    if (clientX < box.left || clientX > box.right || clientY < box.top || clientY > box.bottom) return undefined;
    return pickGround(this.viewer, new Cartesian2(clientX - box.left, clientY - box.top));
  }

  /** Finds the photo nearest the pointer (within a few screen pixels) and shows the person there. */
  private async findSnap(clientX: number, clientY: number): Promise<PhotoSpot | null> {
    const id = ++this.lookup;
    const ground = this.groundAt(clientX, clientY);
    if (!ground) {
      this.setSnap(null);
      return null;
    }
    const lon = CesiumMath.toDegrees(ground.longitude);
    const lat = CesiumMath.toDegrees(ground.latitude);
    const spot = await nearestPhoto(lon, lat, this.snapRadius(Cartesian3.fromRadians(ground.longitude, ground.latitude)));
    if (id !== this.lookup) return spot;
    this.setSnap(spot);
    return spot;
  }

  /** Metres covered by SNAP_PIXELS at that spot on screen. */
  private snapRadius(point: Cartesian3): number {
    const { camera, canvas } = this.viewer;
    const frustum = camera.frustum as PerspectiveFrustum;
    const distance = Cartesian3.distance(camera.positionWC, point);
    const metresPerPixel = (2 * distance * Math.tan((frustum.fovy ?? 1) / 2)) / canvas.clientHeight;
    return CesiumMath.clamp(SNAP_PIXELS * metresPerPixel, MIN_SNAP, MAX_SNAP);
  }

  private setSnap(spot: PhotoSpot | null): void {
    this.snapped = spot;
    this.ghost.dataset.state = spot ? 'ok' : 'none';
    this.clearSnapMarker();
    if (spot) {
      this.snapMarker = this.viewer.entities.add({
        position: Cartesian3.fromDegrees(spot.lon, spot.lat),
        billboard: {
          image: PERSON_ICON,
          width: 28,
          height: 40,
          verticalOrigin: VerticalOrigin.BOTTOM,
          heightReference: HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        point: {
          pixelSize: 10,
          color: Color.fromCssColorString('#3d8bff'),
          outlineColor: Color.WHITE,
          outlineWidth: 2,
          heightReference: HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    }
    this.viewer.scene.requestRender();
  }

  private clearSnapMarker(): void {
    if (this.snapMarker) this.viewer.entities.remove(this.snapMarker);
    this.snapMarker = undefined;
  }
}
