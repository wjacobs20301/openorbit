import {
  EllipsoidTerrainProvider,
  JulianDate,
  type Cartesian3,
  type Entity,
  Math as CesiumMath,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
} from 'cesium';
import { Balloon } from './balloon';
import { Buildings } from './buildings';
import { Drawer } from './draw';
import './style.css';
import { createGlobe, formatAltitude, formatCoords, pickGround } from './globe';
import { Google3D } from './google3d';
import { setupHistory, type HistoryControl } from './history';
import { setupImport } from './importer';
import { KeyedImagery } from './keyedimagery';
import { PlaceLabels } from './labels';
import { Measure } from './measure';
import type { AppActions } from './menu';
import { setupNavControls } from './navcontrols';
import { setupOffline } from './offline';
import { addVectorOverlays } from './overlay';
import { Pegman } from './pegman';
import { Places } from './places';
import { ElevationProfile } from './profile';
import { PlaceEditor } from './editor';
import { clearTileCache, isDesktop, isTyping, loadSetting, storeSetting } from './platform';
import { setupSearch } from './search';
import { setupScaleLegend } from './scale';
import { setupStartView } from './startview';
import { StreetView } from './streetview';
import { Tours } from './tour';
import { setupSun, type SunControl } from './sun';
import { createTerrainProvider } from './terrain';
import { openInGoogleEarthWeb, openInGoogleMaps, saveImage, viewLocation } from './viewtools';

type Tool = 'placemark' | 'path' | 'polygon' | 'measure' | 'street' | null;

// Set up further down; the status bar and toolbar read them once they exist.
let history: HistoryControl | undefined;
let sun: SunControl | undefined;
/** Refreshes the desktop menu's checkmarks once the menu exists. */
let syncMenu: (() => void) | undefined;

const app = document.querySelector<HTMLElement>('#app')!;
const { viewer, layers } = createGlobe('globe');
const startView = setupStartView(viewer);
const scaleLegend = setupScaleLegend(viewer);

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
const hint = document.querySelector<HTMLElement>('#tool-hint')!;
const measure = new Measure(viewer, (summary) => (hint.textContent = summary));
const street = new StreetView(viewer);
const balloon = new Balloon(viewer);
const profile = new ElevationProfile(viewer);
const showLineProfile = (entity: Entity) => {
  const positions = entity.polyline?.positions?.getValue(JulianDate.now()) as Cartesian3[] | undefined;
  if (positions?.length) void profile.show(entity.name ?? 'Line', positions);
};
balloon.onProfile = showLineProfile;
const tours = new Tours(viewer);
balloon.onFlyAlong = (entity) => {
  const positions = entity.polyline?.positions?.getValue(JulianDate.now()) as Cartesian3[] | undefined;
  if (positions?.length) void tours.fromLine(entity.name ?? 'line', positions);
};
places.onFlyAlong = (name, positions) => void tours.fromLine(name, positions);
tours.onRecordingChange = (on) => {
  document.querySelector('[data-action="record-tour"]')?.classList.toggle('recording', on);
  hint.textContent = on ? 'Recording: fly around, then press Stop.' : '';
};
balloon.canEdit = (entity) => !!places.get(entity.id);
balloon.onEdit = (entity) => editor.open(entity.id);
places.onProfile = (name, positions) => void profile.show(name, positions);
const editor = new PlaceEditor(viewer, places);
places.onEdit = (id) => editor.open(id);
const drawer = new Drawer(
  viewer,
  (summary) => (hint.textContent = summary),
  (kind, coords) => {
    // As in Google Earth, a new place opens its Properties window.
    const id = places.addShape(kind, coords);
    setTool(null);
    editor.open(id, true);
  },
);
setupSearch(viewer, () => (google3d.active ? loadSetting('googleKey') : null));
// Street view owns the arrow keys while it's open.
const nav = setupNavControls(viewer, () => !street.isOpen, () => startView.goHome());
const pegman = new Pegman(viewer, street);
pegman.onTap = () => setTool('street');
setupImport(viewer);
setupOffline(viewer);

// Handy for poking at the scene from devtools during development.
if (import.meta.env.DEV) Object.assign(window, { viewer });

// ---- Tools (toolbar buttons with data-tool): one at a time; clicking again turns it off.
const hints: Record<Exclude<Tool, null>, string> = {
  placemark: 'Click the globe to drop a placemark.',
  path: 'Click to add points along the path.',
  polygon: 'Click to add the corners of the shape.',
  measure: 'Ruler: click points on the globe to measure.',
  street: 'Click a blue line to see street-level photos.',
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
  pegman.showCoverage(tool === 'street');
  if (tool === 'path') drawer.start('line');
  if (tool === 'polygon') drawer.start('polygon');
}
toolButtons.forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool as Tool)));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    setTool(null);
    balloon.close();
    if (editor.active && !isTyping(e)) editor.close(false);
  }
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
  // With no tool active, a click shows the details of whatever feature is under it.
  if (!tool) {
    // While editing, clicks go to the editor's handles instead.
    if (!editor.active) balloon.openAt(position);
    return;
  }
  const ground = pickGround(viewer, position);
  if (!ground) return;
  if (tool === 'placemark') {
    const id = places.addPoint(ground);
    setTool(null);
    editor.open(id, true);
    return;
  }
  if (tool === 'path' || tool === 'polygon') drawer.add(ground);
  if (tool === 'measure') measure.add(ground);
  if (tool === 'street') {
    void street.openAt(CesiumMath.toDegrees(ground.longitude), CesiumMath.toDegrees(ground.latitude));
  }
}, ScreenSpaceEventType.LEFT_CLICK);
handler.setInputAction(() => drawer.finish(), ScreenSpaceEventType.LEFT_DOUBLE_CLICK);

// ---- Status bar, as in Google Earth: imagery date, pointer position, elevation, eye altitude.
const status = document.createElement('div');
status.id = 'status';
document.querySelector('#globe')!.append(status);
let pointer = '';
const updateStatus = () => {
  status.textContent = `Imagery Date: ${history?.imageryDate ?? ''}    ${pointer}    eye alt ${formatAltitude(
    viewer.camera.positionCartographic.height,
  )}`;
};
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
  pointer = ground ? `${formatCoords(ground)}    elev ${Math.round(ground.height)} m` : '';
  updateStatus();
}, ScreenSpaceEventType.MOUSE_MOVE);
viewer.camera.changed.addEventListener(() => updateStatus());

// ---- Layers panel: a small tree, grouped like Google Earth's.
const layerList = document.querySelector<HTMLUListElement>('#layer-list')!;
const groups = new Map<string, HTMLUListElement>();
function groupList(name: string): HTMLUListElement {
  let ul = groups.get(name);
  if (!ul) {
    const li = document.createElement('li');
    li.className = 'layer-group';
    const details = document.createElement('details');
    details.open = loadSetting(`layerGroup.${name}`) !== 'closed';
    details.addEventListener('toggle', () => storeSetting(`layerGroup.${name}`, details.open ? 'open' : 'closed'));
    const summary = document.createElement('summary');
    summary.textContent = name;
    ul = document.createElement('ul');
    ul.className = 'list';
    details.append(summary, ul);
    li.append(details);
    layerList.append(li);
    groups.set(name, ul);
  }
  return ul;
}
function addToggle(
  label: string,
  checked: boolean,
  onChange: (on: boolean) => void,
  note?: string,
  group?: string,
): HTMLInputElement {
  const li = document.createElement('li');
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = checked;
  // Each layer remembers whether it was on, across restarts.
  const key = `layer.${group ?? ''}.${label}`;
  box.addEventListener('change', () => {
    storeSetting(key, box.checked ? 'on' : 'off');
    onChange(box.checked);
  });
  const saved = loadSetting(key);
  if (saved && (saved === 'on') !== checked) {
    box.checked = saved === 'on';
    // Applied once startup finishes, when everything the toggle uses exists.
    queueMicrotask(() => onChange(box.checked));
  }
  const text = document.createElement('label');
  text.textContent = label;
  if (note) li.title = note;
  text.addEventListener('click', () => box.click());
  li.append(box, text);
  (group ? groupList(group) : layerList).append(li);
  return box;
}

for (const { source, layer } of layers) {
  addToggle(source.name, layer.show, (on) => (layer.show = on), source.note, 'Imagery');
}
// Overlays were added roads first, so roads is the lowest overlay layer.
const keyedImagery = new KeyedImagery(viewer, overlays.roads, (label, checked, onChange, note) =>
  addToggle(label, checked, onChange, note, 'Imagery'),
);
history = setupHistory(
  viewer,
  () => [...layers.filter((l) => l.source.bounds).map((l) => l.layer), ...keyedImagery.current],
  overlays.roads,
  () => {
    updateStatus();
    syncViewState();
  },
);
// Google's 3D Tiles replace the globe and must not be mixed with other map data,
// so the OpenStreetMap layers stay off while they're showing.
const openData = (on: boolean) => on && !google3d.active;
const openDataToggles = [
  addToggle('Borders', overlays.borders.show, (on) => (overlays.borders.show = openData(on)), undefined, 'Borders and Labels'),
  addToggle('Place names', true, (on) => labels.setEnabled(openData(on)), undefined, 'Borders and Labels'),
  addToggle('Roads', overlays.roads.show, (on) => (overlays.roads.show = openData(on))),
  addToggle('OpenStreetMap', true, (on) => buildings.setEnabled(openData(on)), undefined, '3D Buildings'),
];
function refreshOpenData(): void {
  for (const box of openDataToggles) {
    box.disabled = google3d.active;
    box.dispatchEvent(new Event('change'));
  }
}

const googleToggle = addToggle(
  'Google photorealistic (your key)',
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
        const code = (err as { statusCode?: number }).statusCode;
        hint.textContent = code
          ? `Google rejected the key (HTTP ${code}). Check it and that the Map Tiles API is enabled.`
          : `Google 3D Tiles failed: ${(err as Error).message ?? err}`;
      }
    } else {
      google3d.disable();
      refreshOpenData();
      hint.textContent = '';
    }
  },
  'Uses Google Map Tiles API with your own key; usage is billed to your Google Cloud account.',
  '3D Buildings',
);
addToggle('Street photos (coverage lines)', false, (on) => pegman.setCoverageLayer(on), 'Blue lines where Panoramax has street photos');
addToggle('Terrain', true, (on) => {
  viewer.terrainProvider = on ? createTerrainProvider() : new EllipsoidTerrainProvider();
});
const atmosphereBox = addToggle('Atmosphere', true, (on) => setAtmosphere(on));
function setAtmosphere(on: boolean): void {
  viewer.scene.globe.showGroundAtmosphere = on;
  if (viewer.scene.skyAtmosphere) viewer.scene.skyAtmosphere.show = on;
  atmosphereBox.checked = on;
  storeSetting('layer..Atmosphere', on ? 'on' : 'off');
  redraw();
  syncViewState();
}

// ---- Sidebar sections remember whether they're open.
for (const panel of document.querySelectorAll<HTMLDetailsElement>('details[data-panel]')) {
  const key = `panel.${panel.dataset.panel}`;
  const saved = loadSetting(key);
  if (saved) panel.open = saved === 'open';
  panel.addEventListener('toggle', () => storeSetting(key, panel.open ? 'open' : 'closed'));
}

// ---- Toolbar and map bars.
sun = setupSun(viewer, () => syncViewState());
const sunCtl = sun;
const historyCtl = history;
const settingsDialog = document.querySelector<HTMLDialogElement>('#settings-dialog')!;
const shortcutsDialog = document.querySelector<HTMLDialogElement>('#shortcuts-dialog')!;

function setPanelShown(cls: string, shown: boolean): void {
  app.classList.toggle(cls, !shown);
  storeSetting(`view.${cls}`, shown ? 'shown' : 'hidden');
  // The globe's canvas needs to notice its new size.
  window.setTimeout(() => {
    viewer.resize();
    redraw();
  }, 0);
  syncViewState();
}

const toggles: AppActions['toggles'] = {
  toolbar: { get: () => !app.classList.contains('no-toolbar'), set: (on) => setPanelShown('no-toolbar', on) },
  sidebar: { get: () => !app.classList.contains('no-sidebar'), set: (on) => setPanelShown('no-sidebar', on) },
  statusBar: { get: () => !app.classList.contains('no-status'), set: (on) => setPanelShown('no-status', on) },
  navigation: { get: () => !app.classList.contains('no-nav'), set: (on) => setPanelShown('no-nav', on) },
  scaleLegend: {
    get: () => scaleLegend.shown,
    set: (on) => {
      scaleLegend.setShown(on);
      storeSetting('view.scaleLegend', on ? 'shown' : 'hidden');
      syncViewState();
    },
  },
  atmosphere: { get: () => viewer.scene.globe.showGroundAtmosphere, set: setAtmosphere },
  sun: { get: () => sunCtl.open, set: (on) => sunCtl.setOpen(on) },
  history: { get: () => historyCtl.open, set: (on) => historyCtl.setOpen(on) },
};

const importInput = document.querySelector<HTMLInputElement>('#import-input')!;
const actions: AppActions = {
  open: () => importInput.click(),
  saveKml: () => void places.exportKml(),
  saveImage: () => void saveImage(viewer),
  googleMaps: () => void openInGoogleMaps(viewer),
  googleEarthWeb: () => void openInGoogleEarthWeb(viewer),
  recordTour: () => tours.toggleRecording(),
  playTour: () => {
    toggles.sidebar.set(true);
    document.querySelector<HTMLDetailsElement>('[data-panel="places"]')!.open = true;
    hint.textContent = 'Choose a tour under My Places and press ▶.';
  },
  makeStartLocation: () => {
    startView.makeStart();
    hint.textContent = 'This view is now your start location (and the Home button goes here).';
  },
  elevationProfile: () => {
    const selected = balloon.selected;
    if (selected?.polyline) showLineProfile(selected);
    else hint.textContent = 'Click a path or line first, then choose Show Elevation Profile.';
  },
  copyViewLocation: () => {
    const text = viewLocation(viewer);
    navigator.clipboard.writeText(text).then(
      () => (hint.textContent = `Copied ${text}`),
      () => (hint.textContent = `View location: ${text}`),
    );
  },
  find: () => {
    toggles.sidebar.set(true);
    document.querySelector<HTMLDetailsElement>('[data-panel="search"]')!.open = true;
    document.querySelector<HTMLInputElement>('#search-input')!.focus();
  },
  settings: () => settingsDialog.showModal(),
  shortcuts: () => shortcutsDialog.showModal(),
  addPlacemark: () => setTool('placemark'),
  addPath: () => setTool('path'),
  addPolygon: () => setTool('polygon'),
  ruler: () => setTool('measure'),
  streetView: () => setTool('street'),
  northUp: nav.northUp,
  resetTilt: nav.resetTilt,
  resetTiltAndNorth: nav.resetTiltAndNorth,
  toggles,
};

const toolbarActions: Record<string, () => void> = {
  sidebar: () => toggles.sidebar.set(!toggles.sidebar.get()),
  history: () => toggles.history.set(!historyCtl.open),
  sun: () => toggles.sun.set(!sunCtl.open),
  'save-image': actions.saveImage,
  'record-tour': () => tours.toggleRecording(),
  'google-maps': actions.googleMaps,
  settings: actions.settings,
};
document.querySelectorAll<HTMLButtonElement>('#toolbar [data-action]').forEach((b) =>
  b.addEventListener('click', () => toolbarActions[b.dataset.action!]()),
);

/** Keeps toolbar buttons and menu checkmarks in step with what's showing. */
function syncViewState(): void {
  document.querySelector('[data-action="history"]')?.classList.toggle('active', history?.open ?? false);
  document.querySelector('[data-action="sun"]')?.classList.toggle('active', sun?.open ?? false);
  document.querySelector('[data-action="sidebar"]')?.classList.toggle('active', app.classList.contains('no-sidebar'));
  syncMenu?.();
}

// Shortcuts. The desktop app's menus handle these themselves; the browser needs them here.
if (!isDesktop) {
  document.addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    const k = e.code;
    const run = (fn: () => void) => {
      e.preventDefault();
      fn();
    };
    if (e.shiftKey && k === 'KeyP') run(actions.addPlacemark);
    else if (e.shiftKey && k === 'KeyT') run(actions.addPath);
    else if (e.shiftKey && k === 'KeyG') run(actions.addPolygon);
    else if (e.altKey && k === 'KeyB') run(toolbarActions.sidebar);
    else if (e.altKey && k === 'KeyS') run(actions.saveImage);
    else if (!e.shiftKey && !e.altKey && k === 'KeyF') run(actions.find);
    else if (!e.shiftKey && !e.altKey && k === 'KeyS') run(actions.saveKml);
    else if (!e.shiftKey && !e.altKey && k === 'KeyO') run(actions.open);
    else if (k === 'Comma') run(actions.settings);
    else if (k === 'Slash') run(actions.shortcuts);
  });
} else {
  void import('./menu').then(async ({ setupMenu }) => {
    syncMenu = await setupMenu(actions);
  });
}

// ---- Settings dialog.
const tokenInput = document.querySelector<HTMLInputElement>('#mapillary-token')!;
tokenInput.value = loadSetting('mapillaryToken');
tokenInput.addEventListener('change', () => storeSetting('mapillaryToken', tokenInput.value.trim()));
const googleKeyInput = document.querySelector<HTMLInputElement>('#google-key')!;
googleKeyInput.value = loadSetting('googleKey');
googleKeyInput.addEventListener('change', () => storeSetting('googleKey', googleKeyInput.value.trim()));

document.querySelector('#make-start')!.addEventListener('click', () => {
  settingsDialog.close();
  actions.makeStartLocation();
});
document.querySelector('#clear-start')!.addEventListener('click', () => {
  startView.clearStart();
  hint.textContent = 'OpenOrbit will open where you left off.';
});

const clearButton = document.querySelector<HTMLButtonElement>('#clear-cache')!;
clearButton.addEventListener('click', async () => {
  const removed = await clearTileCache();
  clearButton.textContent = `Cleared ${removed} cached tiles`;
});

// Restore the View menu's show/hide choices from last time.
for (const cls of ['no-toolbar', 'no-sidebar', 'no-status', 'no-nav']) {
  if (loadSetting(`view.${cls}`) === 'hidden') app.classList.add(cls);
}
if (loadSetting('view.scaleLegend') === 'hidden') scaleLegend.setShown(false);

updateStatus();
syncViewState();
