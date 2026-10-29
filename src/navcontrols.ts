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

/** Keeps pointer events coming to `el` while the button is held (ignored if the pointer is gone). */
function capture(el: HTMLElement, e: PointerEvent): void {
  try {
    el.setPointerCapture(e.pointerId);
  } catch {
    // The pointer already went away; the move/up handlers still end the drag.
  }
}

/**
 * Google Earth–style joystick: press anywhere inside `el` and drag. While held, `step`
 * runs repeatedly with the knob's offset from the centre (x right, y down, each −1…1).
 * Arrow buttons inside keep working as plain buttons.
 */
function joystick(el: HTMLElement, step: (x: number, y: number) => void, viewer: Viewer): void {
  const knob = el.querySelector<HTMLElement>('.nav-knob')!;
  let offset: [number, number] | null = null;
  let timer = 0;
  const setOffset = (e: PointerEvent) => {
    const b = el.getBoundingClientRect();
    const r = b.width / 2;
    let x = (e.clientX - (b.left + r)) / r;
    let y = (e.clientY - (b.top + r)) / r;
    const len = Math.hypot(x, y);
    if (len > 1) [x, y] = [x / len, y / len];
    offset = [x, y];
    knob.style.transform = `translate(calc(-50% + ${x * r * 0.55}px), calc(-50% + ${y * r * 0.55}px))`;
  };
  const release = () => {
    offset = null;
    window.clearInterval(timer);
    el.classList.remove('held');
    knob.style.transform = '';
  };
  el.addEventListener('pointerdown', (e) => {
    if ((e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    e.stopPropagation();
    capture(el, e);
    el.classList.add('held');
    setOffset(e);
    timer = window.setInterval(() => {
      // A small dead zone in the middle, so a plain press doesn't drift.
      if (!offset || Math.hypot(...offset) < 0.12) return;
      step(offset[0], offset[1]);
      viewer.scene.requestRender();
    }, 40);
  });
  el.addEventListener('pointermove', (e) => {
    if (offset) setOffset(e);
  });
  el.addEventListener('pointerup', release);
  el.addEventListener('pointercancel', release);
  el.addEventListener('lostpointercapture', release);
}

/**
 * Vertical spring-back slider: drag the thumb up or down; while held, `step` runs with
 * the thumb's offset (−1 at the bottom … 1 at the top). Letting go returns it to the middle.
 */
function springSlider(track: HTMLElement, thumb: HTMLElement, step: (v: number) => void, viewer: Viewer): void {
  let value: number | null = null;
  let timer = 0;
  const set = (e: PointerEvent) => {
    const b = track.getBoundingClientRect();
    value = Math.max(-1, Math.min(1, ((b.top + b.height / 2 - e.clientY) / b.height) * 2));
    thumb.style.transform = `translate(-50%, calc(-50% - ${value * (b.height / 2 - 8)}px))`;
  };
  const release = () => {
    value = null;
    window.clearInterval(timer);
    track.classList.remove('held');
    thumb.style.transform = '';
  };
  track.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    capture(track, e);
    track.classList.add('held');
    set(e);
    timer = window.setInterval(() => {
      if (value && Math.abs(value) > 0.08) {
        step(value);
        viewer.scene.requestRender();
      }
    }, 40);
  });
  track.addEventListener('pointermove', (e) => {
    if (value !== null) set(e);
  });
  track.addEventListener('pointerup', release);
  track.addEventListener('pointercancel', release);
  track.addEventListener('lostpointercapture', release);
}

/** While a button is held, run `step` repeatedly (first right away). */
function holdRepeat(button: HTMLElement, step: () => void, viewer: Viewer): void {
  let timer = 0;
  const stop = () => window.clearInterval(timer);
  button.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    capture(button, e);
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

export function setupNavControls(viewer: Viewer, keysEnabled: () => boolean, onHome: () => void): NavActions {
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

  // Google Earth–style cluster, top right: look ring, move joystick, (person), zoom slider,
  // then Home and top-down. Both round controls are joysticks: press and drag inside.
  const chevron = (dir: string) =>
    `<svg viewBox="0 0 12 12" class="chev ${dir}"><path d="M3 7.5 6 4.5 9 7.5" /></svg>`;
  const arrows = (kind: 'look' | 'move') =>
    (['up', 'down', 'left', 'right'] as const)
      .map((d) => `<button class="nav-arrow ${d}" data-${kind}="${d}" aria-label="${kind} ${d}">${chevron(d)}</button>`)
      .join('');
  const panel = document.createElement('div');
  panel.id = 'nav-controls';
  panel.innerHTML = `
    <div class="nav-ring" title="Drag the ring to turn · click N to face north (N)">
      <button class="nav-north" aria-label="Face north">N</button>
      <div class="nav-stick" data-stick="look" title="Look around: press and drag (Shift+arrows)">
        ${arrows('look')}
        <span class="nav-knob"><svg viewBox="0 0 24 24"><path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6S2 12 2 12z" /><circle cx="12" cy="12" r="2.6" /></svg></span>
      </div>
    </div>
    <div class="nav-stick nav-move" data-stick="move" title="Move: press and drag (arrow keys)">
      ${arrows('move')}
      <span class="nav-knob"><svg viewBox="0 0 24 24"><path d="M12 3v18M3 12h18M12 3l-2.5 2.5M12 3l2.5 2.5M12 21l-2.5-2.5M12 21l2.5-2.5M3 12l2.5-2.5M3 12l2.5 2.5M21 12l-2.5-2.5M21 12l-2.5 2.5" /></svg></span>
    </div>
    <div class="nav-zoom">
      <button data-zoom="in" title="Zoom in (+)" aria-label="Zoom in">+</button>
      <div class="nav-track" title="Drag up to zoom in, down to zoom out; it springs back">
        <span class="nav-thumb"></span>
      </div>
      <button data-zoom="out" title="Zoom out (−)" aria-label="Zoom out">−</button>
    </div>
    <div class="nav-small">
      <button class="nav-home" title="Home: your start location, or the whole Earth" aria-label="Home">
        <svg viewBox="0 0 24 24"><path d="M4 11 12 4l8 7M6.5 9.5V20h11V9.5" /></svg>
      </button>
      <button class="nav-tilt" title="Switch between top-down and tilted (U resets tilt)" aria-label="Top-down or tilted">
        <svg viewBox="0 0 24 24"><path d="M4 18h16M7 18l3-12M17 18 14 6" /></svg>
      </button>
    </div>`;
  viewer.container.append(panel);

  // The ring's N turns with the view; dragging around the ring turns the view.
  const ring = panel.querySelector<HTMLElement>('.nav-ring')!;
  const north = panel.querySelector<HTMLElement>('.nav-north')!;
  viewer.scene.postRender.addEventListener(() => {
    north.style.transform = `rotate(${-CesiumMath.toDegrees(camera.heading)}deg) translateY(-33px)`;
  });
  // Drag the rim (or the N itself) to turn; a plain click on the N faces north.
  let ringAngle: number | null = null;
  let ringTurned = 0;
  let pressedNorth = false;
  const angleAt = (e: PointerEvent) => {
    const b = ring.getBoundingClientRect();
    return Math.atan2(e.clientX - (b.left + b.width / 2), -(e.clientY - (b.top + b.height / 2)));
  };
  ring.addEventListener('pointerdown', (e) => {
    const target = e.target as HTMLElement;
    if (target.closest('.nav-stick')) return;
    capture(ring, e);
    ring.classList.add('turning');
    ringAngle = angleAt(e);
    ringTurned = 0;
    pressedNorth = !!target.closest('.nav-north');
  });
  ring.addEventListener('pointermove', (e) => {
    if (ringAngle === null) return;
    const a = angleAt(e);
    // Unwrap across ±180° so a drag past the bottom doesn't spin the view.
    const delta = Math.atan2(Math.sin(a - ringAngle), Math.cos(a - ringAngle));
    // Dragging the ring clockwise turns the view clockwise, like turning a dial.
    turn(-delta, 0);
    ringTurned += Math.abs(delta);
    ringAngle = a;
    viewer.scene.requestRender();
  });
  const ringUp = () => {
    if (ringAngle !== null && pressedNorth && ringTurned < 0.05) actions.northUp();
    ringAngle = null;
    pressedNorth = false;
    ring.classList.remove('turning');
  };
  ring.addEventListener('pointerup', ringUp);
  ring.addEventListener('pointercancel', ringUp);

  // Arrow buttons: hold to repeat.
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

  // Joysticks: press anywhere inside and drag; speed grows with distance from the centre.
  joystick(panel.querySelector('[data-stick="look"]')!, (x, y) => {
    if (x) turn(CesiumMath.toRadians(3 * x), 0);
    if (y) tilt(CesiumMath.toRadians(-2 * y), 0);
  }, viewer);
  // Up on the stick is forward; the further out, the faster.
  joystick(panel.querySelector('[data-stick="move"]')!, (x, y) => pan(viewer, -y, x, 0.04), viewer);

  // Zoom slider: drag the thumb up to zoom in, down to zoom out; it springs back.
  const track = panel.querySelector<HTMLElement>('.nav-track')!;
  const thumb = panel.querySelector<HTMLElement>('.nav-thumb')!;
  springSlider(track, thumb, (v) => zoom(viewer, v > 0 ? v * 0.08 : v * 0.09), viewer);

  panel.querySelector('.nav-home')!.addEventListener('click', () => onHome());
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
