import {
  CallbackProperty,
  Cartographic,
  Color,
  PolygonHierarchy,
  type Entity,
  type Viewer,
} from 'cesium';
import { formatArea, formatDistance, pathLength, polygonArea, toLonLat, type LonLat } from './geometry';

export type ShapeKind = 'line' | 'polygon';

const DRAFT_COLOR = Color.fromCssColorString('#33d1ff');
/** Points closer than this (degrees) are treated as the same click, e.g. from a double-click. */
const SAME_POINT = 1e-7;

/**
 * Interactive path/polygon drawing: click to add points, move to preview the next
 * edge, double-click or Enter to finish, Backspace to undo, Escape to cancel.
 */
export class Drawer {
  kind: ShapeKind | null = null;
  private points: Cartographic[] = [];
  private cursor?: Cartographic;
  private entity?: Entity;

  constructor(
    private readonly viewer: Viewer,
    private readonly onSummary: (text: string) => void,
    private readonly onFinish: (kind: ShapeKind, coords: LonLat[]) => void,
  ) {}

  start(kind: ShapeKind): void {
    this.cancel();
    this.kind = kind;
    const cartesians = () =>
      [...this.points, ...(this.cursor ? [this.cursor] : [])].map((p) => Cartographic.toCartesian(p));

    this.entity = this.viewer.entities.add({
      polyline: {
        positions: new CallbackProperty(() => {
          const pts = cartesians();
          return kind === 'polygon' && pts.length > 2 ? [...pts, pts[0]] : pts;
        }, false),
        width: 3,
        material: DRAFT_COLOR,
        clampToGround: true,
      },
      polygon:
        kind === 'polygon'
          ? {
              show: new CallbackProperty(() => this.points.length + (this.cursor ? 1 : 0) >= 3, false),
              hierarchy: new CallbackProperty(() => new PolygonHierarchy(cartesians()), false),
              material: DRAFT_COLOR.withAlpha(0.25),
            }
          : undefined,
    });
    this.summarize();
  }

  add(point: Cartographic): void {
    if (!this.kind) return;
    const last = this.points.at(-1);
    if (last && Math.abs(last.longitude - point.longitude) < SAME_POINT && Math.abs(last.latitude - point.latitude) < SAME_POINT) {
      return;
    }
    this.points.push(point);
    this.summarize();
  }

  move(point: Cartographic | undefined): void {
    if (this.kind) this.cursor = point;
  }

  undo(): void {
    this.points.pop();
    this.summarize();
  }

  finish(): void {
    const kind = this.kind;
    const coords = this.points.map(toLonLat);
    this.cancel();
    if (kind && coords.length >= (kind === 'polygon' ? 3 : 2)) this.onFinish(kind, coords);
  }

  cancel(): void {
    if (this.entity) this.viewer.entities.remove(this.entity);
    this.entity = undefined;
    this.points = [];
    this.cursor = undefined;
    this.kind = null;
  }

  private summarize(): void {
    const coords = this.points.map(toLonLat);
    const done = 'Double-click or press Enter to finish.';
    if (this.kind === 'line') {
      this.onSummary(coords.length < 2 ? 'Click to add points along the path.' : `${formatDistance(pathLength(coords))}. ${done}`);
    } else if (this.kind === 'polygon') {
      this.onSummary(
        coords.length < 3
          ? 'Click to add the corners of the shape.'
          : `Area ${formatArea(polygonArea(coords))}, perimeter ${formatDistance(pathLength(coords, true))}. ${done}`,
      );
    }
  }
}
