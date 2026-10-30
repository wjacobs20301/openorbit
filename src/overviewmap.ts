import { Cartesian3, Math as CesiumMath, Rectangle, type Viewer } from 'cesium';
import { viaCache } from './platform';
import { s2cloudlessUrl, CURRENT_S2_YEAR } from './sources';

const WIDTH = 220;
/** Mercator rows shown: roughly 75°N to 60°S, where nearly everyone looks. */
const TOP = mercatorY(75);
const BOTTOM = mercatorY(-60);
const HEIGHT = Math.round(WIDTH * (BOTTOM - TOP));

/** 0 at the top of the Mercator world, 1 at the bottom. */
function mercatorY(lat: number): number {
  const phi = CesiumMath.toRadians(CesiumMath.clamp(lat, -85, 85));
  return 0.5 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / (2 * Math.PI);
}

/**
 * View › Overview Map: a small world map in the corner showing where the view is.
 * Click it to fly there.
 */
export class OverviewMap {
  private readonly canvas = document.createElement('canvas');
  private readonly world = document.createElement('canvas');
  private on = false;

  constructor(private readonly viewer: Viewer) {
    const dpr = window.devicePixelRatio;
    this.canvas.id = 'overview-map';
    this.canvas.width = WIDTH * dpr;
    this.canvas.height = HEIGHT * dpr;
    this.canvas.style.width = `${WIDTH}px`;
    this.canvas.style.height = `${HEIGHT}px`;
    this.canvas.title = 'Overview map: click to fly there';
    this.canvas.hidden = true;
    document.querySelector('#globe')!.append(this.canvas);
    this.world.width = 512;
    this.world.height = 512;
    void this.loadWorld();

    viewer.camera.changed.addEventListener(() => this.draw());
    viewer.camera.moveEnd.addEventListener(() => this.draw());
    this.canvas.addEventListener('click', (e) => {
      const lon = (e.offsetX / WIDTH) * 360 - 180;
      const y = TOP + (e.offsetY / HEIGHT) * (BOTTOM - TOP);
      const lat = CesiumMath.toDegrees(Math.atan(Math.sinh(Math.PI * (1 - 2 * y))));
      const height = Math.min(Math.max(viewer.camera.positionCartographic.height, 20000), 3000000);
      viewer.camera.flyTo({ destination: Cartesian3.fromDegrees(lon, lat, height) });
    });
  }

  get shown(): boolean {
    return this.on;
  }

  setShown(on: boolean): void {
    this.on = on;
    this.canvas.hidden = !on;
    this.draw();
  }

  /** The world at zoom level 1: four tiles of the same imagery the globe uses. */
  private async loadWorld(): Promise<void> {
    const ctx = this.world.getContext('2d')!;
    const template = s2cloudlessUrl(CURRENT_S2_YEAR);
    await Promise.all(
      [0, 1].flatMap((x) =>
        [0, 1].map(async (y) => {
          const img = new Image();
          img.crossOrigin = 'anonymous';
          img.src = viaCache(template.replace('{z}', '1').replace('{x}', String(x)).replace('{y}', String(y)));
          try {
            await img.decode();
            ctx.drawImage(img, x * 256, y * 256);
          } catch {
            // Leave that quarter blank; the outline still shows where the view is.
          }
        }),
      ),
    );
    this.draw();
  }

  private draw(): void {
    if (!this.on) return;
    const ctx = this.canvas.getContext('2d')!;
    const s = this.canvas.width / WIDTH;
    ctx.setTransform(s, 0, 0, s, 0, 0);
    ctx.fillStyle = '#0b1a2b';
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    ctx.drawImage(this.world, 0, TOP * 512, 512, (BOTTOM - TOP) * 512, 0, 0, WIDTH, HEIGHT);

    const toX = (lon: number) => ((lon + 180) / 360) * WIDTH;
    const toY = (lat: number) => ((mercatorY(lat) - TOP) / (BOTTOM - TOP)) * HEIGHT;
    const view = this.viewer.camera.computeViewRectangle();
    ctx.strokeStyle = '#ff3b30';
    ctx.fillStyle = 'rgba(255,59,48,0.2)';
    ctx.lineWidth = 1.5;
    if (view) {
      const west = CesiumMath.toDegrees(view.west);
      const east = CesiumMath.toDegrees(view.east);
      const x1 = toX(west);
      const x2 = east < west ? toX(east) + WIDTH : toX(east);
      const y1 = toY(CesiumMath.toDegrees(view.north));
      const y2 = toY(CesiumMath.toDegrees(view.south));
      if (x2 - x1 < 6 && y2 - y1 < 6) {
        // Too small to see as a box: mark the spot.
        const c = Rectangle.center(view);
        const cx = toX(CesiumMath.toDegrees(c.longitude));
        const cy = toY(CesiumMath.toDegrees(c.latitude));
        ctx.beginPath();
        ctx.arc(cx, cy, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(cx - 9, cy);
        ctx.lineTo(cx + 9, cy);
        ctx.moveTo(cx, cy - 9);
        ctx.lineTo(cx, cy + 9);
        ctx.stroke();
      } else {
        ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
        ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
        if (x2 > WIDTH) {
          ctx.fillRect(x1 - WIDTH, y1, x2 - x1, y2 - y1);
          ctx.strokeRect(x1 - WIDTH, y1, x2 - x1, y2 - y1);
        }
      }
    }
  }
}
