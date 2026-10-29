import {
  CallbackProperty,
  Cartesian2,
  Cartesian3,
  Cartographic,
  Color,
  LabelStyle,
  type Entity,
  type Viewer,
} from 'cesium';
import { formatDistance, pathLength, toLonLat } from './geometry';

/** Click-to-add ground distance measurement along geodesics. */
export class Measure {
  private points: Cartographic[] = [];
  private entities: Entity[] = [];

  constructor(private readonly viewer: Viewer, private readonly onChange: (summary: string) => void) {}

  add(point: Cartographic): void {
    this.points.push(point);
    if (this.points.length === 1) {
      this.entities.push(
        this.viewer.entities.add({
          polyline: {
            positions: new CallbackProperty(() => this.points.map((p) => Cartographic.toCartesian(p)), false),
            width: 3,
            material: Color.fromCssColorString('#33d1ff'),
            clampToGround: true,
          },
        }),
      );
    }
    this.entities.push(
      this.viewer.entities.add({
        position: Cartesian3.fromRadians(point.longitude, point.latitude, point.height),
        point: { pixelSize: 7, color: Color.WHITE, disableDepthTestDistance: Number.POSITIVE_INFINITY },
        label: {
          text: this.points.length > 1 ? formatDistance(this.total()) : 'Start',
          font: '13px system-ui, sans-serif',
          style: LabelStyle.FILL_AND_OUTLINE,
          outlineWidth: 3,
          outlineColor: Color.BLACK,
          pixelOffset: new Cartesian2(0, -16),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      }),
    );
    this.onChange(this.points.length > 1 ? `Total: ${formatDistance(this.total())}` : 'Click the next point.');
  }

  total(): number {
    return pathLength(this.points.map(toLonLat));
  }

  clear(): void {
    this.entities.forEach((e) => this.viewer.entities.remove(e));
    this.entities = [];
    this.points = [];
  }
}
