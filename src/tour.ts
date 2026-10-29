import {
  Cartesian3,
  Cartographic,
  EllipsoidGeodesic,
  EllipsoidTerrainProvider,
  Math as CesiumMath,
  sampleTerrain,
  type Viewer,
} from 'cesium';
import { isTyping, loadSetting, saveBinaryFile, storeSetting } from './platform';

/** One camera keyframe: seconds from the start, where the camera is and where it looks. */
interface Frame {
  t: number;
  lon: number;
  lat: number;
  height: number;
  heading: number;
  pitch: number;
}

interface Tour {
  id: string;
  name: string;
  frames: Frame[];
}

const STORAGE_KEY = 'tours';
/** Recording samples the camera this often (seconds). */
const SAMPLE_EVERY = 0.1;
/** Fly-along tours: how steeply the camera looks down at the line. */
const FOLLOW_PITCH = CesiumMath.toRadians(-30);
/** Fly-along tours last between these many seconds (about 60 m/s along the line). */
const FOLLOW_MIN_DURATION = 10;
const FOLLOW_MAX_DURATION = 180;

const lerp = (a: number, b: number, s: number) => a + (b - a) * s;
/** Interpolates angles the short way round (e.g. 350° → 10° goes through north). */
const lerpAngle = (a: number, b: number, s: number) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * s;
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

/**
 * Tours, like Google Earth's: record the camera as you fly around, or fly along a path;
 * play them back with a scrubber, speed and loop; save them as video. Tours are listed
 * under My Places.
 */
export class Tours {
  private tours: Tour[] = [];
  private readonly list = document.querySelector<HTMLUListElement>('#tour-list')!;
  private readonly bar = document.createElement('section');
  private recording: { frames: Frame[]; start: number; timer: number } | null = null;
  private current?: Tour;
  private t = 0;
  private playing = false;
  private speed = 1;
  private loop = false;
  /** Set while saving a video; resolves when playback reaches the end. */
  private finished?: () => void;
  /** Called when a recording starts or stops, to update the toolbar button. */
  onRecordingChange?: (recording: boolean) => void;

  constructor(private readonly viewer: Viewer) {
    try {
      this.tours = JSON.parse(loadSetting(STORAGE_KEY) || '[]');
    } catch {
      this.tours = [];
    }
    this.bar.id = 'tour-bar';
    this.bar.hidden = true;
    document.querySelector('#globe')!.append(this.bar);
    this.render();

    // Grabbing the globe pauses playback, as in Google Earth.
    viewer.canvas.addEventListener('pointerdown', () => this.playing && this.pause());
    document.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && this.current && !this.bar.hidden && !isTyping(e)) {
        e.preventDefault();
        if (this.playing) this.pause();
        else this.play();
      }
    });
  }

  get isRecording(): boolean {
    return !!this.recording;
  }

  // ---- Recording

  /** Starts recording the camera; call again (or press Stop) to finish and save. */
  toggleRecording(): void {
    if (this.recording) this.stopRecording();
    else this.startRecording();
  }

  private startRecording(): void {
    this.closePlayer();
    const frames: Frame[] = [];
    const start = performance.now();
    const sample = () => frames.push({ t: (performance.now() - start) / 1000, ...this.cameraFrame() });
    sample();
    this.recording = { frames, start, timer: window.setInterval(sample, SAMPLE_EVERY * 1000) };
    this.bar.hidden = false;
    this.bar.className = 'recording';
    this.bar.innerHTML = '<span class="rec-dot"></span><strong>Recording tour</strong><span class="rec-time">0:00</span>';
    const stop = document.createElement('button');
    stop.textContent = '■ Stop';
    stop.addEventListener('click', () => this.stopRecording());
    this.bar.append(stop);
    const time = this.bar.querySelector<HTMLElement>('.rec-time')!;
    const tick = () => {
      if (!this.recording) return;
      time.textContent = clock((performance.now() - start) / 1000);
      window.setTimeout(tick, 250);
    };
    tick();
    this.onRecordingChange?.(true);
  }

  private stopRecording(): void {
    const rec = this.recording;
    if (!rec) return;
    window.clearInterval(rec.timer);
    rec.frames.push({ t: (performance.now() - rec.start) / 1000, ...this.cameraFrame() });
    this.recording = null;
    this.bar.hidden = true;
    this.onRecordingChange?.(false);
    if (rec.frames[rec.frames.length - 1].t < 1) return;
    const tour = this.add(`Tour ${this.tours.length + 1}`, rec.frames);
    this.open(tour.id);
  }

  private cameraFrame(): Omit<Frame, 't'> {
    const { camera } = this.viewer;
    const c = camera.positionCartographic;
    return {
      lon: CesiumMath.toDegrees(c.longitude),
      lat: CesiumMath.toDegrees(c.latitude),
      height: c.height,
      heading: camera.heading,
      pitch: camera.pitch,
    };
  }

  // ---- Fly along a line

  /**
   * Makes a tour that flies along a line: the camera follows a little behind and above,
   * facing along the route, at a pace that suits the line's length.
   */
  async fromLine(name: string, positions: Cartesian3[]): Promise<void> {
    const points = positions.map((p) => Cartographic.fromCartesian(p));
    const legs = points.slice(1).map((p, i) => new EllipsoidGeodesic(points[i], p));
    const length = legs.reduce((s, g) => s + g.surfaceDistance, 0);
    if (length < 10) return;

    const duration = CesiumMath.clamp(length / 60, FOLLOW_MIN_DURATION, FOLLOW_MAX_DURATION);
    const height = CesiumMath.clamp(length * 0.04, 120, 2500);
    const steps = Math.ceil(duration * 2);
    const at = (d: number) => {
      let leg = 0;
      let start = 0;
      while (leg < legs.length - 1 && d > start + legs[leg].surfaceDistance) {
        start += legs[leg].surfaceDistance;
        leg++;
      }
      const g = legs[leg];
      return g.interpolateUsingFraction(g.surfaceDistance ? Math.min(1, (d - start) / g.surfaceDistance) : 0);
    };
    const targets = Array.from({ length: steps + 1 }, (_, i) => at((length * i) / steps));

    // Ground heights along the way, so the camera stays above hills.
    let ground = targets.map(() => 0);
    if (!(this.viewer.terrainProvider instanceof EllipsoidTerrainProvider)) {
      const sampled = await sampleTerrain(this.viewer.terrainProvider, 12, targets.map((c) => c.clone())).catch(() => null);
      if (sampled) ground = sampled.map((c) => c.height ?? 0);
    }

    const back = height / Math.tan(-FOLLOW_PITCH);
    const frames: Frame[] = targets.map((target, i) => {
      // Face the point a little way ahead (smooths out tiny wiggles in the line).
      const ahead = targets[Math.min(steps, i + 3)];
      const behind = targets[Math.max(0, i - 3)];
      const heading = new EllipsoidGeodesic(i + 3 <= steps ? target : behind, i + 3 <= steps ? ahead : target).startHeading;
      // Stand `back` metres behind the target, looking at it.
      const lat = target.latitude - (back * Math.cos(heading)) / 6371000;
      const lon = target.longitude - (back * Math.sin(heading)) / (6371000 * Math.cos(target.latitude));
      return {
        t: (duration * i) / steps,
        lon: CesiumMath.toDegrees(lon),
        lat: CesiumMath.toDegrees(lat),
        height: Math.max(...ground.slice(Math.max(0, i - 4), i + 5)) + height,
        heading,
        pitch: FOLLOW_PITCH,
      };
    });
    const tour = this.add(`Fly along ${name}`, frames);
    this.open(tour.id);
    this.play();
  }

  // ---- Library

  private add(name: string, frames: Frame[]): Tour {
    const tour: Tour = { id: crypto.randomUUID(), name, frames };
    this.tours.push(tour);
    this.persist();
    this.render();
    return tour;
  }

  private persist(): void {
    storeSetting(STORAGE_KEY, JSON.stringify(this.tours));
  }

  private render(): void {
    this.list.innerHTML = '';
    for (const tour of this.tours) {
      const li = document.createElement('li');
      const icon = document.createElement('span');
      icon.className = 'kind-icon';
      icon.textContent = '🎬';
      const name = document.createElement('span');
      name.className = 'tree-name';
      name.textContent = tour.name;
      name.title = `${clock(tour.frames[tour.frames.length - 1].t)} · double-click to rename`;
      name.addEventListener('dblclick', () => {
        const input = document.createElement('input');
        input.type = 'text';
        input.value = tour.name;
        name.replaceWith(input);
        input.select();
        const done = () => {
          tour.name = input.value.trim() || tour.name;
          this.persist();
          this.render();
        };
        input.addEventListener('blur', done);
        input.addEventListener('keydown', (e) => e.key === 'Enter' && input.blur());
      });
      const play = document.createElement('button');
      play.textContent = '▶';
      play.title = 'Play tour';
      play.addEventListener('click', () => {
        this.open(tour.id);
        this.play();
      });
      const remove = document.createElement('button');
      remove.textContent = '×';
      remove.title = 'Delete tour';
      remove.addEventListener('click', () => {
        if (this.current?.id === tour.id) this.closePlayer();
        this.tours = this.tours.filter((x) => x.id !== tour.id);
        this.persist();
        this.render();
      });
      li.append(icon, name, play, remove);
      this.list.append(li);
    }
  }

  // ---- Player

  private get duration(): number {
    const f = this.current?.frames;
    return f?.length ? f[f.length - 1].t : 0;
  }

  /** Shows the player for a tour, at its start. */
  open(id: string): void {
    const tour = this.tours.find((x) => x.id === id);
    if (!tour) return;
    this.pause();
    this.current = tour;
    this.t = 0;
    this.bar.hidden = false;
    this.bar.className = 'player';
    this.bar.innerHTML = `
      <button class="tour-play" title="Play / pause (Space)">▶</button>
      <strong class="tour-name"></strong>
      <input class="tour-scrub" type="range" min="0" step="0.01" aria-label="Tour position" />
      <span class="tour-time"></span>
      <select class="tour-speed" title="Playback speed">
        <option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="2">2×</option><option value="4">4×</option>
      </select>
      <label class="check" title="Play again from the start"><input class="tour-loop" type="checkbox" /> Loop</label>
      <button class="tour-video" title="Save this tour as a video">🎞 Save video…</button>
      <button class="tour-close" title="Close the tour">×</button>`;
    this.bar.querySelector<HTMLElement>('.tour-name')!.textContent = tour.name;
    const scrub = this.bar.querySelector<HTMLInputElement>('.tour-scrub')!;
    scrub.max = String(this.duration);
    scrub.addEventListener('input', () => {
      this.t = Number(scrub.value);
      this.apply();
    });
    this.bar.querySelector('.tour-play')!.addEventListener('click', () => (this.playing ? this.pause() : this.play()));
    this.bar.querySelector<HTMLSelectElement>('.tour-speed')!.addEventListener('change', (e) => {
      this.speed = Number((e.target as HTMLSelectElement).value);
    });
    this.bar.querySelector<HTMLInputElement>('.tour-loop')!.addEventListener('change', (e) => {
      this.loop = (e.target as HTMLInputElement).checked;
    });
    this.bar.querySelector('.tour-video')!.addEventListener('click', () => void this.saveVideo());
    this.bar.querySelector('.tour-close')!.addEventListener('click', () => this.closePlayer());
    this.apply();
  }

  play(): void {
    if (!this.current) return;
    if (this.t >= this.duration) this.t = 0;
    this.playing = true;
    this.updateButton();
    let last = performance.now();
    const frame = (now: number) => {
      if (!this.playing) return;
      this.t += ((now - last) / 1000) * this.speed;
      last = now;
      if (this.t >= this.duration) {
        if (this.loop && !this.finished) this.t = 0;
        else {
          this.t = this.duration;
          this.apply();
          this.pause();
          this.finished?.();
          return;
        }
      }
      this.apply();
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  pause(): void {
    this.playing = false;
    this.updateButton();
  }

  closePlayer(): void {
    this.pause();
    this.current = undefined;
    if (!this.recording) this.bar.hidden = true;
  }

  private updateButton(): void {
    const b = this.bar.querySelector('.tour-play');
    if (b) b.textContent = this.playing ? '❚❚' : '▶';
  }

  /** Puts the camera where the tour is at time `t`. */
  private apply(): void {
    const frames = this.current!.frames;
    let i = 0;
    while (i < frames.length - 2 && frames[i + 1].t < this.t) i++;
    const a = frames[i];
    const b = frames[Math.min(i + 1, frames.length - 1)];
    const s = b.t > a.t ? CesiumMath.clamp((this.t - a.t) / (b.t - a.t), 0, 1) : 0;
    this.viewer.camera.setView({
      destination: Cartesian3.fromDegrees(
        lerp(a.lon, b.lon, s),
        lerp(a.lat, b.lat, s),
        // Height changes are smoother in proportion than in metres.
        Math.exp(lerp(Math.log(Math.max(a.height, 1)), Math.log(Math.max(b.height, 1)), s)),
      ),
      orientation: { heading: lerpAngle(a.heading, b.heading, s), pitch: lerp(a.pitch, b.pitch, s), roll: 0 },
    });
    this.viewer.scene.requestRender();
    const scrub = this.bar.querySelector<HTMLInputElement>('.tour-scrub');
    if (scrub && document.activeElement !== scrub) scrub.value = String(this.t);
    const time = this.bar.querySelector('.tour-time');
    if (time) time.textContent = `${clock(this.t)} / ${clock(this.duration)}`;
  }

  // ---- Video

  /**
   * Plays the tour from the start at normal speed while recording the globe, then saves
   * the video (MP4 where the system supports it, otherwise WebM).
   */
  async saveVideo(): Promise<void> {
    if (!this.current || typeof MediaRecorder === 'undefined') return;
    const type = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'].find((t) =>
      MediaRecorder.isTypeSupported(t),
    );
    if (!type) return;
    const button = this.bar.querySelector<HTMLButtonElement>('.tour-video')!;
    button.disabled = true;
    button.textContent = '● Recording video…';

    const stream = this.viewer.canvas.captureStream(30);
    const recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 12_000_000 });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const stopped = new Promise<void>((resolve) => (recorder.onstop = () => resolve()));

    this.pause();
    this.t = 0;
    this.apply();
    const speed = this.speed;
    this.speed = 1;
    recorder.start(1000);
    await new Promise<void>((resolve) => {
      this.finished = resolve;
      this.play();
    });
    this.finished = undefined;
    this.speed = speed;
    recorder.stop();
    await stopped;
    stream.getTracks().forEach((track) => track.stop());

    const ext = type.startsWith('video/mp4') ? 'mp4' : 'webm';
    await saveBinaryFile(`${this.current?.name ?? 'Tour'}.${ext}`, new Blob(chunks, { type: type.split(';')[0] }), ext);
    button.disabled = false;
    button.textContent = '🎞 Save video…';
  }
}
