import { Cartesian2, Cartographic, EllipsoidGeodesic, type Viewer } from 'cesium';
import { pickGround } from './globe';
import { invokeIfDesktop, savePngFile } from './platform';
import { niceScale } from './units';

/** One row of the legend: a place's name and colour. */
export interface LegendItem {
  name: string;
  color: string;
  kind: 'point' | 'line' | 'polygon';
}

interface Options {
  title: string;
  description: string;
  showTitle: boolean;
  showLegend: boolean;
  showCompass: boolean;
  showScale: boolean;
  /** Output width in pixels; 0 keeps the size on screen. */
  width: number;
}

const RESOLUTIONS = [
  { width: 0, label: 'Current' },
  { width: 1920, label: 'HD (1920 wide)' },
  { width: 3840, label: '4K (3840 wide)' },
  { width: 7680, label: '8K (7680 wide, slow)' },
];

/** Gives up waiting for sharper tiles after this long and saves what's there. */
const TILE_WAIT_MS = 20000;

/**
 * Google Earth's Save Image mode: a bar over the map with a title, description, legend,
 * compass and scale (shown on the map as they'll appear), a choice of resolution, and
 * Save, Copy and Print.
 */
export class ImageSaver {
  private readonly bar = document.createElement('div');
  private readonly preview = document.createElement('canvas');
  private readonly options: Options = {
    title: 'Untitled',
    description: '',
    showTitle: true,
    showLegend: false,
    showCompass: true,
    showScale: true,
    width: 0,
  };
  private busy = false;

  constructor(
    private readonly viewer: Viewer,
    private readonly legend: () => LegendItem[],
    private readonly onMessage: (text: string) => void,
  ) {
    this.bar.id = 'image-bar';
    this.bar.className = 'map-bar';
    this.bar.hidden = true;
    this.bar.innerHTML = `
      <div class="row">
        <input class="title" aria-label="Title" placeholder="Title" />
        <input class="description grow" aria-label="Description" placeholder="Description (optional)" />
      </div>
      <div class="row options">
        <label class="check"><input type="checkbox" data-opt="showTitle" /> Title</label>
        <label class="check"><input type="checkbox" data-opt="showLegend" /> Legend</label>
        <label class="check"><input type="checkbox" data-opt="showCompass" /> Compass</label>
        <label class="check"><input type="checkbox" data-opt="showScale" /> Scale</label>
        <select class="resolution" aria-label="Resolution">${RESOLUTIONS.map((r) => `<option value="${r.width}">${r.label}</option>`).join('')}</select>
      </div>
      <div class="row end">
        <span class="hint status"></span>
        <span class="spacer"></span>
        <button class="cancel">Close</button>
        <button class="print" title="Print the view">Print…</button>
        <button class="copy" title="Copy the view to the clipboard">Copy</button>
        <button class="save primary">Save Image…</button>
      </div>`;
    this.preview.id = 'image-preview';
    this.preview.hidden = true;
    const globe = document.querySelector('#globe')!;
    globe.append(this.preview, this.bar);

    const title = this.bar.querySelector<HTMLInputElement>('.title')!;
    const description = this.bar.querySelector<HTMLInputElement>('.description')!;
    title.value = this.options.title;
    title.addEventListener('input', () => ((this.options.title = title.value), this.drawPreview()));
    description.addEventListener('input', () => ((this.options.description = description.value), this.drawPreview()));
    for (const box of this.bar.querySelectorAll<HTMLInputElement>('[data-opt]')) {
      const key = box.dataset.opt as 'showTitle' | 'showLegend' | 'showCompass' | 'showScale';
      box.checked = this.options[key];
      box.addEventListener('change', () => ((this.options[key] = box.checked), this.drawPreview()));
    }
    const resolution = this.bar.querySelector<HTMLSelectElement>('.resolution')!;
    resolution.addEventListener('change', () => (this.options.width = Number(resolution.value)));
    this.bar.querySelector('.cancel')!.addEventListener('click', () => this.close());
    this.bar.querySelector('.save')!.addEventListener('click', () => void this.run('save'));
    this.bar.querySelector('.copy')!.addEventListener('click', () => void this.run('copy'));
    this.bar.querySelector('.print')!.addEventListener('click', () => void this.run('print'));
    viewer.camera.changed.addEventListener(() => this.drawPreview());
    viewer.camera.moveEnd.addEventListener(() => this.drawPreview());
    new ResizeObserver(() => this.drawPreview()).observe(viewer.canvas);
  }

  get open(): boolean {
    return !this.bar.hidden;
  }

  show(): void {
    this.bar.hidden = false;
    this.preview.hidden = false;
    // The bar sits above the map and the navigation controls step aside, as in Google Earth.
    document.querySelector('#app')!.classList.add('saving-image');
    this.drawPreview();
    this.viewer.scene.requestRender();
  }

  close(): void {
    this.bar.hidden = true;
    this.preview.hidden = true;
    document.querySelector('#app')!.classList.remove('saving-image');
    this.viewer.scene.requestRender();
  }

  /** Copies the view as it is now (Edit › Copy Image), with whatever decorations are chosen. */
  async copy(): Promise<void> {
    await this.run('copy');
  }

  private status(text: string): void {
    this.bar.querySelector('.status')!.textContent = text;
  }

  private async run(action: 'save' | 'copy' | 'print'): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      this.status(this.options.width ? 'Rendering…' : '');
      const blob = await this.render(action === 'save' ? this.options.width : 0);
      if (action === 'save') {
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
        const name = this.options.showTitle && this.options.title.trim() ? this.options.title.trim() : `OpenOrbit ${stamp}`;
        await savePngFile(`${name.replace(/[\\/:*?"<>|]/g, '-')}.png`, blob);
        this.status('');
      } else if (action === 'copy') {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        this.status('Copied to the clipboard.');
        this.onMessage('Copied the view to the clipboard.');
      } else {
        await printImage(blob);
        this.status('');
      }
    } catch (err) {
      this.status(`Couldn't ${action} the image: ${(err as Error).message ?? err}`);
    } finally {
      this.busy = false;
    }
  }

  /** Draws the globe (at `width` pixels across, or as on screen) with the decorations. */
  private async render(width: number): Promise<Blob> {
    const { viewer } = this;
    const { scene } = viewer;
    const screenWidth = viewer.canvas.clientWidth;
    const original = viewer.resolutionScale;
    // The drawing buffer is the on-screen width times resolutionScale.
    const scale = width ? (original * width) / viewer.canvas.width : original;
    if (scale !== original) {
      viewer.resolutionScale = scale;
      // Wait for sharper tiles at the new size (or give up and use what's there).
      const until = performance.now() + TILE_WAIT_MS;
      let settled = 0;
      while (performance.now() < until && settled < 3) {
        // Draw directly rather than waiting for animation frames, which pause in a hidden window.
        scene.requestRender();
        viewer.render();
        await new Promise((r) => window.setTimeout(r, 50));
        settled = scene.globe.tilesLoaded ? settled + 1 : 0;
      }
    }
    scene.requestRender();
    viewer.render();
    const globe = viewer.canvas;
    const out = document.createElement('canvas');
    out.width = globe.width;
    out.height = globe.height;
    const ctx = out.getContext('2d')!;
    ctx.drawImage(globe, 0, 0);
    if (scale !== original) {
      viewer.resolutionScale = original;
      scene.requestRender();
    }
    this.decorate(ctx, out.width, out.height, out.width / screenWidth, true);
    return new Promise((resolve, reject) => out.toBlob((b) => (b ? resolve(b) : reject(new Error('empty image'))), 'image/png'));
  }

  /** Shows the decorations over the live map, as they'll appear in the image. */
  private drawPreview(): void {
    if (this.preview.hidden) return;
    const { clientWidth: w, clientHeight: h } = this.viewer.canvas;
    const dpr = window.devicePixelRatio;
    this.preview.width = w * dpr;
    this.preview.height = h * dpr;
    this.preview.style.width = `${w}px`;
    this.preview.style.height = `${h}px`;
    const ctx = this.preview.getContext('2d')!;
    ctx.clearRect(0, 0, this.preview.width, this.preview.height);
    this.decorate(ctx, this.preview.width, this.preview.height, dpr, false);
  }

  /** Title box, legend, compass, scale and credits; `s` is image pixels per screen pixel. */
  private decorate(ctx: CanvasRenderingContext2D, w: number, h: number, s: number, withCredits: boolean): void {
    const o = this.options;
    const font = (size: number, weight = 400) => `${weight} ${size * s}px system-ui, -apple-system, sans-serif`;
    const panel = (x: number, y: number, pw: number, ph: number) => {
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.shadowColor = 'rgba(0,0,0,0.3)';
      ctx.shadowBlur = 8 * s;
      ctx.beginPath();
      ctx.roundRect(x, y, pw, ph, 6 * s);
      ctx.fill();
      ctx.shadowBlur = 0;
    };
    const pad = 12 * s;

    if (o.showTitle && (o.title.trim() || o.description.trim())) {
      ctx.font = font(20, 650);
      const titleW = ctx.measureText(o.title).width;
      ctx.font = font(13);
      const lines = wrap(ctx, o.description, 360 * s);
      const descW = Math.max(0, ...lines.map((l) => ctx.measureText(l).width));
      const pw = Math.max(titleW, descW) + pad * 2;
      const ph = pad * 2 + (o.title.trim() ? 24 * s : 0) + lines.length * 18 * s;
      panel(pad, pad, pw, ph);
      ctx.fillStyle = '#1b1f24';
      ctx.textBaseline = 'top';
      let y = pad * 2;
      if (o.title.trim()) {
        ctx.font = font(20, 650);
        ctx.fillText(o.title, pad * 2, y);
        y += 26 * s;
      }
      ctx.font = font(13);
      ctx.fillStyle = '#3c4652';
      for (const line of lines) {
        ctx.fillText(line, pad * 2, y);
        y += 18 * s;
      }
    }

    const items = o.showLegend ? this.legend().slice(0, 20) : [];
    if (items.length) {
      ctx.font = font(13);
      const pw = Math.min(260 * s, Math.max(...items.map((i) => ctx.measureText(i.name).width)) + 46 * s);
      const ph = pad * 2 + 22 * s + items.length * 20 * s;
      const x = pad;
      const y = h - ph - 34 * s;
      panel(x, y, pw, ph);
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#1b1f24';
      ctx.font = font(13, 650);
      ctx.fillText('Legend', x + pad, y + pad + 8 * s);
      ctx.font = font(13);
      items.forEach((item, i) => {
        const cy = y + pad + 30 * s + i * 20 * s;
        ctx.fillStyle = item.color;
        ctx.strokeStyle = item.color;
        ctx.lineWidth = 3 * s;
        if (item.kind === 'point') {
          ctx.beginPath();
          ctx.arc(x + pad + 7 * s, cy, 5 * s, 0, Math.PI * 2);
          ctx.fill();
        } else if (item.kind === 'line') {
          ctx.beginPath();
          ctx.moveTo(x + pad, cy);
          ctx.lineTo(x + pad + 14 * s, cy);
          ctx.stroke();
        } else {
          ctx.globalAlpha = 0.4;
          ctx.fillRect(x + pad, cy - 6 * s, 14 * s, 12 * s);
          ctx.globalAlpha = 1;
          ctx.lineWidth = 1.5 * s;
          ctx.strokeRect(x + pad, cy - 6 * s, 14 * s, 12 * s);
        }
        ctx.fillStyle = '#1b1f24';
        ctx.fillText(ellipsize(ctx, item.name, pw - 46 * s), x + pad + 24 * s, cy);
      });
    }

    if (o.showCompass) {
      const r = 26 * s;
      const cx = w - r - pad;
      const cy = r + pad;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.rotate(-this.viewer.camera.heading);
      ctx.fillStyle = '#d93025';
      ctx.beginPath();
      ctx.moveTo(0, -r * 0.78);
      ctx.lineTo(r * 0.24, 0);
      ctx.lineTo(-r * 0.24, 0);
      ctx.fill();
      ctx.fillStyle = '#5f6b7a';
      ctx.beginPath();
      ctx.moveTo(0, r * 0.78);
      ctx.lineTo(r * 0.24, 0);
      ctx.lineTo(-r * 0.24, 0);
      ctx.fill();
      ctx.fillStyle = '#1b1f24';
      ctx.font = font(10, 700);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('N', 0, -r * 0.5 - 8 * s);
      ctx.restore();
    }

    const metresPerPx = this.metresPerPixel();
    if (o.showScale && metresPerPx) {
      const { metres, label } = niceScale(metresPerPx * 140);
      const len = (metres / metresPerPx) * s;
      const x = w - len - pad - 8 * s;
      const y = h - 34 * s;
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.fillRect(x - 8 * s, y - 22 * s, len + 16 * s, 30 * s);
      ctx.strokeStyle = '#1b1f24';
      ctx.lineWidth = 2 * s;
      ctx.beginPath();
      ctx.moveTo(x, y - 6 * s);
      ctx.lineTo(x, y);
      ctx.lineTo(x + len, y);
      ctx.lineTo(x + len, y - 6 * s);
      ctx.stroke();
      ctx.fillStyle = '#1b1f24';
      ctx.font = font(12, 600);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(label, x + len / 2, y - 6 * s);
      ctx.textAlign = 'start';
    }

    if (withCredits) {
      const text = this.credits();
      ctx.font = font(11);
      ctx.textBaseline = 'middle';
      const tw = ctx.measureText(text).width;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(w - tw - 16 * s, h - 20 * s, tw + 16 * s, 20 * s);
      ctx.fillStyle = '#fff';
      ctx.fillText(text, w - tw - 8 * s, h - 10 * s);
    }
  }

  /** Ground metres per screen pixel across the middle of the view. */
  private metresPerPixel(): number | undefined {
    const { clientWidth: w, clientHeight: h } = this.viewer.canvas;
    const a = pickGround(this.viewer, new Cartesian2(w / 2 - 50, h / 2));
    const b = pickGround(this.viewer, new Cartesian2(w / 2 + 50, h / 2));
    if (!a || !b) return undefined;
    return new EllipsoidGeodesic(Cartographic.clone(a), Cartographic.clone(b)).surfaceDistance / 100;
  }

  /** Data credits for the layers showing, as plain text. */
  private credits(): string {
    const parts = new Set<string>();
    const layers = this.viewer.imageryLayers;
    for (let i = 0; i < layers.length; i++) {
      const layer = layers.get(i);
      const html = layer.show ? layer.imageryProvider.credit?.html : undefined;
      if (html) parts.add(html.replace(/<[^>]+>/g, '').replace(/^Imagery:\s*/, ''));
    }
    parts.add('© OpenStreetMap contributors');
    return `OpenOrbit · ${[...parts].join(' · ')}`;
  }
}

function wrap(ctx: CanvasRenderingContext2D, text: string, max: number): string[] {
  const lines: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (ctx.measureText(next).width > max && line) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    if (line) lines.push(line);
  }
  return lines;
}

function ellipsize(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let t = text;
  while (t && ctx.measureText(`${t}…`).width > max) t = t.slice(0, -1);
  return `${t}…`;
}

/** Prints just the image: it's shown alone on the page while the print dialog is up. */
async function printImage(blob: Blob): Promise<void> {
  const img = document.createElement('img');
  img.id = 'print-image';
  img.src = URL.createObjectURL(blob);
  await img.decode();
  document.body.append(img);
  try {
    // WKWebView ignores window.print(); the desktop app asks the webview natively.
    if (!(await invokeIfDesktop('print_view'))) window.print();
  } finally {
    // The native dialog returns before printing finishes, so keep the image a little while.
    window.setTimeout(() => {
      img.remove();
      URL.revokeObjectURL(img.src);
    }, 60000);
  }
}
