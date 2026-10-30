import { Cartographic, EllipsoidGeodesic, Math as CesiumMath } from 'cesium';

/** [longitude, latitude] in degrees. */
export type LonLat = [number, number];

const EARTH_RADIUS = 6371008.8;

export function toLonLat(c: Cartographic): LonLat {
  return [CesiumMath.toDegrees(c.longitude), CesiumMath.toDegrees(c.latitude)];
}

/** Ground distance along geodesics, in metres. Pass `closed` to include the closing edge. */
export function pathLength(points: LonLat[], closed = false): number {
  const pts = closed && points.length > 2 ? [...points, points[0]] : points;
  let sum = 0;
  for (let i = 1; i < pts.length; i++) {
    sum += new EllipsoidGeodesic(
      Cartographic.fromDegrees(...pts[i - 1]),
      Cartographic.fromDegrees(...pts[i]),
    ).surfaceDistance;
  }
  return sum;
}

/** Area of a simple polygon on a sphere, in square metres. */
export function polygonArea(points: LonLat[]): number {
  if (points.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const [lon1, lat1] = points[i].map(CesiumMath.toRadians);
    const [lon2, lat2] = points[(i + 1) % points.length].map(CesiumMath.toRadians);
    sum += (lon2 - lon1) * (2 + Math.sin(lat1) + Math.sin(lat2));
  }
  return Math.abs((sum * EARTH_RADIUS * EARTH_RADIUS) / 2);
}

export { formatArea, formatDistance } from './units';

/** A point to hang a label on: the vertex average, good enough for typical shapes. */
export function centroid(points: LonLat[]): LonLat {
  const n = points.length;
  return [points.reduce((s, p) => s + p[0], 0) / n, points.reduce((s, p) => s + p[1], 0) / n];
}
