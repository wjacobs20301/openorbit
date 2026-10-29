import {
  BoundingSphere,
  CameraEventType,
  Cartesian2,
  Cartesian3,
  HeadingPitchRange,
  KeyboardEventModifier,
  Math as CesiumMath,
  type Viewer,
} from 'cesium';
import { isTyping } from './platform';

const TURN_STEP = CesiumMath.toRadians(45);
const KEY_TURN_STEP = CesiumMath.toRadians(10);
const KEY_TILT_STEP = CesiumMath.toRadians(8);
/** Closest to the horizon the controls will tilt (radians below horizontal). */
const MIN_PITCH = CesiumMath.toRadians(-8);
const TILTED_PITCH = CesiumMath.toRadians(-35);

/** The ground point at the middle of the screen, which turning and tilting orbit around. */
function centerTarget(viewer: Viewer): Cartesian3 | undefined {
  const { canvas } = viewer.scene;
  const ray = viewer.camera.getPickRay(new Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2));
  return ray ? viewer.scene.globe.pick(ray, viewer.scene) : undefined;
}

/**
 * Moves the camera to look at the centre point from the given heading/pitch, keeping
 * the distance. `duration` 0 jumps (for held keys); otherwise it animates.
 */
function orbitTo(viewer: Viewer, heading: number, pitch: number, duration: number, rangeScale = 1): void {
  const { camera } = viewer;
  const target = centerTarget(viewer);
  if (!target) {
    // Looking at the sky or space: turn in place instead.
    camera.setView({ orientation: { heading, pitch, roll: 0 } });
    return;
  }
  const range = Cartesian3.distance(camera.positionWC, target) * rangeScale;
  const clamped = CesiumMath.clamp(pitch, -CesiumMath.PI_OVER_TWO, MIN_PITCH);
  camera.flyToBoundingSphere(new BoundingSphere(target, 0), {
    offset: new HeadingPitchRange(heading, clamped, range),
    duration,
  });
}

/** Pans over the ground in the direction the camera faces (or sideways), scaled by altitude. */
function pan(viewer: Viewer, forward: number, right: number): void {
  const { camera } = viewer;
  const up = viewer.scene.globe.ellipsoid.geodeticSurfaceNormal(camera.positionWC);
  // Horizontal "forward": the view direction, or camera-up when looking straight down.
  const look = Math.abs(Cartesian3.dot(camera.directionWC, up)) > 0.99 ? camera.upWC : camera.directionWC;
  const ahead = Cartesian3.normalize(
    Cartesian3.subtract(look, Cartesian3.multiplyByScalar(up, Cartesian3.dot(look, up), new Cartesian3()), new Cartesian3()),
    new Cartesian3(),
  );
  const side = Cartesian3.cross(ahead, up, new Cartesian3());
  const step = Math.max(camera.positionCartographic.height, 50) * 0.15;
  camera.move(ahead, forward * step);
  camera.move(side, right * step);
}

/** Zooms toward (positive factor) or away from the centre point by a share of the distance. */
function zoom(viewer: Viewer, factor: number): void {
  const target = centerTarget(viewer);
  const distance = target
    ? Cartesian3.distance(viewer.camera.positionWC, target)
    : viewer.camera.positionCartographic.height;
  if (factor > 0) viewer.camera.zoomIn(distance * factor);
  else viewer.camera.zoomOut(distance * -factor);
}

/**
 * Google Earth–style navigation on top of Cesium's defaults: Shift+drag tilts,
 * Option/Alt+drag looks around, an on-screen compass and turn/tilt/zoom buttons, and
 * keyboard shortcuts. `keysEnabled` lets street view take the arrow keys while open.
 */
export function setupNavControls(viewer: Viewer, keysEnabled: () => boolean): void {
  const control = viewer.scene.screenSpaceCameraController;
  control.tiltEventTypes = [
    CameraEventType.MIDDLE_DRAG,
    CameraEventType.PINCH,
    { eventType: CameraEventType.LEFT_DRAG, modifier: KeyboardEventModifier.SHIFT },
    { eventType: CameraEventType.LEFT_DRAG, modifier: KeyboardEventModifier.CTRL },
    { eventType: CameraEventType.RIGHT_DRAG, modifier: KeyboardEventModifier.CTRL },
  ];
  control.lookEventTypes = [{ eventType: CameraEventType.LEFT_DRAG, modifier: KeyboardEventModifier.ALT }];
  // Slightly less glide after letting go, so the globe feels more responsive.
  control.inertiaSpin = 0.8;
  control.inertiaTranslate = 0.8;
  control.inertiaZoom = 0.7;

  const { camera } = viewer;
  const turn = (delta: number, duration: number) => orbitTo(viewer, camera.heading + delta, camera.pitch, duration);
  const tilt = (delta: number, duration: number) => orbitTo(viewer, camera.heading, camera.pitch + delta, duration);
  const northUp = () => orbitTo(viewer, 0, camera.pitch, 0.6);
  const toggleTopDown = () =>
    orbitTo(viewer, camera.heading, camera.pitch < -1.45 ? TILTED_PITCH : -CesiumMath.PI_OVER_TWO, 0.6);

  // On-screen controls, top right under Cesium's home button.
  const panel = document.createElement('div');
  panel.id = 'nav-controls';
  panel.innerHTML = `
    <button class="compass" title="Face north (N)"><span>N</span></button>
    <div class="nav-row">
      <button data-act="left" title="Turn left (Shift+←)">⟲</button>
      <button data-act="right" title="Turn right (Shift+→)">⟳</button>
    </div>
    <button data-act="tilt" title="Switch between top-down and tilted (T)">Tilt</button>
    <div class="nav-row">
      <button data-act="out" title="Zoom out (−)">−</button>
      <button data-act="in" title="Zoom in (+)">+</button>
    </div>
    <button class="nav-help" title="Drag: move · Shift+drag: tilt and turn · Option/Alt+drag: look around · Scroll: zoom · Arrows: move · Shift+arrows: turn and tilt · +/−: zoom · N: north · T: tilt">?</button>`;
  viewer.container.append(panel);

  const compass = panel.querySelector<HTMLElement>('.compass span')!;
  viewer.scene.postRender.addEventListener(() => {
    compass.style.transform = `rotate(${-CesiumMath.toDegrees(camera.heading)}deg)`;
  });

  const actions: Record<string, () => void> = {
    left: () => turn(-TURN_STEP, 0.5),
    right: () => turn(TURN_STEP, 0.5),
    tilt: toggleTopDown,
    in: () => zoom(viewer, 0.4),
    out: () => zoom(viewer, -0.6),
  };
  panel.querySelector('.compass')!.addEventListener('click', northUp);
  panel.querySelectorAll<HTMLButtonElement>('[data-act]').forEach((b) =>
    b.addEventListener('click', () => actions[b.dataset.act!]()),
  );

  document.addEventListener('keydown', (e) => {
    if (!keysEnabled() || e.metaKey || e.ctrlKey || isTyping(e)) return;
    const k = e.key;
    if (e.shiftKey && k === 'ArrowLeft') turn(-KEY_TURN_STEP, 0);
    else if (e.shiftKey && k === 'ArrowRight') turn(KEY_TURN_STEP, 0);
    else if (e.shiftKey && k === 'ArrowUp') tilt(KEY_TILT_STEP, 0);
    else if (e.shiftKey && k === 'ArrowDown') tilt(-KEY_TILT_STEP, 0);
    else if (k === 'ArrowUp') pan(viewer, 1, 0);
    else if (k === 'ArrowDown') pan(viewer, -1, 0);
    else if (k === 'ArrowLeft') pan(viewer, 0, -1);
    else if (k === 'ArrowRight') pan(viewer, 0, 1);
    else if (k === '+' || k === '=') zoom(viewer, 0.3);
    else if (k === '-' || k === '_') zoom(viewer, -0.45);
    else if (k.toLowerCase() === 'n') northUp();
    else if (k.toLowerCase() === 't') toggleTopDown();
    else return;
    e.preventDefault();
    viewer.scene.requestRender();
  });
}

