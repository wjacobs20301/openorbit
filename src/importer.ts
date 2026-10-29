import {
  ArcType,
  Cartographic,
  type Cartesian3,
  Entity,
  Color,
  HeightReference,
  JulianDate,
  GeoJsonDataSource,
  GpxDataSource,
  KmlDataSource,
  type DataSource,
  type Viewer,
} from 'cesium';
import { forgetFiles, keepFiles, keptFiles } from './keptfiles';

/** File types the import button accepts. */
export const IMPORT_ACCEPT = '.kml,.kmz,.geojson,.json,.gpx,.csv,.zip,.shp,.dbf,.prj,.cpg';

type FeatureCollection = { type: 'FeatureCollection'; features: unknown[] };

const fill = Color.fromCssColorString('#ffcc33').withAlpha(0.35);
const stroke = Color.fromCssColorString('#ffcc33');

interface Imported {
  source: DataSource;
  name: string;
  /** The file(s) it came from, so it can be kept in My Places. */
  files: File[];
}

async function geoJson(data: object, name: string, files: File[]): Promise<Imported> {
  const source = await GeoJsonDataSource.load(data, { clampToGround: true, fill, stroke, strokeWidth: 2, markerColor: stroke });
  return { source, name, files };
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

const escapeHtml = (s: string) => s.replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * Adds a details table to features from KML <ExtendedData>. Cesium ignores
 * <SchemaData>/<SimpleData> (how many GIS tools export attributes), so the file is read
 * here and matched to features by placemark id, or by order when ids are missing.
 */
function addExtendedData(source: DataSource, kml: string): void {
  const doc = new DOMParser().parseFromString(kml, 'application/xml');
  const placemarks = [...doc.getElementsByTagName('Placemark')];
  if (!placemarks.length) return;
  const byOrder = source.entities.values.filter((e) => e.polyline || e.polygon || e.billboard || e.point || e.label);
  placemarks.forEach((pm, i) => {
    const rows: [string, string][] = [];
    for (const el of pm.getElementsByTagName('SimpleData')) rows.push([el.getAttribute('name') ?? '', el.textContent ?? '']);
    for (const el of pm.getElementsByTagName('Data')) {
      const label = el.getElementsByTagName('displayName')[0]?.textContent || el.getAttribute('name') || '';
      rows.push([label, el.getElementsByTagName('value')[0]?.textContent ?? '']);
    }
    if (!rows.length) return;
    const id = pm.getAttribute('id');
    const entity = (id && source.entities.getById(id)) || byOrder[i];
    if (!entity) return;
    const existing = (entity.description as unknown as { getValue?: () => string } | undefined)?.getValue?.() ?? '';
    // Cesium may already have made a table from <Data>; replace it rather than repeat it.
    const intro = existing && !existing.includes('<table') ? `<div>${existing}</div>` : '';
    const table = rows.map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`).join('');
    entity.description = `${intro}<table>${table}</table>`;
  });
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
      if (kind === 'kml') addExtendedData(source, await file.text());
      out.push({ source, name: source.name || file.name, files: [file] });
    } else if (kind === 'geojson' || kind === 'json') {
      out.push(await geoJson(JSON.parse(await file.text()), file.name, [file]));
    } else if (kind === 'gpx') {
      const source = await GpxDataSource.load(file, { clampToGround: true });
      out.push({ source, name: source.name || file.name, files: [file] });
    } else if (kind === 'csv') {
      out.push(await geoJson(csvToGeoJson(await file.text()), file.name, [file]));
    } else if (kind === 'zip') {
      const { default: shp } = await import('shpjs');
      const parsed = (await shp(await file.arrayBuffer())) as FeatureCollection | FeatureCollection[];
      for (const fc of Array.isArray(parsed) ? parsed : [parsed]) {
        out.push(await geoJson(fc, (fc as { fileName?: string }).fileName ?? file.name, [file]));
      }
    } else if (kind === 'shp' || kind === 'dbf' || kind === 'prj' || kind === 'cpg') {
      const parts = shapeParts.get(base(file)) ?? {};
      parts[kind] = file;
      shapeParts.set(base(file), parts);
    }
  }

  for (const [name, shape] of shapeParts) {
    if (!shape.shp) throw new Error(`${name}: choose the .shp file along with its .dbf`);
    const { default: shp } = await import('shpjs');
    const fc = (await shp({
      shp: await shape.shp.arrayBuffer(),
      dbf: await shape.dbf?.arrayBuffer(),
      prj: await shape.prj?.text(),
      cpg: await shape.cpg?.text(),
    })) as FeatureCollection;
    const files = [shape.shp, shape.dbf, shape.prj, shape.cpg].filter((f): f is File => !!f);
    out.push(await geoJson(fc, `${name}.shp`, files));
  }
  return out;
}

/** Wires the import button and the list of imported layers. */
export function setupImport(viewer: Viewer): void {
  const input = document.querySelector<HTMLInputElement>('#import-input')!;
  const list = document.querySelector<HTMLUListElement>('#import-list')!;
  const keptList = document.querySelector<HTMLUListElement>('#kept-list')!;
  const status = document.querySelector<HTMLElement>('#import-status')!;
  input.accept = IMPORT_ACCEPT;

  /** Shows a kept file under My Places; × forgets it. */
  const showKept = (item: Imported, id: string, li?: HTMLLIElement) => {
    const row = li ?? listItem(viewer, item.source, item.name);
    removed.set(row, () => void forgetFiles(id));
    keptList.append(row);
  };

  // Files kept from earlier sessions open again under My Places.
  void keptFiles().then(async (kept) => {
    for (const k of kept) {
      try {
        const files = k.files.map((f) => new File([f.data], f.name, { type: f.type }));
        for (const item of await load(files, viewer)) {
          await viewer.dataSources.add(item.source);
          showKept(item, k.id);
        }
      } catch {
        status.textContent = `Couldn't reopen ${k.name}.`;
      }
    }
  });

  input.addEventListener('change', async () => {
    const files = [...(input.files ?? [])];
    input.value = '';
    if (!files.length) return;
    status.textContent = 'Importing…';
    try {
      const imported = await load(files, viewer);
      for (const item of imported) {
        await viewer.dataSources.add(item.source);
        // Opened files go to Temporary Places, as in Google Earth; Keep moves them to My Places.
        const li: HTMLLIElement = listItem(viewer, item.source, item.name, async () => {
          showKept(item, await keepFiles(item.name, item.files), li);
          status.textContent = `${item.name} is kept in My Places.`;
        });
        list.append(li);
      }
      const count = imported.reduce((n, i) => n + i.source.entities.values.length, 0);
      status.textContent = `Imported ${count.toLocaleString()} features.`;
      if (imported.length) void viewer.flyTo(imported[0].source);
    } catch (err) {
      status.textContent = `Import failed: ${(err as Error).message}`;
    }
  });
}

/** True for KML folder/document entities: they group other features and draw nothing. */
function isFolder(e: Entity, children: Map<Entity, Entity[]>): boolean {
  return children.has(e) && !e.polyline && !e.polygon && !e.billboard && !e.point && !e.label && !e.model;
}

/** Counts the drawable features under an entity. */
function countFeatures(e: Entity, children: Map<Entity, Entity[]>): number {
  return (children.get(e) ?? []).reduce((n, c) => n + (isFolder(c, children) ? countFeatures(c, children) : 1), 0);
}

/** Folder rows for a KML's own folders, each with a show/hide checkbox (nested like the file). */
function folderTree(viewer: Viewer, parent: Entity | undefined, children: Map<Entity, Entity[]>, roots: Entity[]): HTMLUListElement | null {
  const folders = (parent ? (children.get(parent) ?? []) : roots).filter((e) => isFolder(e, children));
  if (!folders.length) return null;
  const ul = document.createElement('ul');
  ul.className = 'list tree-children';
  for (const folder of folders) {
    const li = document.createElement('li');
    li.className = 'tree-node';
    const row = document.createElement('div');
    row.className = 'tree-row';
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.checked = folder.show;
    toggle.addEventListener('change', () => {
      // Hiding a folder hides everything inside it (Cesium checks parents).
      folder.show = toggle.checked;
      viewer.scene.requestRender();
    });
    const name = document.createElement('span');
    name.textContent = `📁 ${folder.name ?? 'Folder'}`;
    name.title = `${countFeatures(folder, children).toLocaleString()} features`;
    const count = document.createElement('small');
    count.className = 'hint';
    count.textContent = countFeatures(folder, children).toLocaleString();
    const go = document.createElement('button');
    go.textContent = 'Go';
    go.title = 'Fly to this folder';
    go.addEventListener('click', () => {
      const leaves = (children.get(folder) ?? []).filter((c) => !isFolder(c, children));
      if (leaves.length) void viewer.flyTo(leaves);
    });
    row.append(toggle, name, count, go);
    li.append(row);
    const sub = folderTree(viewer, folder, children, roots);
    if (sub) li.append(sub);
    ul.append(li);
  }
  return ul;
}

function listItem(viewer: Viewer, ds: DataSource, label: string, onKeep?: () => Promise<void>): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'tree-node';
  const row = document.createElement('div');
  row.className = 'tree-row';
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
    removed.get(li)?.();
  });
  row.append(toggle, name, go);
  if (onKeep) {
    const keep = document.createElement('button');
    keep.textContent = 'Keep';
    keep.title = 'Keep this file in My Places, so it opens again next time';
    keep.addEventListener('click', async () => {
      keep.disabled = true;
      await onKeep();
      keep.remove();
    });
    row.append(keep);
  }
  row.append(remove);
  li.append(row);

  // The file's own folders (KML), skipping the single Document wrapper most files have.
  const children = new Map<Entity, Entity[]>();
  const roots: Entity[] = [];
  for (const e of ds.entities.values) {
    if (e.parent) children.set(e.parent, [...(children.get(e.parent) ?? []), e]);
    else roots.push(e);
  }
  const top = roots.length === 1 && isFolder(roots[0], children) ? (children.get(roots[0]) ?? []) : roots;
  const tree = folderTree(viewer, undefined, children, top);
  if (tree) li.append(tree);
  return li;
}

/** Cleanup to run when a list item's × is pressed (e.g. forgetting a kept file). */
const removed = new WeakMap<HTMLLIElement, () => void>();
