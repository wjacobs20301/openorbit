import type { Viewer } from 'cesium';
import { ArrayBufferTarget, Muxer } from 'mp4-muxer';
import { saveBinaryFile } from './platform';
import type { Tours } from './tour';

const RESOLUTIONS = [
  { label: '720p (1280 × 720)', width: 1280, height: 720 },
  { label: '1080p (1920 × 1080)', width: 1920, height: 1080 },
  { label: '1440p (2560 × 1440)', width: 2560, height: 1440 },
  { label: '4K (3840 × 2160)', width: 3840, height: 2160 },
];
const FRAME_RATES = [24, 30, 60];
/** Bits per pixel per frame for H.264: standard and high quality. */
const QUALITY = { standard: 0.08, high: 0.2 };
/** Longest wait for map detail on one frame before moving on regardless (ms). */
const DETAIL_TIMEOUT = 8000;

/** Whether this system can encode H.264 frame by frame (WebCodecs). */
async function encoderFor(width: number, height: number, fps: number, bitrate: number): Promise<VideoEncoderConfig | null> {
  if (typeof VideoEncoder === 'undefined') return null;
  // High profile, then Main, then Baseline; level 5.2 covers 4K at 60 fps.
  for (const codec of ['avc1.640034', 'avc1.4d0034', 'avc1.42003e']) {
    const config: VideoEncoderConfig = { codec, width, height, bitrate, framerate: fps, avc: { format: 'avc' } };
    try {
      if ((await VideoEncoder.isConfigSupported(config)).supported) return config;
    } catch {
      // Try the next profile.
    }
  }
  return null;
}

/**
 * Movie Maker: renders a tour frame by frame at a fixed resolution and frame rate, waiting
 * for the map to finish loading on each frame, and saves an H.264 MP4. Rendering off the
 * clock means the result is smooth however slow the computer or connection. Systems
 * without WebCodecs fall back to recording the tour in real time.
 */
export class MovieMaker {
  private readonly dialog: HTMLDialogElement;
  private cancelled = false;
  private running = false;

  constructor(
    private readonly viewer: Viewer,
    private readonly tours: Tours,
  ) {
    this.dialog = document.createElement('dialog');
    this.dialog.id = 'movie-dialog';
    this.dialog.innerHTML = `
      <div class="dialog-head"><h2>Movie Maker</h2><button class="close" aria-label="Close">×</button></div>
      <p class="hint">Records a tour as a video, frame by frame, so it plays smoothly at full detail.</p>
      <label class="field">Tour <select class="tour"></select></label>
      <label class="field">Resolution
        <select class="resolution">${RESOLUTIONS.map((r, i) => `<option value="${i}" ${i === 1 ? 'selected' : ''}>${r.label}</option>`).join('')}</select>
      </label>
      <label class="field">Frame rate
        <select class="fps">${FRAME_RATES.map((f) => `<option value="${f}" ${f === 30 ? 'selected' : ''}>${f} frames per second</option>`).join('')}</select>
      </label>
      <label class="field">Quality
        <select class="quality"><option value="standard">Standard (smaller file)</option><option value="high" selected>High</option></select>
      </label>
      <label class="check"><input class="detail" type="checkbox" checked /> Wait for full map detail on every frame (slower, sharper)</label>
      <div class="movie-progress" hidden><progress max="1" value="0"></progress><span class="hint status"></span></div>
      <div class="row end">
        <button class="cancel">Cancel</button>
        <button class="start primary">Create Movie</button>
      </div>`;
    document.body.append(this.dialog);
    const close = () => {
      if (this.running) this.cancelled = true;
      else this.dialog.close();
    };
    this.dialog.querySelector('.close')!.addEventListener('click', close);
    this.dialog.querySelector('.cancel')!.addEventListener('click', close);
    this.dialog.addEventListener('cancel', (e) => {
      e.preventDefault();
      close();
    });
    this.dialog.querySelector('.start')!.addEventListener('click', () => void this.create());
  }

  /** Opens the dialog, with `id` (or the tour in the player) selected. */
  show(id?: string): void {
    const select = this.dialog.querySelector<HTMLSelectElement>('.tour')!;
    const all = this.tours.all.filter((t) => t.duration > 0);
    select.innerHTML = all.length
      ? all.map((t) => `<option value="${t.id}">${escape(t.name)} (${Math.round(t.duration)} s)</option>`).join('')
      : '<option value="">No tours yet: record one with Add › Tour</option>';
    select.value = id ?? this.tours.currentId ?? all[0]?.id ?? '';
    this.dialog.querySelector<HTMLButtonElement>('.start')!.disabled = !all.length;
    this.setProgress(null);
    this.dialog.showModal();
  }

  private setProgress(fraction: number | null, text = ''): void {
    const box = this.dialog.querySelector<HTMLElement>('.movie-progress')!;
    box.hidden = fraction === null;
    box.querySelector('progress')!.value = fraction ?? 0;
    box.querySelector('.status')!.textContent = text;
  }

  private async create(): Promise<void> {
    const get = (sel: string) => this.dialog.querySelector<HTMLSelectElement | HTMLInputElement>(sel)!;
    const id = get('.tour').value;
    const tour = this.tours.all.find((t) => t.id === id);
    if (!tour) return;
    const { width, height } = RESOLUTIONS[Number(get('.resolution').value)];
    const fps = Number(get('.fps').value);
    const bitrate = Math.round(width * height * fps * QUALITY[get('.quality').value as keyof typeof QUALITY]);
    const waitForDetail = (get('.detail') as HTMLInputElement).checked;

    const config = await encoderFor(width, height, fps, bitrate);
    if (!config) {
      // No frame-by-frame encoder here (e.g. some Linux systems): record in real time.
      this.dialog.close();
      this.tours.open(id);
      await this.tours.saveVideo();
      return;
    }

    const controls = this.dialog.querySelectorAll<HTMLElement>('select, input, .start');
    controls.forEach((c) => ((c as HTMLInputElement).disabled = true));
    this.running = true;
    this.cancelled = false;
    try {
      const blob = await this.render(id, tour.duration, width, height, fps, config, waitForDetail);
      if (blob) {
        this.setProgress(1, 'Saving…');
        await saveBinaryFile(`${tour.name}.mp4`, blob, 'mp4');
        this.dialog.close();
      } else {
        this.setProgress(null);
      }
    } catch (err) {
      this.setProgress(0, `Couldn't make the movie: ${(err as Error).message ?? err}`);
    } finally {
      this.running = false;
      controls.forEach((c) => ((c as HTMLInputElement).disabled = false));
    }
  }

  /** Renders every frame and encodes it; null if cancelled. */
  private async render(
    id: string,
    duration: number,
    width: number,
    height: number,
    fps: number,
    config: VideoEncoderConfig,
    waitForDetail: boolean,
  ): Promise<Blob | null> {
    const { viewer } = this;
    const muxer = new Muxer({
      target: new ArrayBufferTarget(),
      video: { codec: 'avc', width, height, frameRate: fps },
      fastStart: 'in-memory',
    });
    let failure: Error | null = null;
    const encoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: (e) => (failure = e),
    });
    encoder.configure(config);

    // Draw the globe large enough to cover the frame, then crop the middle to its shape.
    const original = viewer.resolutionScale;
    const scale = Math.max(width / viewer.canvas.width, height / viewer.canvas.height) * original;
    viewer.resolutionScale = scale;
    const frameCanvas = new OffscreenCanvas(width, height);
    const ctx = frameCanvas.getContext('2d')!;
    const total = Math.max(1, Math.ceil(duration * fps));
    const started = performance.now();

    try {
      for (let i = 0; i <= total; i++) {
        if (this.cancelled) return null;
        if (failure) throw failure;
        this.tours.showFrame(id, Math.min(duration, i / fps));
        await this.renderFrame(waitForDetail);
        const src = viewer.canvas;
        const s = Math.min(src.width / width, src.height / height);
        const cw = width * s;
        const ch = height * s;
        ctx.drawImage(src, (src.width - cw) / 2, (src.height - ch) / 2, cw, ch, 0, 0, width, height);
        const frame = new VideoFrame(frameCanvas, { timestamp: Math.round((i * 1e6) / fps), duration: Math.round(1e6 / fps) });
        encoder.encode(frame, { keyFrame: i % (fps * 2) === 0 });
        frame.close();
        // Don't run far ahead of the encoder.
        while (encoder.encodeQueueSize > 4) await new Promise((r) => setTimeout(r, 5));

        const elapsed = (performance.now() - started) / 1000;
        const left = (elapsed / (i + 1)) * (total - i);
        this.setProgress(i / total, `Frame ${i + 1} of ${total + 1} · about ${clock(left)} left`);
      }
      await encoder.flush();
      if (failure) throw failure;
      muxer.finalize();
      return new Blob([muxer.target.buffer], { type: 'video/mp4' });
    } finally {
      viewer.resolutionScale = original;
      if (encoder.state !== 'closed') encoder.close();
      viewer.scene.requestRender();
    }
  }

  /** Renders the current view, optionally again and again until the map has loaded. */
  private async renderFrame(waitForDetail: boolean): Promise<void> {
    const { viewer } = this;
    // The globe only draws on request (requestRenderMode), so ask before each draw.
    const draw = () => {
      viewer.scene.requestRender();
      viewer.render();
    };
    const deadline = performance.now() + (waitForDetail ? DETAIL_TIMEOUT : 0);
    draw();
    while (waitForDetail && !viewer.scene.globe.tilesLoaded && performance.now() < deadline) {
      // setTimeout rather than requestAnimationFrame: it keeps going if the window is hidden.
      await new Promise((r) => setTimeout(r, 30));
      draw();
    }
    // One more pass so labels placed on the loaded terrain settle.
    draw();
  }
}

function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`;
}

function escape(s: string): string {
  return s.replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`);
}
