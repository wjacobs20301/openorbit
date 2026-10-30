import {
  CallbackProperty,
  Cartesian2,
  Cartesian3,
  Color,
  CustomDataSource,
  HeightReference,
  LabelStyle,
  PolygonHierarchy,
  VerticalOrigin,
  type Cartographic,
  type Entity,
  type Viewer,
} from 'cesium';
import { centroid, formatArea, formatDistance, pathLength, polygonArea, toLonLat, type LonLat } from './geometry';
import { loadSetting, saveTextFile, storeSetting } from './platform';

export type FeatureKind = 'point' | 'line' | 'polygon';

/** Something the user saved: a placemark, a path or a polygon. */
export interface Feature {
  id: string;
  name: string;
  kind: FeatureKind;
  coords: LonLat[];
  /** CSS hex colour, e.g. #ffcc33. */
  color: string;
  description?: string;
  /** Line width in pixels (paths and polygon outlines). */
  width?: number;
  /** Polygon fill opacity, 0–1. */
  fillOpacity?: number;
  /** Folder id in My Places, or none for the top level. */
  folder?: string;
  /** Unticked in the Places list. */
  hidden?: boolean;
}

export interface Folder {
  id: string;
  name: string;
  hidden?: boolean;
  collapsed?: boolean;
}

const STORAGE_KEY = 'features';
const FOLDERS_KEY = 'folders';
export const DEFAULT_COLORS: Record<FeatureKind, string> = { point: '#ffcc33', line: '#ff5a36', polygon: '#3fa9ff' };
export const DEFAULT_WIDTH = 3;
export const DEFAULT_FILL = 0.3;
const KIND_ICONS: Record<FeatureKind, string> = { point: '●', line: '〰', polygon: '▱' };
export const KIND_NAMES: Record<FeatureKind, string> = { point: 'Placemark', line: 'Path', polygon: 'Polygon' };

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => `&#${c.charCodeAt(0)};`);
}

const escapeHtml = escapeXml;

/** KML colours are aabbggrr. */
function kmlColor(hex: string, alpha: number): string {
  const [r, g, b] = [1, 3, 5].map((i) => hex.slice(i, i + 2));
  return `${Math.round(alpha * 255).toString(16).padStart(2, '0')}${b}${g}${r}`;
}

/** Length, area or coordinates, for list tooltips, balloons and the Properties window. */
export function measure(f: Feature): string {
  if (f.kind === 'line') return formatDistance(pathLength(f.coords));
  if (f.kind === 'polygon') return `${formatArea(polygonArea(f.coords))}, perimeter ${formatDistance(pathLength(f.coords, true))}`;
  return `${f.coords[0][1].toFixed(6)}, ${f.coords[0][0].toFixed(6)}`;
}

function placemarkKml(f: Feature, indent: string): string {
  const coords = (pts: LonLat[]) => pts.map(([lon, lat]) => `${lon},${lat},0`).join(' ');
  const width = f.width ?? DEFAULT_WIDTH;
  const geometry =
    f.kind === 'point'
      ? `<Point><coordinates>${coords(f.coords)}</coordinates></Point>`
      : f.kind === 'line'
        ? `<LineString><tessellate>1</tessellate><coordinates>${coords(f.coords)}</coordinates></LineString>`
        : `<Polygon><tessellate>1</tessellate><outerBoundaryIs><LinearRing><coordinates>${coords([...f.coords, f.coords[0]])}</coordinates></LinearRing></outerBoundaryIs></Polygon>`;
  return `${indent}<Placemark>
${indent}  <name>${escapeXml(f.name)}</name>
${indent}  <visibility>${f.hidden ? 0 : 1}</visibility>
${indent}  <description>${escapeXml(f.description ?? '')}</description>
${indent}  <Style>
${indent}    <IconStyle><color>${kmlColor(f.color, 1)}</color></IconStyle>
${indent}    <LineStyle><color>${kmlColor(f.color, 1)}</color><width>${width}</width></LineStyle>
${indent}    <PolyStyle><color>${kmlColor(f.color, f.fillOpacity ?? DEFAULT_FILL)}</color></PolyStyle>
${indent}  </Style>
${indent}  ${geometry}
${indent}</Placemark>`;
}

/** My Places as KML, with folders, descriptions and styles; `extra` is appended (e.g. overlays). */
export function toKml(features: Feature[], folders: Folder[] = [], extra = ''): string {
  const loose = features.filter((f) => !folders.some((d) => d.id === f.folder));
  const parts = [
    ...folders.map(
      (d) => `    <Folder>
      <name>${escapeXml(d.name)}</name>
      <visibility>${d.hidden ? 0 : 1}</visibility>
${features
  .filter((f) => f.folder === d.id)
  .map((f) => placemarkKml(f, '      '))
  .join('\n')}
    </Folder>`,
    ),
    ...loose.map((f) => placemarkKml(f, '    ')),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>My Places</name>
${parts.join('\n')}
${extra}
  </Document>
</kml>
`;
}

/**
 * My Places: the user's placemarks, paths and polygons, optionally in folders. Kept in
 * local storage, drawn on the globe, and listed in the Places panel.
 */
export class Places {
  private readonly source = new CustomDataSource('My places');
  private features: Feature[] = [];
  private folders: Folder[] = [];
  private readonly list = document.querySelector<HTMLUListElement>('#placemark-list')!;
  /** Called with a path's name and points when its 📈 button is clicked. */
  onProfile?: (name: string, positions: Cartesian3[]) => void;
  /** Called with a path's name and points when its ▶ (fly along) button is clicked. */
  onFlyAlong?: (name: string, positions: Cartesian3[]) => void;
  /** Replaces the plain KML export (used to save a KMZ when there are image overlays). */
  onExport?: () => Promise<void>;
  /** Called to open the Properties window for a feature. */
  onEdit?: (id: string) => void;

  constructor(private readonly viewer: Viewer) {
    viewer.dataSources.add(this.source);
    this.features = this.read<Feature>(STORAGE_KEY);
    this.folders = this.read<Folder>(FOLDERS_KEY);
    this.features.forEach((f) => this.addEntity(f));
    this.render();

    document.querySelector('#kml-export')!.addEventListener('click', () => void this.exportKml());
    document.querySelector('#new-folder')!.addEventListener('click', () => this.addFolder());
    // Dropping on "My Places" itself takes an item out of its folder.
    const root = document.querySelector<HTMLElement>('#my-places-root')!;
    this.dropTarget(root, undefined);
  }

  /** Saves My Places as a KML file (File > Save, or the Places panel button). */
  exportKml(): Promise<void> {
    if (this.onExport) return this.onExport();
    return saveTextFile('My Places.kml', toKml(this.features, this.folders));
  }

  /** My Places as KML text, with `extra` KML (such as image overlays) added at the end. */
  kml(extra = ''): string {
    return toKml(this.features, this.folders, extra);
  }

  addPoint(at: Cartographic): string {
    return this.addFeature('point', [toLonLat(at)]);
  }

  addShape(kind: 'line' | 'polygon', coords: LonLat[]): string {
    return this.addFeature(kind, coords);
  }

  get(id: string): Feature | undefined {
    return this.features.find((f) => f.id === id);
  }

  entity(id: string): Entity | undefined {
    return this.source.entities.getById(id);
  }

  allFolders(): readonly Folder[] {
    return this.folders;
  }

  /** Redraws a feature after it changed; `save` also stores it and refreshes the list. */
  update(f: Feature, save = true): void {
    this.source.entities.removeById(f.id);
    this.addEntity(f);
    if (save) {
      this.persist();
      this.render();
    }
  }

  /** Replaces a feature's contents (used by Cancel in the Properties window). */
  restore(snapshot: Feature): void {
    const i = this.features.findIndex((f) => f.id === snapshot.id);
    if (i < 0) return;
    this.features[i] = snapshot;
    this.update(snapshot);
  }

  remove(id: string): void {
    this.features = this.features.filter((x) => x.id !== id);
    this.source.entities.removeById(id);
    this.persist();
    this.render();
  }

  /**
   * Makes a feature's geometry follow its coordinates live (for dragging handles),
   * without rebuilding the entity on every mouse move.
   */
  makeLive(f: Feature): void {
    const entity = this.entity(f.id);
    if (!entity) return;
    const positions = () => f.coords.map(([lon, lat]) => Cartesian3.fromDegrees(lon, lat));
    if (f.kind === 'point') {
      entity.position = new CallbackProperty(() => positions()[0], false) as never;
      return;
    }
    if (entity.polyline) {
      entity.polyline.positions = new CallbackProperty(() => {
        const p = positions();
        return f.kind === 'polygon' ? [...p, p[0]] : p;
      }, false) as never;
    }
    if (entity.polygon) {
      entity.polygon.hierarchy = new CallbackProperty(() => new PolygonHierarchy(positions()), false) as never;
    }
    entity.position = new CallbackProperty(() => {
      const anchor = f.kind === 'line' ? f.coords[Math.floor(f.coords.length / 2)] : centroid(f.coords);
      return Cartesian3.fromDegrees(...anchor);
    }, false) as never;
  }

  private addFeature(kind: FeatureKind, coords: LonLat[]): string {
    const count = this.features.filter((f) => f.kind === kind).length + 1;
    const f: Feature = { id: crypto.randomUUID(), name: `${KIND_NAMES[kind]} ${count}`, kind, coords, color: DEFAULT_COLORS[kind] };
    this.features.push(f);
    this.addEntity(f);
    this.persist();
    this.render();
    return f.id;
  }

  private addFolder(): void {
    const folder: Folder = { id: crypto.randomUUID(), name: `Folder ${this.folders.length + 1}` };
    this.folders.push(folder);
    this.persist();
    this.render();
    // Start renaming it straight away.
    this.list.querySelector<HTMLElement>(`[data-folder="${folder.id}"] .tree-name`)?.dispatchEvent(new MouseEvent('dblclick'));
  }

  private read<T>(key: string): T[] {
    try {
      return JSON.parse(loadSetting(key) || '[]');
    } catch {
      return [];
    }
  }

  private isShown(f: Feature): boolean {
    const folder = this.folders.find((d) => d.id === f.folder);
    return !f.hidden && !folder?.hidden;
  }

  private addEntity(f: Feature): Entity {
    const color = Color.fromCssColorString(f.color);
    const positions = f.coords.map(([lon, lat]) => Cartesian3.fromDegrees(lon, lat));
    const anchor = f.kind === 'line' ? f.coords[Math.floor(f.coords.length / 2)] : centroid(f.coords);
    const notes = f.description ? `<p>${escapeHtml(f.description).replace(/\n/g, '<br>')}</p>` : '';

    return this.source.entities.add({
      id: f.id,
      name: f.name,
      show: this.isShown(f),
      description: `${notes}<p style="color:#5f6b7a">${escapeHtml(measure(f))}</p>`,
      position: Cartesian3.fromDegrees(...anchor),
      point:
        f.kind === 'point'
          ? {
              pixelSize: 11,
              color,
              outlineColor: Color.BLACK,
              outlineWidth: 1.5,
              heightReference: HeightReference.CLAMP_TO_GROUND,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            }
          : undefined,
      polyline:
        f.kind === 'point'
          ? undefined
          : {
              positions: f.kind === 'polygon' ? [...positions, positions[0]] : positions,
              width: f.width ?? DEFAULT_WIDTH,
              material: color,
              clampToGround: true,
            },
      polygon:
        f.kind === 'polygon'
          ? { hierarchy: new PolygonHierarchy(positions), material: color.withAlpha(f.fillOpacity ?? DEFAULT_FILL) }
          : undefined,
      label: {
        text: f.name,
        font: '14px system-ui, sans-serif',
        style: LabelStyle.FILL_AND_OUTLINE,
        outlineWidth: 3,
        outlineColor: Color.BLACK,
        verticalOrigin: VerticalOrigin.BOTTOM,
        pixelOffset: new Cartesian2(0, f.kind === 'point' ? -12 : 0),
        heightReference: HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
  }

  private persist(): void {
    storeSetting(STORAGE_KEY, JSON.stringify(this.features));
    storeSetting(FOLDERS_KEY, JSON.stringify(this.folders));
  }

  private refreshShown(): void {
    for (const f of this.features) {
      const entity = this.entity(f.id);
      if (entity) entity.show = this.isShown(f);
    }
    this.viewer.scene.requestRender();
  }

  /** Lets items be dragged onto `el` to move them into `folder` (or out of folders). */
  private dropTarget(el: HTMLElement, folder: string | undefined): void {
    el.addEventListener('dragover', (e) => {
      if (!e.dataTransfer?.types.includes('application/x-openorbit-place')) return;
      e.preventDefault();
      el.classList.add('drop-here');
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop-here'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('drop-here');
      const f = this.get(e.dataTransfer!.getData('application/x-openorbit-place'));
      if (!f || f.folder === folder) return;
      f.folder = folder;
      this.update(f);
    });
  }

  private render(): void {
    this.list.innerHTML = '';
    if (!this.features.length && !this.folders.length) {
      this.list.innerHTML = '<li class="hint">Use Add Placemark, Polygon or Path in the toolbar.</li>';
      return;
    }
    for (const folder of this.folders) this.list.append(this.folderRow(folder));
    for (const f of this.features.filter((x) => !this.folders.some((d) => d.id === x.folder))) {
      this.list.append(this.featureRow(f));
    }
  }

  private folderRow(folder: Folder): HTMLLIElement {
    const li = document.createElement('li');
    li.className = 'tree-node';
    li.dataset.folder = folder.id;
    const row = document.createElement('div');
    row.className = 'tree-row';

    const twisty = button(folder.collapsed ? '▸' : '▾', folder.collapsed ? 'Expand' : 'Collapse', () => {
      folder.collapsed = !folder.collapsed;
      this.persist();
      this.render();
    });
    twisty.className = 'twisty';
    const visible = document.createElement('input');
    visible.type = 'checkbox';
    visible.checked = !folder.hidden;
    visible.title = 'Show everything in this folder';
    visible.addEventListener('change', () => {
      folder.hidden = !visible.checked;
      this.persist();
      this.refreshShown();
    });
    const name = document.createElement('span');
    name.className = 'tree-name';
    name.textContent = `📁 ${folder.name}`;
    name.title = 'Double-click to rename';
    name.addEventListener('dblclick', () => renameInPlace(name, folder.name, (text) => {
      folder.name = text;
      this.persist();
      this.render();
    }));
    const remove = button('×', 'Delete folder (its places move up to My Places)', () => {
      for (const f of this.features) if (f.folder === folder.id) f.folder = undefined;
      this.folders = this.folders.filter((d) => d.id !== folder.id);
      this.persist();
      this.refreshShown();
      this.render();
    });
    row.append(twisty, visible, name, remove);
    li.append(row);
    this.dropTarget(row, folder.id);

    if (!folder.collapsed) {
      const ul = document.createElement('ul');
      ul.className = 'list tree-children';
      const items = this.features.filter((f) => f.folder === folder.id);
      if (!items.length) ul.innerHTML = '<li class="hint">Drag places here</li>';
      items.forEach((f) => ul.append(this.featureRow(f)));
      li.append(ul);
    }
    return li;
  }

  private featureRow(f: Feature): HTMLLIElement {
    const li = document.createElement('li');
    li.dataset.id = f.id;
    li.title = measure(f);
    li.draggable = true;
    li.addEventListener('dragstart', (e) => {
      e.dataTransfer!.setData('application/x-openorbit-place', f.id);
      e.dataTransfer!.effectAllowed = 'move';
    });

    const visible = document.createElement('input');
    visible.type = 'checkbox';
    visible.checked = !f.hidden;
    visible.title = 'Show on the map';
    visible.addEventListener('change', () => {
      f.hidden = !visible.checked;
      this.entity(f.id)!.show = this.isShown(f);
      this.persist();
    });

    const icon = document.createElement('span');
    icon.className = 'kind-icon';
    icon.textContent = KIND_ICONS[f.kind];
    icon.style.color = f.color;

    const name = document.createElement('span');
    name.className = 'tree-name';
    name.textContent = f.name;
    name.addEventListener('dblclick', () => this.onEdit?.(f.id));

    const go = button('Go', 'Fly here', () => {
      if (f.kind === 'point') {
        this.viewer.camera.flyTo({ destination: Cartesian3.fromDegrees(...f.coords[0], 2500) });
      } else {
        void this.viewer.flyTo(this.entity(f.id)!);
      }
    });
    const edit = button('✎', 'Properties (edit name, style, shape)', () => this.onEdit?.(f.id));
    li.append(visible, icon, name, go, edit);
    if (f.kind === 'line') {
      const positions = () => f.coords.map(([lon, lat]) => Cartesian3.fromDegrees(lon, lat));
      li.append(
        button('▶', 'Fly along this path (makes a tour)', () => this.onFlyAlong?.(f.name, positions())),
        button('📈', 'Show elevation profile', () => this.onProfile?.(f.name, positions())),
      );
    }
    li.append(button('×', `Delete ${KIND_NAMES[f.kind].toLowerCase()}`, () => this.remove(f.id)));
    return li;
  }
}

/** Swaps a label for a text box until Enter/blur, then calls `done` with the new text. */
function renameInPlace(label: HTMLElement, current: string, done: (text: string) => void): void {
  const input = document.createElement('input');
  input.type = 'text';
  input.value = current;
  label.replaceWith(input);
  input.select();
  let finished = false;
  const finish = (save: boolean) => {
    if (finished) return;
    finished = true;
    const text = input.value.trim();
    if (save && text) done(text);
    else input.replaceWith(label);
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

function button(text: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = text;
  b.title = title;
  b.addEventListener('click', onClick);
  return b;
}
