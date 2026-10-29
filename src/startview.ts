import { Cartesian3, Math as CesiumMath, type Viewer } from 'cesium';
import { loadSetting, storeSetting } from './platform';

interface SavedView {
  lon: number;
  lat: number;
  height: number;
  heading: number;
  pitch: number;
}

function current(viewer: Viewer): SavedView {
  const { camera } = viewer;
  const c = camera.positionCartographic;
  return {
    lon: CesiumMath.toDegrees(c.longitude),
    lat: CesiumMath.toDegrees(c.latitude),
    height: c.height,
    heading: camera.heading,
    pitch: camera.pitch,
  };
}

function read(key: string): SavedView | null {
  try {
    const v = JSON.parse(loadSetting(key) || 'null') as SavedView | null;
    return v && Number.isFinite(v.lon) && Number.isFinite(v.height) ? v : null;
  } catch {
    return null;
  }
}

function goTo(viewer: Viewer, v: SavedView, duration?: number): void {
  const destination = Cartesian3.fromDegrees(v.lon, v.lat, v.height);
  const orientation = { heading: v.heading, pitch: v.pitch, roll: 0 };
  if (duration === 0) viewer.camera.setView({ destination, orientation });
  else viewer.camera.flyTo({ destination, orientation, duration });
}

/**
 * Where the globe opens: the start location if one was set (View > Make this my start
 * location), otherwise wherever it was last left. The Home button goes to the start
 * location, or the whole Earth when none is set.
 */
export function setupStartView(viewer: Viewer): { makeStart(): void; clearStart(): void; goHome(): void } {
  const start = read('startView');
  const last = read('lastView');
  if (start ?? last) goTo(viewer, (start ?? last)!, 0);

  let timer = 0;
  viewer.camera.moveEnd.addEventListener(() => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => storeSetting('lastView', JSON.stringify(current(viewer))), 500);
  });

  // Also on close, in case the last move didn't finish with a moveEnd.
  window.addEventListener('pagehide', () => storeSetting('lastView', JSON.stringify(current(viewer))));


  return {
    makeStart() {
      storeSetting('startView', JSON.stringify(current(viewer)));
    },
    clearStart() {
      storeSetting('startView', '');
    },
    /** The start location if set, otherwise the whole Earth. */
    goHome() {
      const home = read('startView');
      if (home) goTo(viewer, home);
      else viewer.camera.flyHome(1.5);
    },
  };
}
