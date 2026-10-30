import { CallbackProperty, Ellipsoid, type Viewer } from 'cesium';

/**
 * Labels and markers should sit on top of the terrain (a hill shouldn't cut a name in
 * half) but still disappear behind the planet. Cesium's disableDepthTestDistance does
 * the first only up to a distance, so it's set to how far the camera can see over the
 * horizon: anything nearer is on this side of the globe and drawn on top; anything on
 * the far side is further away, so the globe hides it as usual.
 */

/** Allowance for terrain poking above the horizon: Everest-high ground ~340 km beyond it. */
const TERRAIN_REACH = Math.sqrt(2 * Ellipsoid.WGS84.maximumRadius * 9000);

let distance = Number.POSITIVE_INFINITY;

/** Keeps the horizon distance current as the camera moves. Call once at startup. */
export function trackHorizon(viewer: Viewer): void {
  viewer.scene.preRender.addEventListener(() => {
    const h = Math.max(0, viewer.camera.positionCartographic.height);
    distance = Math.sqrt(h * (2 * Ellipsoid.WGS84.maximumRadius + h)) + TERRAIN_REACH;
  });
}

/** The current horizon distance, for labels and billboards in primitive collections. */
export function horizonDistance(): number {
  return distance;
}

/** For entity graphics: `disableDepthTestDistance: ON_TOP`. */
export const ON_TOP = new CallbackProperty(() => distance, false);
