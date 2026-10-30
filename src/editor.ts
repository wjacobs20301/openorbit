import {
  CallbackProperty,
  Cartesian2,
  Cartesian3,
  Cartographic,
  Color,
  CustomDataSource,
  HeightReference,
  Math as CesiumMath,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  type Viewer,
} from 'cesium';
import type { LonLat } from './geometry';
import { unlockCameraSoon } from './platform';
import { DEFAULT_FILL, DEFAULT_WIDTH, KIND_NAMES, measure, type Feature, type Places } from './places';

const MIN_POINTS = { point: 1, line: 2, polygon: 3 } as const;

/** The corner being dragged. Handle ids on the map are "v:3" (corner) or "m:3" (midpoint after it). */
type Grab = { index: number };

/**
 * Google Earth–style Properties window for a placemark, path or polygon. While it's
 * open the feature can be reshaped on the map: drag the placemark or a corner handle,
 * drag a midpoint handle to add a corner, double-click a corner to remove it. OK keeps
 * the changes; Cancel (or Esc) restores how it was.
 */
export class PlaceEditor {
  private readonly panel = document.createElement('section');
  private readonly handles = new CustomDataSource('Editing handles');
  private feature?: Feature;
  private snapshot?: Feature;
  private grab: Grab | null = null;
  /** Cancel on a just-created place deletes it, as in Google Earth. */
  private isNew = false;

  constructor(
    private readonly viewer: Viewer,
    private readonly places: Places,
  ) {
    this.panel.id = 'edit-panel';
    this.panel.hidden = true;
    document.querySelector('#globe')!.append(this.panel);
    viewer.dataSources.add(this.handles);

    const events = new ScreenSpaceEventHandler(viewer.scene.canvas);
    events.setInputAction((e: ScreenSpaceEventHandler.PositionedEvent) => this.down(e.position), ScreenSpaceEventType.LEFT_DOWN);
    events.setInputAction((e: ScreenSpaceEventHandler.MotionEvent) => this.move(e.endPosition), ScreenSpaceEventType.MOUSE_MOVE);
    events.setInputAction(() => this.up(), ScreenSpaceEventType.LEFT_UP);
    events.setInputAction(
      (e: ScreenSpaceEventHandler.PositionedEvent) => this.removeCorner(e.position),
      ScreenSpaceEventType.LEFT_DOUBLE_CLICK,
    );
  }

  get active(): boolean {
    return !!this.feature;
  }

  open(id: string, isNew = false): void {
    const f = this.places.get(id);
    if (!f) return;
    if (this.feature) this.close(true);
    this.feature = f;
    this.isNew = isNew;
    this.snapshot = structuredClone(f);
    this.places.makeLive(f);
    this.buildPanel(f);
    this.buildHandles();
    this.panel.hidden = false;
    this.viewer.scene.requestRender();
  }

  /** Ends editing: `save` keeps the changes, otherwise the feature goes back to how it was. */
  close(save: boolean): void {
    const f = this.feature;
    if (!f) return;
    if (save) this.places.update(f);
    else if (this.isNew) this.places.remove(f.id);
    else this.places.restore(this.snapshot!);
    this.feature = this.snapshot = undefined;
    this.grab = null;
    this.viewer.scene.screenSpaceCameraController.enableInputs = true;
    this.handles.entities.removeAll();
    this.panel.hidden = true;
    this.viewer.scene.requestRender();
  }

  // ---- Properties window

  private buildPanel(f: Feature): void {
    const field = (label: string, input: HTMLElement) => {
      const l = document.createElement('label');
      l.className = 'field';
      l.append(label, input);
      return l;
    };
    this.panel.innerHTML = '';

    const title = document.createElement('h3');
    title.textContent = `Edit ${KIND_NAMES[f.kind]}`;

    const name = document.createElement('input');
    name.value = f.name;
    name.addEventListener('input', () => {
      f.name = name.value.trim() || f.name;
      this.redraw();
    });

    const folder = document.createElement('select');
    folder.innerHTML = '<option value="">My Places</option>';
    for (const d of this.places.allFolders()) folder.add(new Option(`📁 ${d.name}`, d.id, false, d.id === f.folder));
    folder.addEventListener('change', () => (f.folder = folder.value || undefined));

    const description = document.createElement('textarea');
    description.rows = 3;
    description.placeholder = 'Notes shown when the place is clicked';
    description.value = f.description ?? '';
    description.addEventListener('input', () => {
      f.description = description.value || undefined;
      this.redraw();
    });

    const color = document.createElement('input');
    color.type = 'color';
    color.value = f.color;
    color.addEventListener('input', () => {
      f.color = color.value;
      this.redraw();
    });
    const style = document.createElement('div');
    style.className = 'row';
    style.append(field('Colour', color));
    if (f.kind !== 'point') {
      const width = document.createElement('input');
      width.type = 'range';
      width.min = '1';
      width.max = '10';
      width.value = String(f.width ?? DEFAULT_WIDTH);
      width.addEventListener('input', () => {
        f.width = Number(width.value);
        this.redraw();
      });
      style.append(field('Line width', width));
    }
    if (f.kind === 'polygon') {
      const fill = document.createElement('input');
      fill.type = 'range';
      fill.min = '0';
      fill.max = '100';
      fill.value = String(Math.round((f.fillOpacity ?? DEFAULT_FILL) * 100));
      fill.addEventListener('input', () => {
        f.fillOpacity = Number(fill.value) / 100;
        this.redraw();
      });
      style.append(field('Fill opacity', fill));
    }

    const measurement = document.createElement('p');
    measurement.className = 'hint edit-measure';

    this.panel.append(title, field('Name', name), field('Folder', folder), field('Description', description), style);

    if (f.kind === 'point') {
      const lat = document.createElement('input');
      const lon = document.createElement('input');
      for (const [input, i] of [[lat, 1], [lon, 0]] as const) {
        input.type = 'number';
        input.step = 'any';
        input.value = f.coords[0][i].toFixed(6);
        input.addEventListener('change', () => {
          const v = Number(input.value);
          if (!Number.isFinite(v)) return;
          f.coords[0][i] = i === 1 ? CesiumMath.clamp(v, -90, 90) : CesiumMath.clamp(v, -180, 180);
          this.changed();
        });
      }
      const coords = document.createElement('div');
      coords.className = 'row';
      coords.append(field('Latitude', lat), field('Longitude', lon));
      this.panel.append(coords);
      measurement.textContent = 'Drag the placemark on the map to move it.';
    } else {
      const tip = document.createElement('p');
      tip.className = 'hint';
      tip.textContent = 'Drag the white handles to reshape · drag a small handle to add a corner · double-click a corner to remove it.';
      this.panel.append(tip);
    }
    this.panel.append(measurement);

    const actions = document.createElement('div');
    actions.className = 'row end';
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => this.close(false));
    const ok = document.createElement('button');
    ok.textContent = 'OK';
    ok.className = 'primary';
    ok.addEventListener('click', () => this.close(true));
    actions.append(cancel, ok);
    this.panel.append(actions);
    this.panel.querySelector<HTMLInputElement>('input')?.select();
    this.changed();
  }

  /** Rebuilds the feature's look (colour, width, name) and keeps it following edits. */
  private redraw(): void {
    const f = this.feature!;
    this.places.update(f, false);
    this.places.makeLive(f);
    this.viewer.scene.requestRender();
  }

  /** After the shape changed: refresh the measurement text and the redraw. */
  private changed(): void {
    const f = this.feature!;
    const text = this.panel.querySelector('.edit-measure');
    if (text && f.kind !== 'point') text.textContent = measure(f);
    if (f.kind === 'point') {
      // The boxes are laid out Latitude, Longitude.
      const [lat, lon] = this.panel.querySelectorAll<HTMLInputElement>('input[type="number"]');
      if (lat && document.activeElement !== lat) lat.value = f.coords[0][1].toFixed(6);
      if (lon && document.activeElement !== lon) lon.value = f.coords[0][0].toFixed(6);
    }
    this.viewer.scene.requestRender();
  }

  // ---- Handles on the map

  private buildHandles(): void {
    const f = this.feature!;
    this.handles.entities.removeAll();
    if (f.kind === 'point') return;
    const at = (lonlat: () => LonLat) => new CallbackProperty(() => Cartesian3.fromDegrees(...lonlat()), false);
    const common = { heightReference: HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY };
    const n = f.coords.length;
    for (let i = 0; i < n; i++) {
      this.handles.entities.add({
        id: `v:${i}`,
        position: at(() => f.coords[i]) as never,
        point: { ...common, pixelSize: 11, color: Color.WHITE, outlineColor: Color.fromCssColorString('#1a73e8'), outlineWidth: 2 },
      });
      // Midpoints between corners (and the closing edge of a polygon) add a corner.
      if (i < n - 1 || f.kind === 'polygon') {
        const j = (i + 1) % n;
        this.handles.entities.add({
          id: `m:${i}`,
          position: at(() => [(f.coords[i][0] + f.coords[j][0]) / 2, (f.coords[i][1] + f.coords[j][1]) / 2]) as never,
          point: { ...common, pixelSize: 7, color: Color.WHITE.withAlpha(0.6), outlineColor: Color.BLACK.withAlpha(0.4), outlineWidth: 1 },
        });
      }
    }
  }

  private groundAt(position: Cartesian2): LonLat | undefined {
    const ray = this.viewer.camera.getPickRay(position);
    const hit = ray && this.viewer.scene.globe.pick(ray, this.viewer.scene);
    if (!hit) return undefined;
    const c = Cartographic.fromCartesian(hit);
    return [CesiumMath.toDegrees(c.longitude), CesiumMath.toDegrees(c.latitude)];
  }

  private down(position: Cartesian2): void {
    const f = this.feature;
    if (!f) return;
    const id = (this.viewer.scene.pick(position)?.id as { id?: string } | undefined)?.id;
    if (f.kind === 'point' && id === f.id) this.grab = { index: 0 };
    else if (id?.startsWith('v:')) this.grab = { index: Number(id.slice(2)) };
    else if (id?.startsWith('m:')) {
      // Dragging a midpoint inserts a new corner there and moves it.
      const i = Number(id.slice(2));
      const j = (i + 1) % f.coords.length;
      f.coords.splice(i + 1, 0, [(f.coords[i][0] + f.coords[j][0]) / 2, (f.coords[i][1] + f.coords[j][1]) / 2]);
      this.buildHandles();
      this.grab = { index: i + 1 };
    }
    // Hold the map still while a handle is being dragged.
    if (this.grab) this.viewer.scene.screenSpaceCameraController.enableInputs = false;
  }

  private move(position: Cartesian2): void {
    const f = this.feature;
    if (!f || !this.grab) return;
    const ground = this.groundAt(position);
    if (!ground) return;
    f.coords[this.grab.index] = ground;
    this.changed();
  }

  private up(): void {
    if (!this.grab) return;
    this.grab = null;
    unlockCameraSoon(this.viewer.scene.screenSpaceCameraController);
    this.changed();
  }

  private removeCorner(position: Cartesian2): void {
    const f = this.feature;
    if (!f) return;
    const id = (this.viewer.scene.pick(position)?.id as { id?: string } | undefined)?.id;
    if (!id?.startsWith('v:') || f.coords.length <= MIN_POINTS[f.kind]) return;
    f.coords.splice(Number(id.slice(2)), 1);
    this.buildHandles();
    this.changed();
  }
}
