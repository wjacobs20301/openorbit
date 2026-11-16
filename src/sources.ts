/**
 * Public data sources the app reads directly. No project-run servers are involved.
 * Keep this list current when a provider moves an endpoint or changes its terms.
 */

export type MaskId = 'ch' | 'es';

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
  /** A flat colour (besides white/black) the server paints where it has no imagery. */
  fillColour?: [number, number, number];
  /** Clipped to this outline from src/data/coverage-masks.json (servers that paint past the border). */
  mask?: MaskId;
  /** Left out inside these outlines, so a masked country's own layer below shows there. */
  exclude?: MaskId[];
  /**
   * Fill a missing tile from at most this many parent levels, then leave it empty, instead
   * of Cesium's fallback to world-scale tiles (which can show neighbouring countries).
   */
  missingLevels?: number;
  /** `url` is a PMTiles archive read with range requests, not a tile URL template. */
  pmtiles?: boolean;
  /** Layers sharing a group get one toggle in Layers. */
  group?: 'national';
  /** Whether "Save this view for offline" may bulk-fetch this source. */
  offline: boolean;
  note?: string;
}

/** Common settings for the national aerial photo layers below. */
const national = {
  group: 'national',
  // About zoom 13: further out Sentinel-2 is as sharp, and the countries' different
  // colour balance would show as patches.
  showFromLevel: 12,
  fillsNoData: true,
  missingLevels: 2,
  enabledByDefault: true,
  offline: true,
  // Many servers include a strip of the neighbouring country, often from another year.
  // Switzerland and Spain are drawn from their own layers, clipped to their borders.
  exclude: ['ch', 'es'] as MaskId[],
} as const;

/** WMTS GetTile URL in Web Mercator for a KVP-style service. */
function wmts(base: string, layer: string, matrixSet: string, format: string, style = 'default'): string {
  return `${base}?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${layer}&STYLE=${style}&TILEMATRIXSET=${matrixSet}&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=${format}`;
}

/**
 * Open government aerial photos, 8–50 cm. Listed bottom to top: France sits above Spain
 * and Switzerland so its own imagery wins along those borders. Each country's server
 * returns nothing (or plain white) outside its territory, except Switzerland and Spain,
 * which paint filler there and so are clipped to their outlines.
 */
export const nationalSources: ImagerySource[] = [
  {
    ...national,
    id: 'es',
    name: 'Spain (PNOA, 25 cm)',
    url: wmts('https://www.ign.es/wmts/pnoa-ma', 'OI.OrthoimageCoverage', 'GoogleMapsCompatible', 'image/jpeg'),
    credit: 'Imagery: PNOA cedido por © <a href="https://www.ign.es">Instituto Geográfico Nacional</a> (CC BY 4.0)',
    maximumLevel: 20,
    bounds: [-18.2, 27.6, 4.4, 43.8],
    // The sea is painted dark navy.
    fillColour: [2, 8, 20],
    mask: 'es',
    exclude: ['ch'],
  },
  {
    ...national,
    id: 'ch',
    name: 'Switzerland (swisstopo SWISSIMAGE, 10 cm)',
    url: 'https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissimage/default/current/3857/{z}/{x}/{y}.jpeg',
    credit: 'Imagery: © <a href="https://www.swisstopo.admin.ch">swisstopo</a> SWISSIMAGE',
    maximumLevel: 20,
    bounds: [5.9, 45.8, 10.5, 47.85],
    mask: 'ch',
    exclude: [],
  },
  {
    ...national,
    id: 'at',
    name: 'Austria (basemap.at, 30 cm)',
    url: 'https://mapsneu.wien.gv.at/basemap/bmaporthofoto30cm/normal/google3857/{z}/{y}/{x}.jpeg',
    credit: 'Imagery: <a href="https://basemap.at">basemap.at</a> (CC BY 4.0)',
    maximumLevel: 19,
    bounds: [9.5, 46.37, 17.17, 49.02],
  },
  {
    ...national,
    id: 'cz',
    name: 'Czechia (ČÚZK, 12.5 cm)',
    url: 'https://ags.cuzk.cz/arcgis1/rest/services/ORTOFOTO_WM/MapServer/tile/{z}/{y}/{x}',
    credit: 'Imagery: © <a href="https://cuzk.gov.cz">ČÚZK</a> (CC BY 4.0)',
    maximumLevel: 20,
    bounds: [12.09, 48.55, 18.86, 51.06],
  },
  {
    ...national,
    id: 'fr',
    name: 'France (IGN BD ORTHO, 20 cm)',
    url: wmts('https://data.geopf.fr/wmts', 'ORTHOIMAGERY.ORTHOPHOTOS', 'PM', 'image/jpeg', 'normal'),
    credit: 'Imagery: © <a href="https://geoservices.ign.fr">IGN</a> BD ORTHO (Licence Ouverte 2.0)',
    maximumLevel: 19,
    bounds: [-5.3, 41.3, 9.6, 51.1],
  },
  {
    ...national,
    id: 'lu',
    name: 'Luxembourg (geoportail.lu, 10 cm)',
    url: 'https://wmts1.geoportail.lu/opendata/wmts/ortho_latest/GLOBAL_WEBMERCATOR_4_V3/{z}/{x}/{y}.jpeg',
    credit: 'Imagery: <a href="https://geoportail.lu">geoportail.lu</a> (CC0)',
    maximumLevel: 21,
    bounds: [5.73, 49.44, 6.53, 50.19],
  },
  {
    ...national,
    id: 'be-vl',
    name: 'Flanders and Brussels (Digitaal Vlaanderen, 25 cm)',
    url: wmts('https://geo.api.vlaanderen.be/OMWRGBMRVL/wmts', 'omwrgbmrvl', 'GoogleMapsVL', 'image/png', ''),
    credit:
      'Imagery: <a href="https://www.vlaanderen.be/digitaal-vlaanderen">Digitaal Vlaanderen</a> (Modellicentie Gratis Hergebruik)',
    maximumLevel: 21,
    bounds: [2.54, 50.68, 5.92, 51.51],
  },
  {
    ...national,
    id: 'nl',
    name: 'Netherlands (PDOK, 8 cm)',
    url: 'https://service.pdok.nl/hwh/luchtfotorgb/wmts/v1_0/Actueel_orthoHR/EPSG:3857/{z}/{x}/{y}.jpeg',
    credit: 'Imagery: <a href="https://www.beeldmateriaal.nl">Beeldmateriaal Nederland</a> via PDOK (CC BY 4.0)',
    maximumLevel: 21,
    bounds: [3.2, 50.75, 7.23, 53.7],
  },
  {
    ...national,
    id: 'jp',
    name: 'Japan (GSI seamless photo, 20–40 cm)',
    url: 'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg',
    credit: 'Imagery: <a href="https://maps.gsi.go.jp/development/ichiran.html">Geospatial Information Authority of Japan</a>',
    maximumLevel: 18,
    bounds: [122.9, 24.0, 146.0, 45.6],
  },
];

const D4C = 'https://data.source.coop/dataforcanada/d4c-datapkg-orthoimagery/processed/';
const d4cCredit = (provider: string) =>
  `Imagery: ${provider} open data, via <a href="https://source.coop/dataforcanada/d4c-datapkg-orthoimagery">Data for Canada</a>`;

/** Settings for Canadian city aerial photos, read from Data for Canada's PMTiles archives. */
const canadian = {
  ...national,
  pmtiles: true,
  // Missing tiles are simply outside the city; there's no tile URL to borrow parents from.
  missingLevels: undefined,
  // Archives of several GB, read by range request: not for bulk offline downloads.
  offline: false,
  exclude: [] as MaskId[],
  maximumLevel: 19,
} as const;

/**
 * Canadian municipal and provincial aerial photos (7.5–16 cm), republished as PMTiles by
 * the Data for Canada project. Newest year for each place.
 */
export const canadianSources: ImagerySource[] = [
  {
    ...canadian,
    id: 'ca-vancouver',
    name: 'Vancouver (2022, 7.5 cm)',
    url: `${D4C}ca-bc_vancouver-2022A00055915022_d4c-datapkg-orthoimagery_2022_075mm_v0.1.0-beta.pmtiles`,
    credit: d4cCredit('City of Vancouver'),
    bounds: [-123.265, 49.196, -123.012, 49.317],
  },
  {
    ...canadian,
    id: 'ca-burnaby',
    name: 'Burnaby (2020, 7.5 cm)',
    url: `${D4C}ca-bc_burnaby-2020A00055915025_d4c-datapkg-orthoimagery_2020_075mm_v0.1.0-beta.pmtiles`,
    credit: d4cCredit('City of Burnaby'),
    bounds: [-123.028, 49.171, -122.883, 49.306],
  },
  {
    ...canadian,
    id: 'ca-chilliwack',
    name: 'Chilliwack (2025, 10 cm)',
    url: `${D4C}ca-bc_chilliwack-2025A00055909020_d4c-datapkg-orthoimagery_2025_100mm_v0.1.0-beta.pmtiles`,
    credit: d4cCredit('City of Chilliwack'),
    bounds: [-122.152, 49.034, -121.709, 49.236],
  },
  {
    ...canadian,
    id: 'ca-edmonton',
    name: 'Edmonton (2025, 7.5 cm)',
    url: `${D4C}ca-ab_edmonton-2025A00054811061_d4c-datapkg-orthoimagery_2025_075mm_v0.1.0-beta.pmtiles`,
    credit: d4cCredit('City of Edmonton'),
    bounds: [-113.715, 53.334, -113.271, 53.718],
  },
  {
    ...canadian,
    id: 'ca-red-deer',
    name: 'Red Deer (2025, 7.5 cm)',
    url: `${D4C}ca-ab_red-deer-2025A00054808011_d4c-datapkg-orthoimagery_2025_075mm_v0.1.0-beta.pmtiles`,
    credit: d4cCredit('City of Red Deer'),
    bounds: [-113.94, 52.186, -113.702, 52.356],
  },
  {
    ...canadian,
    id: 'ca-winnipeg',
    name: 'Winnipeg (2024, 7.5 cm)',
    url: `${D4C}ca-mb_winnipeg-2024A00054611040_d4c-datapkg-orthoimagery_2024_075mm_v0.1.0-beta.pmtiles`,
    credit: d4cCredit('City of Winnipeg'),
    bounds: [-97.353, 49.708, -96.954, 49.999],
  },
  {
    ...canadian,
    id: 'ca-eastern-ontario',
    name: 'Eastern Ontario (2024, 16 cm)',
    url: `${D4C}ca-on_province_of_ontario-2024A000235_drape_eastern_ontario_orthoimagery_d4c-datapkg-orthoimagery_2024_16cm_v0.1.0-beta.2.pmtiles`,
    credit: d4cCredit('Province of Ontario (DRAPE)'),
    maximumLevel: 18,
    bounds: [-78.442, 43.998, -74.272, 46.369],
  },
];

/** The one Layers toggle that stands for every national source. */
export const NATIONAL_GROUP_NAME = 'Government aerial photos (Europe, Japan, Canadian cities; 8–50 cm)';

/** EOX Sentinel-2 cloudless yearly mosaics (2016 and 2018 onwards), 10 m. */
export function s2cloudlessUrl(year: number): string {
  const layer = year === 2016 ? 's2cloudless_3857' : `s2cloudless-${year}_3857`;
  return `https://tiles.maps.eox.at/wmts/1.0.0/${layer}/default/g/{z}/{y}/{x}.jpg`;
}

export function s2cloudlessCredit(year: number): string {
  const licence = year === 2016 ? 'CC BY 4.0' : 'CC BY-NC-SA 4.0';
  return `Sentinel-2 cloudless ${year} by <a href="https://s2maps.eu">EOX IT Services GmbH</a> (contains modified Copernicus Sentinel data ${year}), ${licence}`;
}

export const CURRENT_S2_YEAR = 2025;

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
  {
    // USDA aerial photos, drawn by the server per tile (it isn't pre-tiled), so only for
    // close-up views where the USGS tiles above run out of detail. Public domain.
    id: 'naip',
    name: 'USGS NAIP aerial photos (United States, 30–60 cm)',
    url: 'https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPPlus/ImageServer/exportImage?bbox={westProjected},{southProjected},{eastProjected},{northProjected}&bboxSR=3857&imageSR=3857&size=256,256&format=jpg&compressionQuality=90&f=image',
    credit: 'Imagery: <a href="https://www.usgs.gov/programs/national-geospatial-program/national-map">USGS The National Map</a>, USDA NAIP',
    // Drawn (and fetched) only this close: further out the USGS tiles are as sharp, and
    // NAIP's mix of survey years shows as patches next to them.
    showFromLevel: 16,
    maximumLevel: 19,
    bounds: [-125, 24.4, -66.8, 49.4],
    fillsNoData: true,
    outside: (lon, lat) => lat > 49 && lon > -123.33 && lon < -95.15,
    enabledByDefault: true,
    // Rendered on demand by the server: not for bulk downloads.
    offline: false,
  },
  ...nationalSources,
  ...canadianSources,
];

/**
 * Sharp worldwide imagery from commercial services, used with the person's own key
 * (each has a free tier). Not routed through the disk cache: their terms don't allow
 * storing tiles, and the key would end up in cache file names.
 */
export interface KeyedImagerySource {
  id: string;
  name: string;
  /** Settings key the API key is stored under. */
  setting: string;
  url: (key: string) => string;
  credit: string;
  maximumLevel: number;
  tileSize: number;
  /** Where to get a key, shown in Settings. */
  signup: string;
}

export const keyedImagerySources: KeyedImagerySource[] = [
  {
    id: 'esri',
    name: 'Esri World Imagery (your key)',
    setting: 'esriKey',
    url: (key) =>
      `https://ibasemaps-api.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}?token=${encodeURIComponent(key)}`,
    credit: 'Imagery: <a href="https://www.esri.com">Esri</a>, Vantor, Earthstar Geographics, and the GIS User Community',
    // Deeper levels often return "map data not yet available" placeholders.
    maximumLevel: 19,
    tileSize: 256,
    signup: 'https://location.arcgis.com',
  },
  {
    id: 'mapbox',
    name: 'Mapbox Satellite (your token)',
    setting: 'mapboxToken',
    url: (key) => `https://api.mapbox.com/v4/mapbox.satellite/{z}/{x}/{y}@2x.jpg90?access_token=${encodeURIComponent(key)}`,
    credit: '© <a href="https://www.mapbox.com/about/maps/">Mapbox</a> © <a href="https://www.maxar.com/">Maxar</a>',
    maximumLevel: 21,
    tileSize: 512,
    signup: 'https://account.mapbox.com',
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

/**
 * Land elevation: Mapterhorn (Copernicus GLO-30 worldwide, national lidar surveys where
 * published, up to zoom 17). Terrarium-encoded 512 px WebP tiles; sea is 0 or missing.
 */
export const terrainSource = {
  offline: true,
  url: 'https://tiles.mapterhorn.com/{z}/{x}/{y}.webp',
  tileSize: 512,
  credit:
    'Terrain: <a href="https://mapterhorn.com/attribution">Mapterhorn</a> (Copernicus GLO-30 and national surveys); sea floor: <a href="https://registry.opendata.aws/terrain-tiles/">AWS Terrain Tiles</a> (ETOPO1, GEBCO)',
  maximumLevel: 17,
};

/** Sea floor depths where Mapterhorn has none: AWS Terrain Tiles (Terrarium PNG, 256 px). */
export const bathymetrySource = {
  url: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
  tileSize: 256,
  // The ocean data (ETOPO1, about 1.8 km) has no more detail past this.
  maximumLevel: 10,
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
  panoramaxApi: 'https://api.panoramax.xyz/api',
  /** Vector tiles of photo positions only (no images); zoom 15 is the most detailed. */
  panoramaxTiles: 'https://api.panoramax.xyz/api/map/{z}/{x}/{y}.mvt',
  mapillaryGraph: 'https://graph.mapillary.com',
};
