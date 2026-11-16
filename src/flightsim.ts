import { Cartesian3, Cartographic, Math as CesiumMath, type Viewer } from 'cesium';
import { isTyping } from './platform';

/** A simple, forgiving flight model: enough to fly around and land, not a trainer. */
interface Aircraft {
  name: string;
  /** Cruise and top speed (m/s). Drag is set so full throttle settles at top speed. */
  cruise: number;
  top: number;
  /** Below this (m/s) the wings stop lifting and the nose drops. */
  stall: number;
  /** Full-throttle acceleration from rest (m/s²). */
  thrust: number;
  /** Degrees per second at full stick. */
  rollRate: number;
  pitchRate: number;
  /** Starting height above the ground (m). */
  startHeight: number;
}

export const AIRCRAFT: Record<'light' | 'jet', Aircraft> = {
  light: { name: 'Light aircraft', cruise: 62, top: 85, stall: 27, thrust: 3.2, rollRate: 55, pitchRate: 22, startHeight: 450 },
  jet: { name: 'Fighter jet', cruise: 230, top: 620, stall: 75, thrust: 18, rollRate: 160, pitchRate: 38, startHeight: 1200 },
};

const G = 9.81;
const R = 6_371_000;
const KNOTS = 1.943_844;
const FEET = 3.280_84;
const MAX_ROLL = CesiumMath.toRadians(80);
const MAX_PITCH = CesiumMath.toRadians(60);

interface State {
  lon: number;
  lat: number;
  height: number;
  heading: number;
  pitch: number;
  roll: number;
  speed: number;
  throttle: number;
  verticalSpeed: number;
  onGround: boolean;
}

/**
 * Google Earth style flight simulator: the camera becomes the cockpit, arrows fly the
 * plane, Page Up/Down set the throttle, with a head-up display over the globe. Entered
 * from Tools › Enter Flight Simulator; Esc leaves.
 */
export class FlightSimulator {
  active = false;
  private plane: Aircraft = AIRCRAFT.light;
  private state!: State;
  private start!: State;
  private keys = new Set<string>();
  private frame = 0;
  private last = 0;
  private paused = false;
  private crashed = false;
  private readonly hud: HTMLCanvasElement;
  private readonly message: HTMLElement;
  private readonly picker: HTMLDialogElement;

  constructor(
    private readonly viewer: Viewer,
    /** Tells the rest of the app (toolbar, nav controls) the simulator started or stopped. */
    private readonly onChange: (active: boolean) => void,
  ) {
    const globe = document.querySelector('#globe')!;
    this.hud = document.createElement('canvas');
    this.hud.id = 'flight-hud';
    this.hud.hidden = true;
    this.message = document.createElement('div');
    this.message.id = 'flight-message';
    this.message.hidden = true;
    globe.append(this.hud, this.message);

    this.picker = document.createElement('dialog');
    this.picker.id = 'flight-dialog';
    this.picker.innerHTML = `
      <form method="dialog">
        <h2>Flight Simulator</h2>
        <p class="hint">You'll take off from where you're looking, heading the way the view faces.</p>
        <label class="choice"><input type="radio" name="plane" value="light" checked /> ${AIRCRAFT.light.name} <span class="hint">slow and steady, easy to land</span></label>
        <label class="choice"><input type="radio" name="plane" value="jet" /> ${AIRCRAFT.jet.name} <span class="hint">fast, rolls quickly</span></label>
        <div class="keys">
          <div><kbd>↑</kbd><kbd>↓</kbd> nose down / up</div>
          <div><kbd>←</kbd><kbd>→</kbd> roll (bank to turn)</div>
          <div><kbd>Page Up</kbd><kbd>Page Down</kbd> or <kbd>W</kbd><kbd>S</kbd> throttle</div>
          <div><kbd>Space</kbd> pause · <kbd>Esc</kbd> exit</div>
        </div>
        <div class="row end">
          <button value="cancel">Cancel</button>
          <button value="fly" class="primary">Start Flying</button>
        </div>
      </form>`;
    document.body.append(this.picker);
    this.picker.addEventListener('close', () => {
      if (this.picker.returnValue !== 'fly') return;
      const choice = this.picker.querySelector<HTMLInputElement>('input[name="plane"]:checked')!.value;
      this.begin(AIRCRAFT[choice as 'light' | 'jet']);
    });

    document.addEventListener('keydown', (e) => this.key(e, true), true);
    document.addEventListener('keyup', (e) => this.key(e, false), true);
    window.addEventListener('blur', () => this.keys.clear());
    window.addEventListener('resize', () => this.active && this.drawHud());
  }

  /** Shows the aircraft picker, or leaves the simulator if it's running. */
  toggle(): void {
    if (this.active) this.stop();
    else this.picker.showModal();
  }

  private begin(plane: Aircraft): void {
    this.plane = plane;
    const { camera, scene } = this.viewer;
    const here = camera.positionCartographic;
    const ground = scene.globe.getHeight(here) ?? 0;
    const height = ground + Math.min(Math.max(here.height - ground, plane.startHeight), plane === AIRCRAFT.jet ? 9000 : 3000);
    this.start = {
      lon: here.longitude,
      lat: here.latitude,
      height,
      heading: camera.heading,
      pitch: 0,
      roll: 0,
      speed: plane.cruise,
      throttle: 0.65,
      verticalSpeed: 0,
      onGround: false,
    };
    this.state = { ...this.start };
    this.active = true;
    this.crashed = false;
    this.paused = false;
    this.keys.clear();
    this.viewer.scene.screenSpaceCameraController.enableInputs = false;
    this.hud.hidden = false;
    this.showMessage('');
    this.onChange(true);
    this.last = performance.now();
    this.frame = requestAnimationFrame((t) => this.tick(t));
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    cancelAnimationFrame(this.frame);
    this.viewer.scene.screenSpaceCameraController.enableInputs = true;
    this.hud.hidden = true;
    this.showMessage('');
    this.keys.clear();
    // Level the view out so the normal controls start from a sensible camera.
    const { camera } = this.viewer;
    camera.setView({
      destination: camera.position.clone(),
      orientation: { heading: camera.heading, pitch: CesiumMath.toRadians(-20), roll: 0 },
    });
    this.viewer.scene.requestRender();
    this.onChange(false);
  }

  private key(e: KeyboardEvent, down: boolean): void {
    if (!this.active || isTyping(e) || e.metaKey || e.ctrlKey) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (down && k === 'Escape') this.stop();
    else if (down && k === ' ') {
      if (this.crashed) this.restart();
      else this.paused = !this.paused;
      this.showMessage(this.paused ? 'Paused. Press Space to continue.' : '');
    } else if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'w', 's'].includes(k)) {
      if (down) this.keys.add(k);
      else this.keys.delete(k);
    } else return;
    // The simulator owns these keys while flying: keep them from the map controls.
    e.preventDefault();
    e.stopPropagation();
  }

  private restart(): void {
    this.state = { ...this.start };
    this.crashed = false;
    this.paused = false;
    this.showMessage('');
  }

  private showMessage(text: string): void {
    this.message.textContent = text;
    this.message.hidden = !text;
  }

  private tick(now: number): void {
    if (!this.active) return;
    // Clamp the step so a stalled frame (window hidden) doesn't fling the plane.
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    if (!this.paused && !this.crashed) this.step(dt);
    this.place();
    this.drawHud();
    this.frame = requestAnimationFrame((t) => this.tick(t));
  }

  private step(dt: number): void {
    const s = this.state;
    const p = this.plane;
    const held = (k: string) => this.keys.has(k);

    if (held('PageUp') || held('w')) s.throttle = Math.min(1, s.throttle + 0.4 * dt);
    if (held('PageDown') || held('s')) s.throttle = Math.max(0, s.throttle - 0.4 * dt);

    const rollInput = (held('ArrowRight') ? 1 : 0) - (held('ArrowLeft') ? 1 : 0);
    // Like a real stick: pull back (down arrow) for nose up.
    const pitchInput = (held('ArrowDown') ? 1 : 0) - (held('ArrowUp') ? 1 : 0);

    if (!s.onGround) {
      s.roll = clamp(s.roll + rollInput * CesiumMath.toRadians(p.rollRate) * dt, -MAX_ROLL, MAX_ROLL);
      // With no stick, the wings slowly level themselves.
      if (!rollInput) s.roll *= Math.max(0, 1 - 0.25 * dt);
    }
    s.pitch = clamp(s.pitch + pitchInput * CesiumMath.toRadians(p.pitchRate) * Math.cos(s.roll) * dt, -MAX_PITCH, MAX_PITCH);

    // Speed: thrust against drag (top speed at full throttle) and gravity along the path.
    const drag = (p.thrust / (p.top * p.top)) * s.speed * s.speed;
    s.speed = Math.max(0, s.speed + (s.throttle * p.thrust - drag - G * Math.sin(s.pitch)) * dt);

    if (!s.onGround) {
      // Banking turns the plane; slower means tighter.
      s.heading = CesiumMath.zeroToTwoPi(s.heading + ((G * Math.tan(s.roll)) / Math.max(s.speed, 10)) * dt);
      // Too slow to fly: the nose falls.
      if (s.speed < p.stall) s.pitch -= ((p.stall - s.speed) / p.stall) * CesiumMath.toRadians(35) * dt;
    }

    const ground = this.viewer.scene.globe.getHeight(Cartographic.fromRadians(s.lon, s.lat)) ?? Number.NEGATIVE_INFINITY;
    let climb = s.speed * Math.sin(s.pitch);
    if (s.onGround) {
      // Rolling on the ground: wheels brake gently; lift-off once fast enough with the nose up.
      s.speed = Math.max(0, s.speed - (s.throttle < 0.05 ? 2.5 : 0.4) * dt);
      if (s.pitch > 0 && s.speed > p.stall * 1.1) s.onGround = false;
      else {
        s.pitch = Math.max(0, s.pitch);
        climb = 0;
      }
    }

    const along = s.speed * Math.cos(s.pitch) * dt;
    s.lat += (along * Math.cos(s.heading)) / R;
    s.lon += (along * Math.sin(s.heading)) / (R * Math.cos(s.lat));
    s.height += climb * dt;
    s.verticalSpeed = climb;

    if (s.height <= ground + 1) {
      const gentle = climb > -4 && Math.abs(s.roll) < CesiumMath.toRadians(15) && s.pitch > CesiumMath.toRadians(-6);
      s.height = ground + 1;
      if (s.onGround || gentle) {
        s.onGround = true;
        s.roll = 0;
        s.pitch = Math.max(0, s.pitch);
      } else {
        this.crashed = true;
        this.showMessage('You crashed. Press Space to try again, or Esc to leave the simulator.');
      }
    }
  }

  /** Puts the camera in the cockpit. */
  private place(): void {
    const s = this.state;
    this.viewer.camera.setView({
      destination: Cartesian3.fromRadians(s.lon, s.lat, s.height + 2),
      orientation: { heading: s.heading, pitch: s.pitch, roll: s.roll },
    });
    this.viewer.scene.requestRender();
  }

  // ---- Head-up display

  private drawHud(): void {
    const dpr = window.devicePixelRatio || 1;
    const { clientWidth: w, clientHeight: h } = this.hud;
    if (this.hud.width !== Math.round(w * dpr) || this.hud.height !== Math.round(h * dpr)) {
      this.hud.width = Math.round(w * dpr);
      this.hud.height = Math.round(h * dpr);
    }
    const ctx = this.hud.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const s = this.state;
    const cx = w / 2;
    const cy = h / 2;
    const green = '#5dff8a';
    ctx.strokeStyle = green;
    ctx.fillStyle = green;
    ctx.lineWidth = 1.5;
    ctx.font = '600 13px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.shadowColor = 'rgba(0,0,0,0.7)';
    ctx.shadowBlur = 3;

    // Pitch ladder, turning with the roll. The camera's field of view sets the scale.
    const fov = (this.viewer.camera.frustum as { fovy?: number }).fovy ?? CesiumMath.toRadians(60);
    const pxPerRad = h / fov;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-s.roll);
    for (let deg = -60; deg <= 60; deg += 10) {
      const y = (s.pitch - CesiumMath.toRadians(deg)) * pxPerRad;
      if (Math.abs(y) > h * 0.38) continue;
      const half = deg === 0 ? w * 0.22 : 46;
      ctx.beginPath();
      if (deg < 0) ctx.setLineDash([6, 5]);
      ctx.moveTo(-half, y);
      ctx.lineTo(-18, y);
      ctx.moveTo(18, y);
      ctx.lineTo(half, y);
      ctx.stroke();
      ctx.setLineDash([]);
      if (deg) {
        ctx.textAlign = 'left';
        ctx.fillText(String(deg), half + 6, y + 4);
      }
    }
    ctx.restore();

    // Aircraft reference mark.
    ctx.beginPath();
    ctx.moveTo(cx - 34, cy);
    ctx.lineTo(cx - 12, cy);
    ctx.lineTo(cx, cy + 9);
    ctx.lineTo(cx + 12, cy);
    ctx.lineTo(cx + 34, cy);
    ctx.stroke();

    // Speed on the left, altitude on the right, heading at the top.
    const box = (x: number, label: string, value: string, align: CanvasTextAlign) => {
      ctx.textAlign = align;
      ctx.font = '600 11px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillText(label, x, cy - 26);
      ctx.font = '700 20px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillText(value, x, cy + 7);
    };
    box(cx - w * 0.3, 'SPEED KT', Math.round(s.speed * KNOTS).toString(), 'right');
    box(cx + w * 0.3, 'ALT FT', Math.round(s.height * FEET).toLocaleString(), 'left');
    ctx.font = '600 12px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`VS ${Math.round(s.verticalSpeed * FEET * 60).toLocaleString()} FPM`, cx + w * 0.3, cy + 30);
    ctx.textAlign = 'right';
    ctx.fillText(`THR ${Math.round(s.throttle * 100)}%`, cx - w * 0.3, cy + 30);

    const heading = CesiumMath.toDegrees(s.heading);
    ctx.textAlign = 'center';
    ctx.font = '700 16px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillText(String(Math.round(heading) % 360).padStart(3, '0'), cx, 46);
    ctx.font = '600 11px ui-monospace, SFMono-Regular, Menlo, monospace';
    for (let d = -40; d <= 40; d += 10) {
      const mark = Math.round(heading / 10) * 10 + d;
      const x = cx + (mark - heading) * 4;
      if (Math.abs(x - cx) > 170) continue;
      ctx.beginPath();
      ctx.moveTo(x, 58);
      ctx.lineTo(x, 66);
      ctx.stroke();
      const name = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' }[((mark % 360) + 360) % 360];
      ctx.fillText(name ?? String((((mark % 360) + 360) % 360) / 10), x, 80);
    }

    if (s.onGround) {
      ctx.textAlign = 'center';
      ctx.fillText(s.speed < 1 ? 'ON THE GROUND · W for throttle, ↓ to lift off' : 'ROLLING', cx, h - 70);
    } else if (s.speed < this.plane.stall) {
      ctx.fillStyle = '#ff6b5d';
      ctx.textAlign = 'center';
      ctx.font = '700 15px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillText('STALL', cx, cy + 70);
    }
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.font = '12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('↑↓ pitch · ←→ roll · Page Up/Down or W/S throttle · Space pause · Esc exit', cx, h - 24);
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
