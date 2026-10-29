import {
  CallbackProperty,
  Cartesian2,
  Cartesian3,
  Cartographic,
  Color,
  EllipsoidGeodesic,
  LabelStyle,
  type Entity,
  type Viewer,
} from 'cesium';

function formatDistance(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km (${(m / 1609.344).toFixed(2)} mi)` : `${m.toFixed(1)} m (${(m * 3.28084).toFixed(0)} ft)`;
}

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
    let sum = 0;
    for (let i = 1; i < this.points.length; i++) {
      sum += new EllipsoidGeodesic(this.points[i - 1], this.points[i]).surfaceDistance;
    }
    return sum;
  }

  clear(): void {
    this.entities.forEach((e) => this.viewer.entities.remove(e));
    this.entities = [];
    this.points = [];
  }
}
