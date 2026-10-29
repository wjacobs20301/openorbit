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
function pan(viewer: Viewer, forward: number, right: number, share = 0.15): void {
  const { camera } = viewer;
  const up = viewer.scene.globe.ellipsoid.geodeticSurfaceNormal(camera.positionWC);
  // Horizontal "forward": the view direction, or camera-up when looking straight down.
  const look = Math.abs(Cartesian3.dot(camera.directionWC, up)) > 0.99 ? camera.upWC : camera.directionWC;
  const ahead = Cartesian3.normalize(
    Cartesian3.subtract(look, Cartesian3.multiplyByScalar(up, Cartesian3.dot(look, up), new Cartesian3()), new Cartesian3()),
    new Cartesian3(),
  );
  const side = Cartesian3.cross(ahead, up, new Cartesian3());
  const step = Math.max(camera.positionCartographic.height, 50) * share;
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
/** Camera resets, for the View menu. */
export interface NavActions {
  northUp(): void;
  resetTilt(): void;
  resetTiltAndNorth(): void;
}

/** While a button is held, run `step` repeatedly (first right away). */
function holdRepeat(button: HTMLElement, step: () => void, viewer: Viewer): void {
  let timer = 0;
  const stop = () => window.clearInterval(timer);
  button.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    button.setPointerCapture(e.pointerId);
    const tick = () => {
      step();
      viewer.scene.requestRender();
    };
    tick();
    timer = window.setInterval(tick, 40);
  });
  button.addEventListener('pointerup', stop);
  button.addEventListener('pointercancel', stop);
  button.addEventListener('lostpointercapture', stop);
}

export function setupNavControls(viewer: Viewer, keysEnabled: () => boolean): NavActions {
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
  const actions: NavActions = {
    northUp: () => orbitTo(viewer, 0, camera.pitch, 0.6),
    resetTilt: () => orbitTo(viewer, camera.heading, -CesiumMath.PI_OVER_TWO, 0.6),
    resetTiltAndNorth: () => orbitTo(viewer, 0, -CesiumMath.PI_OVER_TWO, 0.6),
  };
  const toggleTopDown = () =>
    orbitTo(viewer, camera.heading, camera.pitch < -1.45 ? TILTED_PITCH : -CesiumMath.PI_OVER_TWO, 0.6);

  // Google Earth–style cluster, top right: look ring, move joystick, (person), zoom slider.
  const panel = document.createElement('div');
  panel.id = 'nav-controls';
  panel.innerHTML = `
    <div class="nav-ring" title="Drag the ring to turn · click N to face north (N)">
      <button class="nav-north" aria-label="Face north">N</button>
      <button class="nav-arrow up" data-look="up" title="Tilt toward the horizon (Shift+↑)" aria-label="Tilt up">▲</button>
      <button class="nav-arrow down" data-look="down" title="Tilt toward straight down (Shift+↓)" aria-label="Tilt down">▼</button>
      <button class="nav-arrow left" data-look="left" title="Turn left (Shift+←)" aria-label="Turn left">◀</button>
      <button class="nav-arrow right" data-look="right" title="Turn right (Shift+→)" aria-label="Turn right">▶</button>
      <span class="nav-eye">👁</span>
    </div>
    <div class="nav-move" title="Move (arrow keys)">
      <button class="nav-arrow up" data-move="up" aria-label="Move forward">▲</button>
      <button class="nav-arrow down" data-move="down" aria-label="Move back">▼</button>
      <button class="nav-arrow left" data-move="left" aria-label="Move left">◀</button>
      <button class="nav-arrow right" data-move="right" aria-label="Move right">▶</button>
      <span class="nav-hand">✋</span>
    </div>
    <div class="nav-zoom">
      <button data-zoom="in" title="Zoom in (+)" aria-label="Zoom in">+</button>
      <input type="range" min="-100" max="100" value="0" orient="vertical" title="Drag to zoom; it springs back" aria-label="Zoom" />
      <button data-zoom="out" title="Zoom out (−)" aria-label="Zoom out">−</button>
    </div>
    <button class="nav-tilt" title="Switch between top-down and tilted (U)">Tilt</button>`;
  viewer.container.append(panel);

  // The ring's N turns with the view; dragging around the ring turns the view.
  const ring = panel.querySelector<HTMLElement>('.nav-ring')!;
  const north = panel.querySelector<HTMLElement>('.nav-north')!;
  viewer.scene.postRender.addEventListener(() => {
    north.style.transform = `rotate(${-CesiumMath.toDegrees(camera.heading)}deg) translateY(-30px)`;
  });
  north.addEventListener('click', actions.northUp);
  let ringAngle: number | null = null;
  const angleAt = (e: PointerEvent) => {
    const b = ring.getBoundingClientRect();
    return Math.atan2(e.clientX - (b.left + b.width / 2), -(e.clientY - (b.top + b.height / 2)));
  };
  ring.addEventListener('pointerdown', (e) => {
    if ((e.target as HTMLElement).closest('button')) return;
    ring.setPointerCapture(e.pointerId);
    ringAngle = angleAt(e);
  });
  ring.addEventListener('pointermove', (e) => {
    if (ringAngle === null) return;
    const a = angleAt(e);
    // Dragging the ring clockwise turns the view clockwise, like turning a dial.
    turn(-(a - ringAngle), 0);
    ringAngle = a;
    viewer.scene.requestRender();
  });
  ring.addEventListener('pointerup', () => (ringAngle = null));

  const lookSteps: Record<string, () => void> = {
    up: () => tilt(CesiumMath.toRadians(1.5), 0),
    down: () => tilt(-CesiumMath.toRadians(1.5), 0),
    left: () => turn(-CesiumMath.toRadians(2), 0),
    right: () => turn(CesiumMath.toRadians(2), 0),
  };
  const moveSteps: Record<string, () => void> = {
    up: () => pan(viewer, 1, 0, 0.03),
    down: () => pan(viewer, -1, 0, 0.03),
    left: () => pan(viewer, 0, -1, 0.03),
    right: () => pan(viewer, 0, 1, 0.03),
  };
  panel.querySelectorAll<HTMLElement>('[data-look]').forEach((b) => holdRepeat(b, lookSteps[b.dataset.look!], viewer));
  panel.querySelectorAll<HTMLElement>('[data-move]').forEach((b) => holdRepeat(b, moveSteps[b.dataset.move!], viewer));
  holdRepeat(panel.querySelector('[data-zoom="in"]')!, () => zoom(viewer, 0.06), viewer);
  holdRepeat(panel.querySelector('[data-zoom="out"]')!, () => zoom(viewer, -0.07), viewer);

  // Zoom slider: hold it above or below the middle to zoom continuously; it springs back.
  const slider = panel.querySelector<HTMLInputElement>('.nav-zoom input')!;
  let zoomTimer = 0;
  slider.addEventListener('pointerdown', () => {
    window.clearInterval(zoomTimer);
    zoomTimer = window.setInterval(() => {
      const v = Number(slider.value) / 100;
      if (v) zoom(viewer, v > 0 ? v * 0.08 : v * 0.09);
      viewer.scene.requestRender();
    }, 40);
  });
  const release = () => {
    window.clearInterval(zoomTimer);
    slider.value = '0';
  };
  slider.addEventListener('pointerup', release);
  slider.addEventListener('pointercancel', release);
  slider.addEventListener('change', release);

  panel.querySelector('.nav-tilt')!.addEventListener('click', toggleTopDown);

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
    // Google Earth's keys: N north, U look straight down, R reset both. T toggles tilt.
    else if (k.toLowerCase() === 'n') actions.northUp();
    else if (k.toLowerCase() === 'u') actions.resetTilt();
    else if (k.toLowerCase() === 'r') actions.resetTiltAndNorth();
    else if (k.toLowerCase() === 't') toggleTopDown();
    else return;
    e.preventDefault();
    viewer.scene.requestRender();
  });
  return actions;
}
