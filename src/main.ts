import { Math as CesiumMath, ScreenSpaceEventHandler, ScreenSpaceEventType } from 'cesium';
import { Drawer } from './draw';
import './style.css';
import { createGlobe, formatCoords, pickGround } from './globe';
import { setupHistory } from './history';
import { setupImport } from './importer';
import { Measure } from './measure';
import { setupOffline } from './offline';
import { PlaceLabels } from './labels';
import { addVectorOverlays } from './overlay';
import { Places } from './places';
import { clearTileCache, isDesktop, loadSetting, storeSetting } from './platform';
import { setupSearch } from './search';
import { StreetView } from './streetview';

type Tool = 'placemark' | 'path' | 'polygon' | 'measure' | 'street' | null;

const { viewer, layers } = createGlobe('globe');
const overlays = addVectorOverlays(viewer);
const labels = new PlaceLabels(viewer);
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
setupSearch(viewer);
setupImport(viewer);
setupHistory(viewer, layers);
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
  if (!drawer.kind || (e.target as HTMLElement).closest('input, select, textarea')) return;
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
  if (drawer.kind) drawer.move(pickGround(viewer, endPosition));
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
function addToggle(label: string, checked: boolean, onChange: (on: boolean) => void, note?: string): void {
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
}
for (const { source, layer } of layers) {
  addToggle(source.name, layer.show, (on) => (layer.show = on), source.note);
}
addToggle('Place names', true, (on) => labels.setEnabled(on));
addToggle('Borders', overlays.borders.show, (on) => (overlays.borders.show = on));
addToggle('Roads', overlays.roads.show, (on) => (overlays.roads.show = on));
addToggle('Sun lighting', false, (on) => (viewer.scene.globe.enableLighting = on));
addToggle('Terrain shading (atmosphere)', true, (on) => (viewer.scene.globe.showGroundAtmosphere = on));

// Settings.
const tokenInput = document.querySelector<HTMLInputElement>('#mapillary-token')!;
tokenInput.value = loadSetting('mapillaryToken');
tokenInput.addEventListener('change', () => storeSetting('mapillaryToken', tokenInput.value.trim()));

const clearButton = document.querySelector<HTMLButtonElement>('#clear-cache')!;
clearButton.hidden = !isDesktop;
clearButton.addEventListener('click', async () => {
  const removed = await clearTileCache();
  clearButton.textContent = `Cleared ${removed} cached tiles`;
});
