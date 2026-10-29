import {
  ArcType,
  Cartographic,
  type Cartesian3,
  type Entity,
  Color,
  HeightReference,
  JulianDate,
  GeoJsonDataSource,
  GpxDataSource,
  KmlDataSource,
  type DataSource,
  type Viewer,
} from 'cesium';

/** File types the import button accepts. */
export const IMPORT_ACCEPT = '.kml,.kmz,.geojson,.json,.gpx,.csv,.zip,.shp,.dbf,.prj,.cpg';

type FeatureCollection = { type: 'FeatureCollection'; features: unknown[] };

const fill = Color.fromCssColorString('#ffcc33').withAlpha(0.35);
const stroke = Color.fromCssColorString('#ffcc33');

interface Imported {
  source: DataSource;
  name: string;
}

async function geoJson(data: object, name: string): Promise<Imported> {
  const source = await GeoJsonDataSource.load(data, { clampToGround: true, fill, stroke, strokeWidth: 2, markerColor: stroke });
  return { source, name };
}

/** Reads CSV with latitude/longitude columns (lat, latitude, y / lon, lng, longitude, x). */
export function csvToGeoJson(text: string): FeatureCollection {
  const rows = parseCsv(text.replace(/^﻿/, ''));
  const header = rows.shift()?.map((h) => h.trim().toLowerCase()) ?? [];
  const latCol = header.findIndex((h) => ['lat', 'latitude', 'y'].includes(h));
  const lonCol = header.findIndex((h) => ['lon', 'lng', 'long', 'longitude', 'x'].includes(h));
  if (latCol < 0 || lonCol < 0) throw new Error('CSV needs latitude and longitude columns');

  const features = rows
    .filter((r) => r.length > Math.max(latCol, lonCol))
    .map((r) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [Number(r[lonCol]), Number(r[latCol])] },
      properties: Object.fromEntries(header.map((h, i) => [h, r[i]])),
    }))
    .filter((f) => f.geometry.coordinates.every(Number.isFinite));
  return { type: 'FeatureCollection', features };
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      if (row.some((v) => v !== '')) rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  row.push(cell);
  if (row.some((v) => v !== '')) rows.push(row);
  return rows;
}

/**
 * Drapes flat KML geometry on the terrain, as Google Earth does. Cesium only clamps KML
 * lines that have <tessellate>; others (common in exported files) are drawn at sea level
 * and vanish under hills. Anything with real heights in its coordinates keeps them.
 */
function dropToGround(source: DataSource): void {
  const now = JulianDate.now();
  const outlines: Entity.ConstructorOptions[] = [];
  const flat = (positions: Cartesian3[] | undefined) =>
    !!positions?.length && positions.every((p) => Math.abs(Cartographic.fromCartesian(p)?.height ?? 0) < 1);
  for (const entity of source.entities.values) {
    const line = entity.polyline;
    if (line && !line.clampToGround?.getValue(now) && flat(line.positions?.getValue(now))) {
      line.clampToGround = true as never;
      line.arcType = ArcType.GEODESIC as never;
    }
    const polygon = entity.polygon;
    if (polygon?.perPositionHeight?.getValue(now) && flat(polygon.hierarchy?.getValue(now)?.positions)) {
      polygon.perPositionHeight = false as never;
    }
    // Outlines can't be drawn on terrain, so draw a draped border line instead.
    const ring = polygon?.hierarchy?.getValue(now)?.positions as Cartesian3[] | undefined;
    if (polygon && !polygon.perPositionHeight?.getValue(now) && polygon.outline?.getValue(now) && ring?.length) {
      polygon.outline = false as never;
      outlines.push({
        parent: entity,
        polyline: {
          positions: [...ring, ring[0]],
          clampToGround: true,
          arcType: ArcType.GEODESIC,
          width: Math.max(1.5, polygon.outlineWidth?.getValue(now) ?? 2),
          material: polygon.outlineColor?.getValue(now) ?? Color.WHITE,
        },
      });
    }
    const position = entity.position?.getValue(now);
    if (position && flat([position])) {
      if (entity.billboard) entity.billboard.heightReference = HeightReference.CLAMP_TO_GROUND as never;
      if (entity.point) entity.point.heightReference = HeightReference.CLAMP_TO_GROUND as never;
      if (entity.label) entity.label.heightReference = HeightReference.CLAMP_TO_GROUND as never;
    }
  }
  outlines.forEach((o) => source.entities.add(o));
}

const ext = (f: File) => f.name.toLowerCase().split('.').pop() ?? '';
const base = (f: File) => f.name.replace(/\.[^.]+$/, '');

/**
 * Turns the selected files into data sources. Shapefile parts (.shp/.dbf/.prj/.cpg)
 * picked together are combined by name; a zipped shapefile works on its own.
 */
async function load(files: File[], viewer: Viewer): Promise<Imported[]> {
  const out: Imported[] = [];
  const shapeParts = new Map<string, Partial<Record<'shp' | 'dbf' | 'prj' | 'cpg', File>>>();

  for (const file of files) {
    const kind = ext(file);
    if (kind === 'kml' || kind === 'kmz') {
      const source = await KmlDataSource.load(file, { camera: viewer.scene.camera, canvas: viewer.scene.canvas, clampToGround: true });
      dropToGround(source);
      out.push({ source, name: source.name || file.name });
    } else if (kind === 'geojson' || kind === 'json') {
      out.push(await geoJson(JSON.parse(await file.text()), file.name));
    } else if (kind === 'gpx') {
      const source = await GpxDataSource.load(file, { clampToGround: true });
      out.push({ source, name: source.name || file.name });
    } else if (kind === 'csv') {
      out.push(await geoJson(csvToGeoJson(await file.text()), file.name));
    } else if (kind === 'zip') {
      const { default: shp } = await import('shpjs');
      const parsed = (await shp(await file.arrayBuffer())) as FeatureCollection | FeatureCollection[];
      for (const fc of Array.isArray(parsed) ? parsed : [parsed]) {
        out.push(await geoJson(fc, (fc as { fileName?: string }).fileName ?? file.name));
      }
    } else if (kind === 'shp' || kind === 'dbf' || kind === 'prj' || kind === 'cpg') {
      const parts = shapeParts.get(base(file)) ?? {};
      parts[kind] = file;
      shapeParts.set(base(file), parts);
    }
  }

  for (const [name, parts] of shapeParts) {
    if (!parts.shp) throw new Error(`${name}: choose the .shp file along with its .dbf`);
    const { default: shp } = await import('shpjs');
    const fc = (await shp({
      shp: await parts.shp.arrayBuffer(),
      dbf: await parts.dbf?.arrayBuffer(),
      prj: await parts.prj?.text(),
      cpg: await parts.cpg?.text(),
    })) as FeatureCollection;
    out.push(await geoJson(fc, `${name}.shp`));
  }
  return out;
}

/** Wires the import button and the list of imported layers. */
export function setupImport(viewer: Viewer): void {
  const input = document.querySelector<HTMLInputElement>('#import-input')!;
  const list = document.querySelector<HTMLUListElement>('#import-list')!;
  const status = document.querySelector<HTMLElement>('#import-status')!;
  input.accept = IMPORT_ACCEPT;

  input.addEventListener('change', async () => {
    const files = [...(input.files ?? [])];
    input.value = '';
    if (!files.length) return;
    status.textContent = 'Importing…';
    try {
      const imported = await load(files, viewer);
      for (const { source, name } of imported) {
        await viewer.dataSources.add(source);
        list.append(listItem(viewer, source, name));
      }
      const count = imported.reduce((n, i) => n + i.source.entities.values.length, 0);
      status.textContent = `Imported ${count.toLocaleString()} features.`;
      if (imported.length) void viewer.flyTo(imported[0].source);
    } catch (err) {
      status.textContent = `Import failed: ${(err as Error).message}`;
    }
  });
}

function listItem(viewer: Viewer, ds: DataSource, label: string): HTMLLIElement {
  const li = document.createElement('li');
  const toggle = document.createElement('input');
  toggle.type = 'checkbox';
  toggle.checked = true;
  toggle.addEventListener('change', () => (ds.show = toggle.checked));
  const name = document.createElement('span');
  name.textContent = label;
  name.title = `${ds.entities.values.length.toLocaleString()} features`;
  const go = document.createElement('button');
  go.textContent = 'Go';
  go.title = 'Fly to';
  go.addEventListener('click', () => void viewer.flyTo(ds));
  const remove = document.createElement('button');
  remove.textContent = '×';
  remove.title = 'Remove';
  remove.addEventListener('click', () => {
    viewer.dataSources.remove(ds, true);
    li.remove();
  });
  li.append(toggle, name, go, remove);
  return li;
}
