import {
  CallbackProperty,
  Cartesian2,
  Cartesian3,
  Cartographic,
  Color,
  CustomDataSource,
  HeightReference,
  ImageMaterialProperty,
  Math as CesiumMath,
  Rectangle,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  type Entity,
  type Viewer,
} from 'cesium';
import { idb, STORES } from './idb';
import { loadSetting, storeSetting, unlockCameraSoon } from './platform';
import { showUndo } from './toast';

/**
 * A picture draped on the ground (KML GroundOverlay). Stored as an unrotated box
 * (degrees) plus a rotation about its centre, counter-clockwise in degrees, as KML does.
 */
export interface ImageOverlay {
  id: string;
  name: string;
  description?: string;
  west: number;
  south: number;
  east: number;
  north: number;
  rotation: number;
  /** 0–1. */
  opacity: number;
  hidden?: boolean;
  /** Image type, e.g. image/png, for the file extension when exporting. */
  type: string;
}

const STORAGE_KEY = 'imageOverlays';
const M_PER_DEG_LAT = 110_540;
const mPerDegLon = (lat: number) => 111_320 * Math.cos(CesiumMath.toRadians(lat));

/** Corners of the (rotated) overlay as [lon, lat], counter-clockwise from south-west. */
function corners(o: ImageOverlay): [number, number][] {
  const cLon = (o.west + o.east) / 2;
  const cLat = (o.south + o.north) / 2;
  const hw = ((o.east - o.west) / 2) * mPerDegLon(cLat);
  const hh = ((o.north - o.south) / 2) * M_PER_DEG_LAT;
  const r = CesiumMath.toRadians(o.rotation);
  return [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ].map(([x, y]) => {
    const rx = x * Math.cos(r) - y * Math.sin(r);
    const ry = x * Math.sin(r) + y * Math.cos(r);
    return [cLon + rx / mPerDegLon(cLat), cLat + ry / M_PER_DEG_LAT];
  });
}

/**
 * Image overlays (Add Image Overlay in Google Earth): pictures such as site plans or
 * scanned maps draped on the terrain. While one is being edited it can be moved,
 * stretched by its corners, rotated and made see-through. Pictures live in IndexedDB.
 */
export class ImageOverlays {
  private overlays: ImageOverlay[] = [];
  private readonly urls = new Map<string, string>();
  /** Decoded pictures, for drawing them rotated. */
  private readonly images = new Map<string, HTMLImageElement>();
  /** The picture and opacity currently applied to each overlay's material. */
  private readonly materials = new Map<string, { image: unknown; opacity: number }>();
  /** Last rotated rendering per overlay, reused until the angle or proportions change. */
  private readonly renders = new Map<string, { key: string; canvas: HTMLCanvasElement; rect: Rectangle }>();
  private readonly source = new CustomDataSource('Image overlays');
  private readonly handles = new CustomDataSource('Overlay handles');
  private readonly list = document.querySelector<HTMLUListElement>('#overlay-list')!;
  private readonly panel = document.createElement('section');
  private editing?: ImageOverlay;
  private snapshot?: ImageOverlay;
  private isNew = false;
  private grab: { kind: 'corner'; index: number } | { kind: 'move'; from: [number, number] } | { kind: 'rotate' } | null = null;
  private readonly picker = document.createElement('input');

  constructor(private readonly viewer: Viewer) {
    viewer.dataSources.add(this.source);
    viewer.dataSources.add(this.handles);
    this.panel.id = 'overlay-panel';
    this.panel.className = 'edit-window';
    this.panel.hidden = true;
    document.querySelector('#globe')!.append(this.panel);

    this.picker.type = 'file';
    this.picker.accept = 'image/png,image/jpeg,image/gif,image/webp';
    this.picker.addEventListener('change', () => {
      const file = this.picker.files?.[0];
      this.picker.value = '';
      if (file) void this.add(file);
    });

    try {
      this.overlays = JSON.parse(loadSetting(STORAGE_KEY) || '[]');
    } catch {
      this.overlays = [];
    }
    void this.loadImages();

    const events = new ScreenSpaceEventHandler(viewer.scene.canvas);
    events.setInputAction((e: ScreenSpaceEventHandler.PositionedEvent) => this.down(e.position), ScreenSpaceEventType.LEFT_DOWN);
    events.setInputAction((e: ScreenSpaceEventHandler.MotionEvent) => this.move(e.endPosition), ScreenSpaceEventType.MOUSE_MOVE);
    events.setInputAction(() => this.up(), ScreenSpaceEventType.LEFT_UP);
  }

  get active(): boolean {
    return !!this.editing;
  }

  get count(): number {
    return this.overlays.length;
  }

  get(id: string): ImageOverlay | undefined {
    return this.overlays.find((o) => o.id === id);
  }

  /** Asks for a picture, then drapes it over the middle of the current view. */
  choose(): void {
    this.picker.click();
  }

  /** The overlays and their pictures, for KMZ export. */
  async exportable(): Promise<{ overlay: ImageOverlay; image: Blob }[]> {
    const out: { overlay: ImageOverlay; image: Blob }[] = [];
    for (const overlay of this.overlays) {
      const image = await idb<Blob | undefined>(STORES.overlayImages, 'readonly', (s) => s.get(overlay.id));
      if (image) out.push({ overlay, image });
    }
    return out;
  }

  private async loadImages(): Promise<void> {
    for (const o of this.overlays) {
      const blob = await idb<Blob | undefined>(STORES.overlayImages, 'readonly', (s) => s.get(o.id)).catch(() => undefined);
      if (blob) {
        const url = URL.createObjectURL(blob);
        this.urls.set(o.id, url);
        await this.decode(o.id, url).catch(() => undefined);
        this.draw(o);
      }
    }
    this.render();
  }

  /** Adds a picture file as a new overlay over the current view (also used for drops). */
  async add(file: File): Promise<void> {
    const url = URL.createObjectURL(file);
    const { width, height } = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = url;
    });

    // Cover about 60% of the view's width at the picture's own proportions.
    const view = this.viewer.camera.computeViewRectangle() ?? Rectangle.fromDegrees(-10, -10, 10, 10);
    const cLon = CesiumMath.toDegrees((view.west + view.east) / 2);
    const cLat = CesiumMath.toDegrees((view.south + view.north) / 2);
    const viewWidth = CesiumMath.toDegrees(view.east - view.west) * mPerDegLon(cLat);
    const hw = (viewWidth * 0.6) / 2;
    const hh = (hw * height) / width;
    const o: ImageOverlay = {
      id: crypto.randomUUID(),
      name: file.name.replace(/\.[^.]+$/, ''),
      west: cLon - hw / mPerDegLon(cLat),
      east: cLon + hw / mPerDegLon(cLat),
      south: cLat - hh / M_PER_DEG_LAT,
      north: cLat + hh / M_PER_DEG_LAT,
      rotation: 0,
      opacity: 0.8,
      type: file.type || 'image/png',
    };
    await idb(STORES.overlayImages, 'readwrite', (s) => s.put(file, o.id));
    this.overlays.push(o);
    this.urls.set(o.id, url);
    await this.decode(o.id, url);
    this.draw(o);
    this.persist();
    this.render();
    this.edit(o.id, true);
  }

  private persist(): void {
    storeSetting(STORAGE_KEY, JSON.stringify(this.overlays));
  }

  /**
   * The picture turned by the overlay's rotation onto an upright canvas covering the
   * rotated corners' bounding box, plus that box. Cached until angle or shape change.
   */
  private rendered(o: ImageOverlay): { canvas: HTMLCanvasElement; rect: Rectangle } | undefined {
    const img = this.images.get(o.id);
    if (!img) return undefined;
    const pts = corners(o);
    const lons = pts.map((p) => p[0]);
    const lats = pts.map((p) => p[1]);
    const rect = Rectangle.fromDegrees(Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats));
    const cLat = (o.south + o.north) / 2;
    const w = (o.east - o.west) * mPerDegLon(cLat);
    const h = (o.north - o.south) * M_PER_DEG_LAT;
    const key = `${o.rotation.toFixed(2)}|${(w / h).toFixed(4)}`;
    const cached = this.renders.get(o.id);
    if (cached?.key === key) return { canvas: cached.canvas, rect };

    const r = CesiumMath.toRadians(o.rotation);
    const bw = Math.abs(w * Math.cos(r)) + Math.abs(h * Math.sin(r));
    const bh = Math.abs(w * Math.sin(r)) + Math.abs(h * Math.cos(r));
    // Keep the picture's own detail, within a texture size every GPU handles.
    const scale = Math.min(img.naturalWidth / w, 4096 / Math.max(bw, bh));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bw * scale));
    canvas.height = Math.max(1, Math.round(bh * scale));
    const ctx = canvas.getContext('2d')!;
    ctx.translate(canvas.width / 2, canvas.height / 2);
    // Canvas turns clockwise; KML's angle is counter-clockwise.
    ctx.rotate(-r);
    ctx.drawImage(img, (-w * scale) / 2, (-h * scale) / 2, w * scale, h * scale);
    this.renders.set(o.id, { key, canvas, rect });
    return { canvas, rect };
  }

  private async decode(id: string, url: string): Promise<void> {
    const img = new Image();
    img.src = url;
    await img.decode();
    this.images.set(id, img);
  }

  /**
   * Sets the overlay's picture and opacity. Draped geometry can't take a picture that
   * changes every frame, so a new fixed material is swapped in only when it changes.
   */
  private refreshMaterial(o: ImageOverlay): void {
    const entity = this.source.entities.getById(o.id);
    if (!entity?.rectangle) return;
    const image = this.rendered(o)?.canvas ?? this.urls.get(o.id);
    const applied = this.materials.get(o.id);
    if (applied && applied.image === image && applied.opacity === o.opacity) return;
    entity.rectangle.material = new ImageMaterialProperty({
      image,
      transparent: true,
      color: Color.WHITE.withAlpha(o.opacity),
    }) as never;
    this.materials.set(o.id, { image, opacity: o.opacity });
    this.viewer.scene.requestRender();
  }

  /** (Re)draws an overlay; `live` makes it follow edits without rebuilding. */
  private draw(o: ImageOverlay, live = false): Entity | undefined {
    this.source.entities.removeById(o.id);
    this.materials.delete(o.id);
    if (!this.urls.get(o.id)) return undefined;
    // Draped as an upright rectangle around the rotated picture: the picture is drawn
    // turned onto a canvas with transparent corners. (Rotated shapes draped on terrain
    // get clipped or have their textures stretched to the bounding box.)
    // While dragging (`live`) it's a flat preview at ground height instead: draped
    // shapes that change every frame map their picture wrongly.
    const value = <T>(fn: () => T) => (live ? new CallbackProperty(fn, false) : fn());
    const ground = live
      ? (this.viewer.scene.globe.getHeight(Cartographic.fromDegrees((o.west + o.east) / 2, (o.south + o.north) / 2)) ?? 0) + 1
      : undefined;
    const entity = this.source.entities.add({
      id: o.id,
      name: o.name,
      show: !o.hidden,
      description: o.description ? `<p>${o.description.replace(/[<>&]/g, (c) => `&#${c.charCodeAt(0)};`)}</p>` : '',
      rectangle: {
        coordinates: value(() => this.rendered(o)?.rect ?? Rectangle.fromDegrees(o.west, o.south, o.east, o.north)) as never,
        height: ground,
      },
    });
    this.refreshMaterial(o);
    this.viewer.scene.requestRender();
    return entity;
  }

  // ---- Places list

  private render(): void {
    this.list.innerHTML = '';
    for (const o of this.overlays) {
      const li = document.createElement('li');
      const visible = document.createElement('input');
      visible.type = 'checkbox';
      visible.checked = !o.hidden;
      visible.title = 'Show on the map';
      visible.addEventListener('change', () => {
        o.hidden = !visible.checked;
        const e = this.source.entities.getById(o.id);
        if (e) e.show = visible.checked;
        this.persist();
        this.viewer.scene.requestRender();
      });
      const icon = document.createElement('span');
      icon.className = 'kind-icon';
      icon.textContent = '🖼';
      const name = document.createElement('span');
      name.className = 'tree-name';
      name.textContent = o.name;
      name.title = 'Image overlay · double-click to edit';
      name.addEventListener('dblclick', () => this.edit(o.id));
      const go = this.button('Go', 'Fly here', () => {
        const e = this.source.entities.getById(o.id);
        if (e) void this.viewer.flyTo(e);
      });
      const edit = this.button('✎', 'Edit: move, stretch, rotate, opacity', () => this.edit(o.id));
      const remove = this.button('×', 'Delete image overlay', () => void this.remove(o.id));
      li.append(visible, icon, name, go, edit, remove);
      this.list.append(li);
    }
  }

  private button(text: string, title: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.textContent = text;
    b.title = title;
    b.addEventListener('click', onClick);
    return b;
  }

  /** Deletes an overlay, offering Undo unless `quiet` (e.g. cancelling a new one). */
  private async remove(id: string, quiet = false): Promise<void> {
    if (this.editing?.id === id) this.close(false);
    const index = this.overlays.findIndex((o) => o.id === id);
    const overlay = this.overlays[index];
    // Keep the picture in memory so Undo can put it back.
    const image = quiet ? undefined : await idb<Blob | undefined>(STORES.overlayImages, 'readonly', (s) => s.get(id)).catch(() => undefined);
    this.overlays = this.overlays.filter((o) => o.id !== id);
    this.source.entities.removeById(id);
    const url = this.urls.get(id);
    if (url) URL.revokeObjectURL(url);
    this.urls.delete(id);
    this.images.delete(id);
    this.renders.delete(id);
    await idb(STORES.overlayImages, 'readwrite', (s) => s.delete(id)).catch(() => undefined);
    this.persist();
    this.render();
    this.viewer.scene.requestRender();
    if (overlay && image) {
      showUndo(`Deleted ${overlay.name}`, () => void this.restore(overlay, image, index));
    }
  }

  private async restore(overlay: ImageOverlay, image: Blob, index: number): Promise<void> {
    await idb(STORES.overlayImages, 'readwrite', (s) => s.put(image, overlay.id));
    this.overlays.splice(Math.min(index, this.overlays.length), 0, overlay);
    const url = URL.createObjectURL(image);
    this.urls.set(overlay.id, url);
    await this.decode(overlay.id, url).catch(() => undefined);
    this.draw(overlay);
    this.persist();
    this.render();
  }

  // ---- Editing

  edit(id: string, isNew = false): void {
    const o = this.get(id);
    if (!o) return;
    if (this.editing) this.close(true);
    this.editing = o;
    this.snapshot = { ...o };
    this.isNew = isNew;
    this.draw(o);
    this.buildHandles();
    this.buildPanel(o);
  }

  close(save: boolean): void {
    const o = this.editing;
    if (!o) return;
    if (!save && this.isNew) {
      this.editing = undefined;
      void this.remove(o.id, true);
    } else {
      if (!save) Object.assign(o, this.snapshot);
      this.draw(o);
      this.persist();
      this.render();
    }
    this.editing = this.snapshot = undefined;
    this.grab = null;
    this.viewer.scene.screenSpaceCameraController.enableInputs = true;
    this.handles.entities.removeAll();
    this.panel.hidden = true;
    this.viewer.scene.requestRender();
  }

  private buildPanel(o: ImageOverlay): void {
    const field = (label: string, input: HTMLElement) => {
      const l = document.createElement('label');
      l.className = 'field';
      l.append(label, input);
      return l;
    };
    this.panel.innerHTML = '<h3>Edit Image Overlay</h3>';
    const name = document.createElement('input');
    name.value = o.name;
    name.addEventListener('input', () => (o.name = name.value.trim() || o.name));
    const description = document.createElement('textarea');
    description.rows = 2;
    description.value = o.description ?? '';
    description.addEventListener('input', () => (o.description = description.value || undefined));
    const opacity = document.createElement('input');
    opacity.type = 'range';
    opacity.min = '0';
    opacity.max = '100';
    opacity.value = String(Math.round(o.opacity * 100));
    opacity.addEventListener('input', () => {
      o.opacity = Number(opacity.value) / 100;
      this.refreshMaterial(o);
    });
    const rotation = document.createElement('input');
    rotation.type = 'number';
    rotation.step = '0.5';
    rotation.className = 'overlay-rotation';
    rotation.value = o.rotation.toFixed(1);
    rotation.addEventListener('input', () => {
      const v = Number(rotation.value);
      if (Number.isFinite(v)) o.rotation = v;
      this.draw(o);
    });
    const tip = document.createElement('p');
    tip.className = 'hint';
    tip.textContent = 'Drag the corners to stretch, the centre to move, and the round handle to rotate.';
    const actions = document.createElement('div');
    actions.className = 'row end';
    const cancel = this.button('Cancel', 'Undo changes', () => this.close(false));
    const ok = this.button('OK', 'Keep changes', () => this.close(true));
    ok.className = 'primary';
    actions.append(cancel, ok);
    const style = document.createElement('div');
    style.className = 'row';
    style.append(field('Opacity', opacity), field('Rotation (°)', rotation));
    this.panel.append(field('Name', name), field('Description', description), style, tip, actions);
    this.panel.hidden = false;
    name.select();
  }

  private buildHandles(): void {
    const o = this.editing!;
    this.handles.entities.removeAll();
    const common = { heightReference: HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY };
    const at = (fn: () => [number, number]) => new CallbackProperty(() => Cartesian3.fromDegrees(...fn()), false);
    for (let i = 0; i < 4; i++) {
      this.handles.entities.add({
        id: `ov:c${i}`,
        position: at(() => corners(o)[i]) as never,
        point: { ...common, pixelSize: 13, color: Color.fromCssColorString('#3ddc84'), outlineColor: Color.BLACK, outlineWidth: 1.5 },
      });
    }
    this.handles.entities.add({
      id: 'ov:move',
      position: at(() => [(o.west + o.east) / 2, (o.south + o.north) / 2]) as never,
      point: { ...common, pixelSize: 15, color: Color.WHITE.withAlpha(0.9), outlineColor: Color.fromCssColorString('#3ddc84'), outlineWidth: 3 },
    });
    // Rotation handle: just beyond the middle of the top edge.
    this.handles.entities.add({
      id: 'ov:rotate',
      position: at(() => {
        const [, , ne, nw] = corners(o);
        const c = [(o.west + o.east) / 2, (o.south + o.north) / 2];
        const top = [(ne[0] + nw[0]) / 2, (ne[1] + nw[1]) / 2];
        return [top[0] + (top[0] - c[0]) * 0.25, top[1] + (top[1] - c[1]) * 0.25];
      }) as never,
      point: { ...common, pixelSize: 13, color: Color.fromCssColorString('#ffcc33'), outlineColor: Color.BLACK, outlineWidth: 1.5 },
    });
    this.viewer.scene.requestRender();
  }

  private groundAt(position: Cartesian2): [number, number] | undefined {
    const ray = this.viewer.camera.getPickRay(position);
    const hit = ray && this.viewer.scene.globe.pick(ray, this.viewer.scene);
    if (!hit) return undefined;
    const c = Cartographic.fromCartesian(hit);
    return [CesiumMath.toDegrees(c.longitude), CesiumMath.toDegrees(c.latitude)];
  }

  private down(position: Cartesian2): void {
    if (!this.editing) return;
    const id = (this.viewer.scene.pick(position)?.id as { id?: string } | undefined)?.id;
    if (id?.startsWith('ov:c')) this.grab = { kind: 'corner', index: Number(id.slice(4)) };
    else if (id === 'ov:move' || id === this.editing.id) {
      // Move by how far the pointer travels, wherever the picture was grabbed.
      const from = this.groundAt(position);
      if (from) this.grab = { kind: 'move', from };
    }
    else if (id === 'ov:rotate') this.grab = { kind: 'rotate' };
    if (this.grab) {
      this.viewer.scene.screenSpaceCameraController.enableInputs = false;
      this.draw(this.editing, true);
    }
  }

  private move(position: Cartesian2): void {
    const o = this.editing;
    if (!o || !this.grab) return;
    const p = this.groundAt(position);
    if (!p) return;
    const cLon = (o.west + o.east) / 2;
    const cLat = (o.south + o.north) / 2;
    const kx = mPerDegLon(cLat);

    if (this.grab.kind === 'move') {
      const [dLon, dLat] = [p[0] - this.grab.from[0], p[1] - this.grab.from[1]];
      this.grab.from = p;
      o.west += dLon;
      o.east += dLon;
      o.south += dLat;
      o.north += dLat;
    } else if (this.grab.kind === 'rotate') {
      // The handle sits straight "up" from the centre at rotation 0.
      const angle = Math.atan2(-(p[0] - cLon) * kx, (p[1] - cLat) * M_PER_DEG_LAT);
      o.rotation = CesiumMath.toDegrees(angle);
      const box = this.panel.querySelector<HTMLInputElement>('.overlay-rotation');
      if (box) box.value = o.rotation.toFixed(1);
    } else if (this.grab.kind === 'corner') {
      // Stretch: the opposite corner stays put; work in the overlay's own (rotated) axes.
      const opposite = corners(o)[(this.grab.index + 2) % 4];
      const r = CesiumMath.toRadians(o.rotation);
      const dx = (p[0] - opposite[0]) * kx;
      const dy = (p[1] - opposite[1]) * M_PER_DEG_LAT;
      const lx = dx * Math.cos(-r) - dy * Math.sin(-r);
      const ly = dx * Math.sin(-r) + dy * Math.cos(-r);
      if (Math.abs(lx) < 2 || Math.abs(ly) < 2) return;
      const nLon = (p[0] + opposite[0]) / 2;
      const nLat = (p[1] + opposite[1]) / 2;
      const hw = Math.abs(lx) / 2 / mPerDegLon(nLat);
      const hh = Math.abs(ly) / 2 / M_PER_DEG_LAT;
      o.west = nLon - hw;
      o.east = nLon + hw;
      o.south = nLat - hh;
      o.north = nLat + hh;
    }
    this.refreshMaterial(o);
    this.viewer.scene.requestRender();
  }

  private up(): void {
    if (!this.grab) return;
    this.grab = null;
    unlockCameraSoon(this.viewer.scene.screenSpaceCameraController);
    // Back to the exact, terrain-draped version.
    if (this.editing) this.draw(this.editing);
  }
}

/** GroundOverlay KML for an overlay whose picture is stored at `href` inside a KMZ. */
export function groundOverlayKml(o: ImageOverlay, href: string): string {
  const esc = (s: string) => s.replace(/[<>&'"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const alpha = Math.round(o.opacity * 255).toString(16).padStart(2, '0');
  return `    <GroundOverlay>
      <name>${esc(o.name)}</name>
      <visibility>${o.hidden ? 0 : 1}</visibility>
      <description>${esc(o.description ?? '')}</description>
      <color>${alpha}ffffff</color>
      <Icon><href>${esc(href)}</href></Icon>
      <LatLonBox>
        <north>${o.north}</north><south>${o.south}</south><east>${o.east}</east><west>${o.west}</west>
        <rotation>${o.rotation}</rotation>
      </LatLonBox>
    </GroundOverlay>`;
}
