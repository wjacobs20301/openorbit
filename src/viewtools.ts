import { Math as CesiumMath, type Viewer } from 'cesium';
import { openExternal } from './platform';

/** The camera as latitude, longitude, altitude (m), heading and tilt (degrees). */
function cameraView(viewer: Viewer) {
  const { camera } = viewer;
  const c = camera.positionCartographic;
  return {
    lat: CesiumMath.toDegrees(c.latitude),
    lon: CesiumMath.toDegrees(c.longitude),
    alt: Math.max(1, c.height),
    heading: CesiumMath.toDegrees(camera.heading),
    tilt: 90 + CesiumMath.toDegrees(camera.pitch),
  };
}

/** Opens the current view in Google Maps (satellite) in the browser. */
export function openInGoogleMaps(viewer: Viewer): Promise<void> {
  const v = cameraView(viewer);
  return openExternal(`https://www.google.com/maps/@${v.lat.toFixed(6)},${v.lon.toFixed(6)},${Math.round(v.alt)}m/data=!3m1!1e3`);
}

/** Opens the current view in Google Earth on the web. */
export function openInGoogleEarthWeb(viewer: Viewer): Promise<void> {
  const v = cameraView(viewer);
  return openExternal(
    `https://earth.google.com/web/@${v.lat.toFixed(6)},${v.lon.toFixed(6)},0a,${Math.round(v.alt)}d,35y,${v.heading.toFixed(1)}h,${v.tilt.toFixed(1)}t,0r`,
  );
}

/** "lat, lon" of the view centre, for Copy View Location. */
export function viewLocation(viewer: Viewer): string {
  const v = cameraView(viewer);
  return `${v.lat.toFixed(6)}, ${v.lon.toFixed(6)}`;
}
