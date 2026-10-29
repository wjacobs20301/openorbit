/**
 * Public data sources the app reads directly. No project-run servers are involved.
 * Keep this list current when a provider moves an endpoint or changes its terms.
 */

export interface ImagerySource {
  id: string;
  name: string;
  url: string;
  credit: string;
  maximumLevel: number;
  /** [west, south, east, north] in degrees; tiles are only requested inside it. */
  bounds?: [number, number, number, number];
  /** Only drawn once the view is this close (terrain level), to avoid seams at world scale. */
  showFromLevel?: number;
  enabledByDefault: boolean;
  /** The server paints areas without imagery solid white or black; make them transparent. */
  fillsNoData?: boolean;
  /** Pixels where this returns true (lon, lat in degrees) are hidden; needs fillsNoData. */
  outside?: (lon: number, lat: number) => boolean;
  /** Whether "Save this view for offline" may bulk-fetch this source. */
  offline: boolean;
  note?: string;
}

/** EOX Sentinel-2 cloudless yearly mosaics (2016 and 2018 onwards), 10 m. */
export function s2cloudlessUrl(year: number): string {
  const layer = year === 2016 ? 's2cloudless_3857' : `s2cloudless-${year}_3857`;
  return `https://tiles.maps.eox.at/wmts/1.0.0/${layer}/default/g/{z}/{y}/{x}.jpg`;
}

export function s2cloudlessCredit(year: number): string {
  const licence = year === 2016 ? 'CC BY 4.0' : 'CC BY-NC-SA 4.0';
  return `Sentinel-2 cloudless ${year} by <a href="https://s2maps.eu">EOX IT Services GmbH</a> (contains modified Copernicus Sentinel data ${year}), ${licence}`;
}

const CURRENT_S2_YEAR = 2025;

export const imagerySources: ImagerySource[] = [
  {
    id: 's2cloudless',
    name: `Sentinel-2 cloudless ${CURRENT_S2_YEAR} (world, 10 m)`,
    url: s2cloudlessUrl(CURRENT_S2_YEAR),
    credit: s2cloudlessCredit(CURRENT_S2_YEAR),
    maximumLevel: 15,
    enabledByDefault: true,
    // Capped, throttled downloads only; review EOX's terms before a public release.
    offline: true,
    note: 'Non-commercial licence.',
  },
  {
    id: 'usgs',
    name: 'USGS imagery (United States, sub-metre)',
    url: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}',
    credit: 'Imagery: <a href="https://www.usgs.gov/programs/national-geospatial-program/national-map">USGS The National Map</a>',
    maximumLevel: 16,
    bounds: [-179.9, 17.5, -64.5, 71.5],
    // Coarser USGS tiles blend in low-quality imagery past the border; Sentinel-2 is as sharp there.
    showFromLevel: 12,
    fillsNoData: true,
    // US aerial photos spill a few km into Canada; the border is the 49th parallel
    // from the Pacific to Lake of the Woods.
    outside: (lon, lat) => lat > 49 && lon > -123.33 && lon < -95.15,
    enabledByDefault: true,
    offline: true,
  },
];

export interface HistorySnapshot {
  label: string;
  /** Sort key and slider position. */
  year: number;
  url: string;
  credit: string;
  maximumLevel: number;
}

const GIBS = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best';
const gibsCredit = 'Imagery: <a href="https://earthdata.nasa.gov/gibs">NASA GIBS</a>';

/** Past imagery for the time slider: Landsat (30 m) back to 1984, then yearly Sentinel-2. */
export const historySnapshots: HistorySnapshot[] = [
  ...[1984, 1985, 1988, 1989, 1990, 1999, 2000].map((year) => ({
    label: `${year} · Landsat 30 m`,
    year,
    url: `${GIBS}/Landsat_WELD_CorrectedReflectance_TrueColor_Global_Annual/default/${year}-12-01/GoogleMapsCompatible_Level12/{z}/{y}/{x}.jpg`,
    credit: `${gibsCredit}, Landsat WELD annual mosaic (NASA/USGS)`,
    maximumLevel: 12,
  })),
  ...[2016, 2018, 2019, 2020, 2021, 2022, 2023, 2024].map((year) => ({
    label: `${year} · Sentinel-2 10 m`,
    year,
    url: s2cloudlessUrl(year),
    credit: s2cloudlessCredit(year),
    maximumLevel: 15,
  })),
];

/** Daily true-colour images from 2000-02-24 to today (MODIS Terra, 250 m). */
export function modisDailyUrl(date: string): string {
  return `${GIBS}/MODIS_Terra_CorrectedReflectance_TrueColor/default/${date}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg`;
}
export const modisCredit = `${gibsCredit}, MODIS Terra Corrected Reflectance`;
export const MODIS_FIRST_DAY = '2000-02-24';

export const terrainSource = {
  offline: true,
  url: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
  credit:
    'Terrain: <a href="https://registry.opendata.aws/terrain-tiles/">AWS Terrain Tiles</a> (SRTM, GMTED, ETOPO1, USGS 3DEP and others)',
  maximumLevel: 15,
};

/** OpenStreetMap vector tiles (OpenMapTiles schema) for labels, borders and roads. */
export const vectorTiles = {
  // TileJSON; the tile URL inside it changes with each weekly data release.
  tileJsonUrl: 'https://tiles.openfreemap.org/planet',
  credit:
    '<a href="https://openfreemap.org">OpenFreeMap</a> © <a href="https://www.openmaptiles.org/">OpenMapTiles</a>, data © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  maximumLevel: 14,
};

export const geocoder = {
  url: 'https://photon.komoot.io/api/',
  credit: 'Search by <a href="https://photon.komoot.io">Photon</a>, data © OpenStreetMap contributors',
};

export const streetSources = {
  panoramaxSearch: 'https://api.panoramax.xyz/api/search',
  mapillaryGraph: 'https://graph.mapillary.com',
};
