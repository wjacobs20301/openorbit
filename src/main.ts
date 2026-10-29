import { Math as CesiumMath, ScreenSpaceEventHandler, ScreenSpaceEventType } from 'cesium';
import { Buildings } from './buildings';
import { Drawer } from './draw';
import './style.css';
import { createGlobe, formatCoords, pickGround } from './globe';
import { Google3D } from './google3d';
import { setupHistory } from './history';
import { setupImport } from './importer';
import { KeyedImagery } from './keyedimagery';
import { Measure } from './measure';
import { setupNavControls } from './navcontrols';
import { setupOffline } from './offline';
import { PlaceLabels } from './labels';
import { addVectorOverlays } from './overlay';
import { Places } from './places';
import { clearTileCache, isDesktop, isTyping, loadSetting, storeSetting } from './platform';
import { setupSearch } from './search';
import { StreetView } from './streetview';

type Tool = 'placemark' | 'path' | 'polygon' | 'measure' | 'street' | null;

const { viewer, layers } = createGlobe('globe');

// The globe redraws only on request. Redraw after any UI interaction and whenever
// entities or data sources change; modules with their own async work request too.
const redraw = () => viewer.scene.requestRender();
for (const type of ['click', 'input', 'change', 'keydown'] as const) {
  document.addEventListener(type, () => {
    redraw();
    window.setTimeout(redraw, 150);
  });
}
viewer.entities.collectionChanged.addEventListener(redraw);
viewer.dataSources.dataSourceAdded.addEventListener((_, ds) => {
  ds.entities.collectionChanged.addEventListener(redraw);
  redraw();
});
viewer.dataSources.dataSourceRemoved.addEventListener(redraw);
const overlays = addVectorOverlays(viewer);
const labels = new PlaceLabels(viewer);
const buildings = new Buildings(viewer);
const google3d = new Google3D(viewer);
const places = new Places(viewer);
const hint = document.querySelector<HTMLParagraphElement>('#tool-hint')!;
const measure = new Measure(viewer, (summary) => (hint.textContent = summary));
const street = new StreetView(viewer);
const drawer = new Drawer(
  viewer,
  (summary) => (hint.textContent = summary),
  (kind, coords) => {
    places.addShape(kind, coords);
    setTool(null);
  },
);
setupSearch(viewer, () => (google3d.active ? loadSetting('googleKey') : null));
// Street view owns the arrow keys while it's open.
setupNavControls(viewer, () => !street.isOpen);
setupImport(viewer);
setupOffline(viewer);

// Handy for poking at the scene from devtools during development.
if (import.meta.env.DEV) Object.assign(window, { viewer });

// Tools: one active at a time; clicking the active button turns it off.
const hints: Record<Exclude<Tool, null>, string> = {
  placemark: 'Click the globe to drop a placemark.',
  path: 'Click to add points along the path.',
  polygon: 'Click to add the corners of the shape.',
  measure: 'Click points on the globe to measure. Choose Measure again to clear.',
  street: 'Click near a road to see street-level photos.',
};
let tool: Tool = null;
const toolButtons = document.querySelectorAll<HTMLButtonElement>('[data-tool]');

function setTool(next: Tool): void {
  if (tool === 'measure') measure.clear();
  drawer.cancel();
  tool = next === tool ? null : next;
  toolButtons.forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
  hint.textContent = tool ? hints[tool] : '';
  viewer.canvas.style.cursor = tool ? 'crosshair' : '';
  if (tool === 'path') drawer.start('line');
  if (tool === 'polygon') drawer.start('polygon');
}
toolButtons.forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool as Tool)));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') setTool(null);
  // Leave typing in sidebar fields alone.
  if (!drawer.kind || isTyping(e)) return;
  if (e.key === 'Enter') drawer.finish();
  if (e.key === 'Backspace') {
    e.preventDefault();
    drawer.undo();
  }
});

// Double-click finishes a drawing instead of Cesium's default zoom-to-entity.
viewer.cesiumWidget.screenSpaceEventHandler.removeInputAction(ScreenSpaceEventType.LEFT_DOUBLE_CLICK);

const handler = new ScreenSpaceEventHandler(viewer.scene.canvas);
handler.setInputAction(({ position }: ScreenSpaceEventHandler.PositionedEvent) => {
  if (!tool) return;
  const ground = pickGround(viewer, position);
  if (!ground) return;
  if (tool === 'placemark') places.addPoint(ground);
  if (tool === 'path' || tool === 'polygon') drawer.add(ground);
  if (tool === 'measure') measure.add(ground);
  if (tool === 'street') {
    void street.openAt(CesiumMath.toDegrees(ground.longitude), CesiumMath.toDegrees(ground.latitude));
  }
}, ScreenSpaceEventType.LEFT_CLICK);
handler.setInputAction(() => drawer.finish(), ScreenSpaceEventType.LEFT_DOUBLE_CLICK);

// Status bar: coordinates and elevation under the cursor, plus camera altitude.
const status = document.createElement('div');
status.id = 'status';
document.querySelector('#globe')!.append(status);
let lastMove = 0;
handler.setInputAction(({ endPosition }: ScreenSpaceEventHandler.MotionEvent) => {
  if (drawer.kind) {
    drawer.move(pickGround(viewer, endPosition));
    redraw();
  }
  const now = performance.now();
  if (now - lastMove < 50) return;
  lastMove = now;
  const ground = pickGround(viewer, endPosition);
  const eye = (viewer.camera.positionCartographic.height / 1000).toFixed(2);
  status.textContent = ground
    ? `${formatCoords(ground)}   elev ${Math.round(ground.height)} m   eye ${eye} km`
    : `eye ${eye} km`;
}, ScreenSpaceEventType.MOUSE_MOVE);

// Layers panel.
const layerList = document.querySelector<HTMLUListElement>('#layer-list')!;
function addToggle(label: string, checked: boolean, onChange: (on: boolean) => void, note?: string): HTMLInputElement {
  const li = document.createElement('li');
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = checked;
  box.addEventListener('change', () => onChange(box.checked));
  const text = document.createElement('span');
  text.textContent = label;
  if (note) text.title = note;
  li.append(box, text);
  layerList.append(li);
  return box;
}
for (const { source, layer } of layers) {
  addToggle(source.name, layer.show, (on) => (layer.show = on), source.note);
}
// Overlays were added roads first, so roads is the lowest overlay layer.
const keyedImagery = new KeyedImagery(viewer, overlays.roads, addToggle);
setupHistory(
  viewer,
  () => [...layers.filter((l) => l.source.bounds).map((l) => l.layer), ...keyedImagery.current],
  overlays.roads,
);
// Google's 3D Tiles replace the globe and must not be mixed with other map data,
// so the OpenStreetMap layers stay off while they're showing.
const openData = (on: boolean) => on && !google3d.active;
const openDataToggles = [
  addToggle('Place names', true, (on) => labels.setEnabled(openData(on))),
  addToggle('Borders', overlays.borders.show, (on) => (overlays.borders.show = openData(on))),
  addToggle('Roads', overlays.roads.show, (on) => (overlays.roads.show = openData(on))),
  addToggle('3D buildings (OpenStreetMap)', true, (on) => buildings.setEnabled(openData(on))),
];
function refreshOpenData(): void {
  for (const box of openDataToggles) {
    box.disabled = google3d.active;
    box.dispatchEvent(new Event('change'));
  }
}

const googleToggle = addToggle(
  'Google photorealistic 3D (your key)',
  false,
  async (on) => {
    const key = loadSetting('googleKey');
    if (on && !key) {
      googleToggle.checked = false;
      hint.textContent = 'Add a Google Maps API key in Settings first.';
      return;
    }
    if (on) {
      try {
        await google3d.enable(key);
        refreshOpenData();
        redraw();
        hint.textContent = 'Showing Google 3D. Search now uses Google.';
      } catch (err) {
        googleToggle.checked = false;
        // Cesium rejects with a RequestErrorEvent (statusCode, no message) for HTTP errors.
        const status = (err as { statusCode?: number }).statusCode;
        hint.textContent = status
          ? `Google rejected the key (HTTP ${status}). Check it and that the Map Tiles API is enabled.`
          : `Google 3D Tiles failed: ${(err as Error).message ?? err}`;
      }
    } else {
      google3d.disable();
      refreshOpenData();
      hint.textContent = '';
    }
  },
  'Uses Google Map Tiles API with your own key; usage is billed to your Google Cloud account.',
);
addToggle('Sun lighting', false, (on) => (viewer.scene.globe.enableLighting = on));
addToggle('Atmosphere', true, (on) => (viewer.scene.globe.showGroundAtmosphere = on));

// Sidebar sections remember whether they're open.
for (const panel of document.querySelectorAll<HTMLDetailsElement>('details[data-panel]')) {
  const key = `panel.${panel.dataset.panel}`;
  const saved = loadSetting(key);
  if (saved) panel.open = saved === 'open';
  panel.addEventListener('toggle', () => storeSetting(key, panel.open ? 'open' : 'closed'));
}

// Settings.
const tokenInput = document.querySelector<HTMLInputElement>('#mapillary-token')!;
tokenInput.value = loadSetting('mapillaryToken');
tokenInput.addEventListener('change', () => storeSetting('mapillaryToken', tokenInput.value.trim()));
const googleKeyInput = document.querySelector<HTMLInputElement>('#google-key')!;
googleKeyInput.value = loadSetting('googleKey');
googleKeyInput.addEventListener('change', () => storeSetting('googleKey', googleKeyInput.value.trim()));

const clearButton = document.querySelector<HTMLButtonElement>('#clear-cache')!;
clearButton.hidden = !isDesktop;
clearButton.addEventListener('click', async () => {
  const removed = await clearTileCache();
  clearButton.textContent = `Cleared ${removed} cached tiles`;
});
