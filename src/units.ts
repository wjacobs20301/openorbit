import { loadSetting, storeSetting } from './platform';

/** Tools › Options in Google Earth: how distances and coordinates are shown. */
export type Units = 'metric' | 'imperial';
export type CoordFormat = 'decimal' | 'dms' | 'dm' | 'utm';

const FT = 3.28084;
const FT_PER_MI = 5280;

let units: Units = loadSetting('units') === 'imperial' ? 'imperial' : 'metric';
let coordFormat: CoordFormat = (['decimal', 'dms', 'dm', 'utm'] as const).find((f) => f === loadSetting('coordFormat')) ?? 'dms';
const listeners = new Set<() => void>();

export const getUnits = (): Units => units;
export const getCoordFormat = (): CoordFormat => coordFormat;

export function setUnits(next: Units): void {
  units = next;
  storeSetting('units', next);
  listeners.forEach((fn) => fn());
}

export function setCoordFormat(next: CoordFormat): void {
  coordFormat = next;
  storeSetting('coordFormat', next);
  listeners.forEach((fn) => fn());
}

/** Runs `fn` whenever the units or coordinate format change. */
export function onUnitsChange(fn: () => void): void {
  listeners.add(fn);
}

/** A ground distance: m/km, or ft/mi. */
export function formatDistance(m: number): string {
  if (units === 'imperial') {
    const ft = m * FT;
    return ft < FT_PER_MI ? `${Math.round(ft).toLocaleString()} ft` : `${(ft / FT_PER_MI).toFixed(2)} mi`;
  }
  return m < 1000 ? `${m.toFixed(1)} m` : `${(m / 1000).toFixed(2)} km`;
}

/** An area: ha/km², or acres/sq mi. */
export function formatArea(m2: number): string {
  if (units === 'imperial') {
    return m2 >= 2589988.11 ? `${(m2 / 2589988.11).toFixed(2)} sq mi` : `${(m2 / 4046.856).toFixed(2)} acres`;
  }
  return m2 >= 1e6 ? `${(m2 / 1e6).toFixed(2)} km²` : `${(m2 / 1e4).toFixed(2)} ha`;
}

/** A height or elevation, in whole metres or feet. */
export function formatHeight(m: number): string {
  return units === 'imperial' ? `${Math.round(m * FT).toLocaleString()} ft` : `${Math.round(m).toLocaleString()} m`;
}

/** Eye altitude: m/km, or ft/mi. */
export function formatAltitude(m: number): string {
  if (units === 'imperial') {
    const ft = m * FT;
    return ft < FT_PER_MI ? `${Math.round(ft)} ft` : `${(ft / FT_PER_MI).toFixed(2)} mi`;
  }
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(2)} km`;
}

/** A position in the chosen format, latitude first as Google Earth shows it. */
export function formatLatLon(lat: number, lon: number, format = coordFormat): string {
  const hemi = (deg: number, pos: string, neg: string) => (deg >= 0 ? pos : neg);
  if (format === 'decimal') return `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
  if (format === 'utm') return toUtm(lat, lon) ?? formatLatLon(lat, lon, 'decimal');
  const part = (deg: number, pos: string, neg: string) => {
    const a = Math.abs(deg);
    const d = Math.floor(a);
    const minutes = (a - d) * 60;
    if (format === 'dm') return `${d}°${minutes.toFixed(4).padStart(7, '0')}' ${hemi(deg, pos, neg)}`;
    const m = Math.floor(minutes);
    const s = (minutes - m) * 60;
    return `${d}°${String(m).padStart(2, '0')}'${s.toFixed(2).padStart(5, '0')}" ${hemi(deg, pos, neg)}`;
  };
  return `${part(lat, 'N', 'S')}  ${part(lon, 'E', 'W')}`;
}

/** Universal Transverse Mercator on WGS84, e.g. "10U 585234 m E 5447890 m N". */
export function toUtm(lat: number, lon: number): string | undefined {
  if (lat < -80 || lat > 84) return undefined;
  let zone = Math.floor((lon + 180) / 6) + 1;
  if (zone > 60) zone = 60;
  // Norway and Svalbard have wider zones.
  if (lat >= 56 && lat < 64 && lon >= 3 && lon < 12) zone = 32;
  if (lat >= 72) {
    if (lon >= 0 && lon < 9) zone = 31;
    else if (lon >= 9 && lon < 21) zone = 33;
    else if (lon >= 21 && lon < 33) zone = 35;
    else if (lon >= 33 && lon < 42) zone = 37;
  }
  const a = 6378137;
  const f = 1 / 298.257223563;
  const e2 = f * (2 - f);
  const ep2 = e2 / (1 - e2);
  const k0 = 0.9996;
  const phi = (lat * Math.PI) / 180;
  const lon0 = (((zone - 1) * 6 - 180 + 3) * Math.PI) / 180;
  const n = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
  const t = Math.tan(phi) ** 2;
  const c = ep2 * Math.cos(phi) ** 2;
  const A = Math.cos(phi) * ((lon * Math.PI) / 180 - lon0);
  const m =
    a *
    ((1 - e2 / 4 - (3 * e2 ** 2) / 64 - (5 * e2 ** 3) / 256) * phi -
      ((3 * e2) / 8 + (3 * e2 ** 2) / 32 + (45 * e2 ** 3) / 1024) * Math.sin(2 * phi) +
      ((15 * e2 ** 2) / 256 + (45 * e2 ** 3) / 1024) * Math.sin(4 * phi) -
      ((35 * e2 ** 3) / 3072) * Math.sin(6 * phi));
  const easting =
    k0 * n * (A + ((1 - t + c) * A ** 3) / 6 + ((5 - 18 * t + t ** 2 + 72 * c - 58 * ep2) * A ** 5) / 120) + 500000;
  let northing =
    k0 *
    (m +
      n *
        Math.tan(phi) *
        (A ** 2 / 2 + ((5 - t + 9 * c + 4 * c ** 2) * A ** 4) / 24 + ((61 - 58 * t + t ** 2 + 600 * c - 330 * ep2) * A ** 6) / 720));
  if (lat < 0) northing += 10000000;
  const band = 'CDEFGHJKLMNPQRSTUVWXX'[Math.min(20, Math.floor((lat + 80) / 8))];
  return `${zone}${band} ${Math.round(easting)} m E ${Math.round(northing)} m N`;
}

/** The scale legend's round distance and its label, for a bar at most `maxMetres` long. */
export function niceScale(maxMetres: number): { metres: number; label: string } {
  const nice = (max: number) => {
    const power = 10 ** Math.floor(Math.log10(max));
    return [5, 2, 1].map((x) => x * power).find((d) => d <= max) ?? power;
  };
  if (units === 'imperial') {
    const maxFt = maxMetres * FT;
    if (maxFt >= FT_PER_MI) {
      const mi = nice(maxFt / FT_PER_MI);
      return { metres: (mi * FT_PER_MI) / FT, label: `${mi} mi` };
    }
    const ft = nice(maxFt);
    return { metres: ft / FT, label: `${ft} ft` };
  }
  const metres = nice(maxMetres);
  return { metres, label: metres >= 1000 ? `${metres / 1000} km` : `${metres} m` };
}
