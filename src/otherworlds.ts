import {
  Cartesian2,
  Cartesian3,
  Cartographic,
  Color,
  Credit,
  Ellipsoid,
  EllipsoidTerrainProvider,
  GeographicTilingScheme,
  Globe,
  HorizontalOrigin,
  ImageryLayer,
  JulianDate,
  LabelCollection,
  LabelStyle,
  Material,
  Math as CesiumMath,
  Matrix3,
  type PerspectiveFrustum,
  PointPrimitiveCollection,
  PolylineCollection,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  SkyBox,
  Transforms,
  UrlTemplateImageryProvider,
  VerticalOrigin,
  Viewer,
} from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import { isDesktop } from './platform';
import { setupWorldPicker, switchWorld, WORLDS, type World } from './worlds';

/** A named feature to label on a planetary body: [name, latitude, east longitude]. */
type Place = [string, number, number];

interface Body {
  name: string;
  ellipsoid: Ellipsoid;
  imagery: string;
  maximumLevel: number;
  credit: string;
  places: Place[];
}

const MARS = new Ellipsoid(3_396_190, 3_396_190, 3_376_200);

const BODIES: Record<'moon' | 'mars', Body> = {
  moon: {
    name: 'Moon',
    ellipsoid: Ellipsoid.MOON,
    imagery:
      'https://trek.nasa.gov/tiles/Moon/EQ/LRO_WAC_Mosaic_Global_303ppd_v02/1.0.0/default/default028mm/{z}/{y}/{x}.jpg',
    maximumLevel: 9,
    credit:
      'Imagery: NASA/GSFC/Arizona State University, LRO Wide Angle Camera mosaic, via <a href="https://trek.nasa.gov/moon/">NASA Moon Trek</a>',
    places: [
      ['Apollo 11', 0.674, 23.473],
      ['Apollo 12', -3.012, -23.422],
      ['Apollo 14', -3.645, -17.471],
      ['Apollo 15', 26.132, 3.634],
      ['Apollo 16', -8.973, 15.5],
      ['Apollo 17', 20.191, 30.772],
      ["Chang'e 4", -45.445, 177.599],
      ['Tycho', -43.31, -11.36],
      ['Copernicus', 9.62, -20.08],
      ['Mare Tranquillitatis', 8.5, 31.4],
      ['Mare Serenitatis', 28, 17.5],
      ['Mare Imbrium', 32.8, -15.6],
      ['Mare Crisium', 17, 59.1],
      ['Oceanus Procellarum', 18.4, -57.4],
      ['Shackleton (south pole)', -89.67, 129.78],
    ],
  },
  mars: {
    name: 'Mars',
    ellipsoid: MARS,
    imagery:
      'https://trek.nasa.gov/tiles/Mars/EQ/Mars_Viking_MDIM21_ClrMosaic_global_232m/1.0.0/default/default028mm/{z}/{y}/{x}.jpg',
    maximumLevel: 8,
    credit:
      'Imagery: NASA/USGS Viking MDIM 2.1 colour mosaic, via <a href="https://trek.nasa.gov/mars/">NASA Mars Trek</a>',
    places: [
      ['Olympus Mons', 18.65, -133.8],
      ['Valles Marineris', -14, -59.2],
      ['Arsia Mons', -8.26, -120.09],
      ['Elysium Mons', 25.02, 147.21],
      ['Hellas Planitia', -42.4, 70.5],
      ['Utopia Planitia', 46.7, 117.5],
      ['Gale Crater (Curiosity)', -5.4, 137.8],
      ['Jezero Crater (Perseverance)', 18.44, 77.45],
      ['Gusev Crater (Spirit)', -14.57, 175.47],
      ['Meridiani Planum (Opportunity)', -1.95, -5.53],
      ['Viking 1', 22.27, -48],
      ['Mars Pathfinder', 19.13, -33.22],
    ],
  },
};

/** Star chart data from d3-celestial (BSD-3-Clause), based on the Hipparcos catalogue. */
const CELESTIAL = 'https://cdn.jsdelivr.net/gh/ofrohn/d3-celestial@0.7.32/data/';
const SKY_CREDIT =
  'Stars and constellations: <a href="https://github.com/ofrohn/d3-celestial">d3-celestial</a> (Hipparcos catalogue)';

/** The viewer options shared by every world (OpenOrbit draws its own controls). */
const VIEWER_OPTIONS = {
  baseLayerPicker: false,
  geocoder: false,
  sceneModePicker: false,
  navigationHelpButton: false,
  animation: false,
  timeline: false,
  fullscreenButton: false,
  homeButton: false,
  infoBox: false,
  selectionIndicator: false,
  useBrowserRecommendedResolution: false,
} as const;

/** Starts the Sky, Moon or Mars viewer in place of the Earth app. */
export function startOtherWorld(world: Exclude<World, 'earth'>): void {
  const app = document.querySelector<HTMLElement>('#app')!;
  app.classList.add('other-world', 'no-sidebar');
  setupWorldPicker();
  const status = document.createElement('div');
  status.id = 'world-status';
  document.querySelector('#globe')!.append(status);
  if (isDesktop) void worldMenu();
  if (world === 'sky') startSky(status);
  else startBody(BODIES[world], status);
}

// ---- Moon and Mars

function startBody(body: Body, status: HTMLElement): void {
  const { ellipsoid } = body;
  const tilingScheme = new GeographicTilingScheme({ ellipsoid });
  // The scene's ellipsoid drives horizon culling and camera maths; Earth's would hide
  // everything on a body this size.
  Ellipsoid.default = ellipsoid;
  const viewer = new Viewer('globe', {
    ...VIEWER_OPTIONS,
    ellipsoid,
    // Cesium only adds the star background for Earth by default.
    skyBox: SkyBox.createEarthSkyBox(),
    globe: new Globe(ellipsoid),
    baseLayer: new ImageryLayer(
      new UrlTemplateImageryProvider({
        url: body.imagery,
        tilingScheme,
        maximumLevel: body.maximumLevel,
        credit: new Credit(body.credit),
      }),
    ),
    terrainProvider: new EllipsoidTerrainProvider({ ellipsoid, tilingScheme }),
    skyAtmosphere: false,
  });
  const { scene } = viewer;
  scene.globe.showGroundAtmosphere = false;
  scene.globe.enableLighting = false;
  if (scene.moon) scene.moon.show = false;
  scene.fog.enabled = false;
  scene.globe.maximumScreenSpaceError = 1.5;

  const labels = scene.primitives.add(new LabelCollection());
  const points = scene.primitives.add(new PointPrimitiveCollection());
  const marks: { position: Cartesian3; normal: Cartesian3; label: { show: boolean }; point: { show: boolean } }[] = [];
  for (const [name, lat, lon] of body.places) {
    const position = Cartesian3.fromDegrees(lon, lat, 0, ellipsoid);
    const point = points.add({ position, pixelSize: 6, color: Color.fromCssColorString('#ffd166'), outlineColor: Color.BLACK, outlineWidth: 1 });
    const label = labels.add({
      position,
      text: name,
      font: '600 14px system-ui, sans-serif',
      fillColor: Color.WHITE,
      outlineColor: Color.BLACK,
      outlineWidth: 3,
      style: LabelStyle.FILL_AND_OUTLINE,
      pixelOffset: new Cartesian2(10, 0),
      horizontalOrigin: HorizontalOrigin.LEFT,
      verticalOrigin: VerticalOrigin.CENTER,
    });
    marks.push({ position, normal: ellipsoid.geodeticSurfaceNormal(position), label, point });
  }
  // Only places facing the camera are shown; otherwise labels poke out half-cut at the edge.
  const toCamera = new Cartesian3();
  scene.preRender.addEventListener(() => {
    for (const m of marks) {
      Cartesian3.subtract(viewer.camera.positionWC, m.position, toCamera);
      const facing = Cartesian3.dot(m.normal, toCamera) > 0;
      m.label.show = facing;
      m.point.show = facing;
    }
  });

  viewer.camera.setView({ destination: Cartesian3.fromDegrees(10, 15, ellipsoid.maximumRadius * 2.4, ellipsoid) });

  const handler = new ScreenSpaceEventHandler(scene.canvas);
  handler.setInputAction((e: { endPosition: Cartesian2 }) => {
    const hit = viewer.camera.pickEllipsoid(e.endPosition, ellipsoid);
    if (!hit) {
      status.textContent = body.name;
      return;
    }
    const c = Cartographic.fromCartesian(hit, ellipsoid);
    const lat = CesiumMath.toDegrees(c.latitude);
    const lon = CesiumMath.toDegrees(c.longitude);
    status.textContent = `${body.name} · ${Math.abs(lat).toFixed(3)}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(3)}° ${lon >= 0 ? 'E' : 'W'} · eye ${(viewer.camera.positionCartographic.height / 1000).toFixed(0)} km`;
  }, ScreenSpaceEventType.MOUSE_MOVE);
  status.textContent = body.name;
}

// ---- Sky

interface StarFeature {
  id: number;
  properties: { mag: number; bv: string };
  geometry: { coordinates: [number, number] };
}
interface StarName {
  name: string;
}
interface Constellation {
  id: string;
  properties: { name: string };
  geometry: { coordinates: [number, number] };
}
interface ConstellationLines {
  id: string;
  geometry: { coordinates: [number, number][][] };
}

/** Unit vector for right ascension / declination (degrees), in the celestial frame. */
function celestial(ra: number, dec: number): Cartesian3 {
  const a = CesiumMath.toRadians(ra);
  const d = CesiumMath.toRadians(dec);
  return new Cartesian3(Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d));
}

/** Rough star colour from its B–V colour index. */
function starColour(bv: number, alpha: number): Color {
  const c = bv < 0 ? '#aac4ff' : bv < 0.4 ? '#e4ecff' : bv < 0.8 ? '#fff6e0' : bv < 1.3 ? '#ffd9a0' : '#ffb37a';
  return Color.fromCssColorString(c).withAlpha(alpha);
}

/**
 * The night sky seen from inside the celestial sphere, like Google Earth's Sky: Cesium's
 * star background, plus the Hipparcos stars to magnitude 6, constellation lines and names.
 * Drag to look around, scroll to zoom. The time is frozen, so the sky holds still.
 */
function startSky(status: HTMLElement): void {
  const viewer = new Viewer('globe', {
    ...VIEWER_OPTIONS,
    globe: false,
    baseLayer: false,
    skyAtmosphere: false,
    shouldAnimate: false,
  });
  const { scene, camera } = viewer;
  if (scene.moon) scene.moon.show = false;
  if (scene.sun) scene.sun.show = false;
  viewer.clock.currentTime = JulianDate.now();
  scene.screenSpaceCameraController.enableInputs = false;
  viewer.creditDisplay.addStaticCredit(new Credit(SKY_CREDIT));

  // Cesium turns its star background from the celestial frame (TEME) to Earth-fixed
  // coordinates for the scene time; everything here uses the same rotation to line up.
  const toFixed = Transforms.computeTemeToPseudoFixedMatrix(viewer.clock.currentTime, new Matrix3());
  const fromFixed = Matrix3.transpose(toFixed, new Matrix3());
  // Cesium needs the camera outside the Earth's centre (it works out a latitude and height
  // for it), so it sits just above the surface and the stars are put so far away that the
  // offset is invisible (under a thousandth of a degree).
  const R = 1e11;
  const eye = new Cartesian3(7e6, 0, 0);
  const place = (ra: number, dec: number, r = R) =>
    Cartesian3.add(
      eye,
      Matrix3.multiplyByVector(toFixed, Cartesian3.multiplyByScalar(celestial(ra, dec), r, new Cartesian3()), new Cartesian3()),
      new Cartesian3(),
    );

  // The camera sits at the centre of the sphere and turns; the field of view is the zoom.
  const frustum = camera.frustum as PerspectiveFrustum;
  frustum.near = 1;
  frustum.far = R * 4;
  let fov = 70;
  let ra = 84; // Orion
  let dec = 0;
  const apply = () => {
    ra = ((ra % 360) + 360) % 360;
    dec = CesiumMath.clamp(dec, -89.9, 89.9);
    const dir = Matrix3.multiplyByVector(toFixed, celestial(ra, dec), new Cartesian3());
    // Celestial north stays at the top of the view.
    const north = Matrix3.multiplyByVector(toFixed, Cartesian3.UNIT_Z, new Cartesian3());
    const right = Cartesian3.normalize(Cartesian3.cross(dir, north, new Cartesian3()), new Cartesian3());
    camera.position = Cartesian3.clone(eye);
    camera.direction = Cartesian3.normalize(dir, dir);
    camera.up = Cartesian3.normalize(Cartesian3.cross(right, dir, new Cartesian3()), new Cartesian3());
    frustum.fov = CesiumMath.toRadians(fov);
    scene.requestRender();
  };
  apply();

  const lineLayer = scene.primitives.add(new PolylineCollection()) as PolylineCollection;
  const starLayer = scene.primitives.add(new PointPrimitiveCollection()) as PointPrimitiveCollection;
  const labels = scene.primitives.add(new LabelCollection()) as LabelCollection;

  void (async () => {
    let data: [{ features: StarFeature[] }, Record<string, StarName>, { features: Constellation[] }, { features: ConstellationLines[] }];
    try {
      data = await Promise.all(
        ['stars.6.json', 'starnames.json', 'constellations.json', 'constellations.lines.json'].map((f) =>
          fetch(CELESTIAL + f).then((r) => {
            if (!r.ok) throw new Error(String(r.status));
            return r.json();
          }),
        ),
      ) as typeof data;
    } catch {
      status.textContent = 'Could not load the star chart. Check the internet connection.';
      return;
    }
    const [stars, names, constellations, lines] = data;

    const lineMaterial = Material.fromType('Color', { color: Color.fromCssColorString('#6f9cff').withAlpha(0.45) });
    for (const c of lines.features)
      for (const strip of c.geometry.coordinates)
        lineLayer.add({ positions: strip.map(([a, d]) => place(a, d, R * 0.999)), width: 1, material: lineMaterial });

    const searchable: { name: string; ra: number; dec: number }[] = [];
    for (const star of stars.features) {
      const [a, d] = star.geometry.coordinates;
      const mag = star.properties.mag;
      starLayer.add({
        position: place(a, d),
        pixelSize: Math.max(1.4, 6.2 - mag * 0.85),
        color: starColour(Number(star.properties.bv) || 0.6, Math.min(1, 1.25 - mag * 0.13)),
      });
      const name = names[String(star.id)]?.name;
      if (!name) continue;
      searchable.push({ name, ra: a, dec: d });
      if (mag < 2.2)
        labels.add({
          position: place(a, d),
          text: name,
          font: '12px system-ui, sans-serif',
          fillColor: Color.fromCssColorString('#dfe8ff'),
          pixelOffset: new Cartesian2(8, -6),
          horizontalOrigin: HorizontalOrigin.LEFT,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        });
    }
    for (const c of constellations.features) {
      const [a, d] = c.geometry.coordinates;
      searchable.push({ name: c.properties.name, ra: a, dec: d });
      labels.add({
        position: place(a, d),
        text: c.properties.name.toUpperCase(),
        font: '600 12px system-ui, sans-serif',
        fillColor: Color.fromCssColorString('#8fb0ff').withAlpha(0.85),
        horizontalOrigin: HorizontalOrigin.CENTER,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      });
    }
    skyControls(
      searchable,
      (target) => {
        // RA in the data runs -180..180 degrees.
        ra = target.ra;
        dec = target.dec;
        fov = Math.min(fov, 30);
        apply();
      },
      (on) => {
        lineLayer.show = on.lines;
        labels.show = on.names;
        scene.requestRender();
      },
    );
    scene.requestRender();
  })();

  // Drag to look around, scroll to zoom.
  const canvas = scene.canvas;
  let drag: { x: number; y: number } | null = null;
  canvas.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, y: e.clientY };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointerup', () => (drag = null));
  canvas.addEventListener('pointermove', (e) => {
    if (drag) {
      const perPx = fov / canvas.clientHeight;
      // The sky moves with the pointer, as when dragging the Earth.
      ra += ((e.clientX - drag.x) * perPx) / Math.max(0.2, Math.cos(CesiumMath.toRadians(dec)));
      dec += (e.clientY - drag.y) * perPx;
      drag = { x: e.clientX, y: e.clientY };
      apply();
    }
    const ray = camera.getPickRay(new Cartesian2(e.offsetX, e.offsetY));
    if (!ray) return;
    const local = Matrix3.multiplyByVector(fromFixed, ray.direction, new Cartesian3());
    const r = (CesiumMath.toDegrees(Math.atan2(local.y, local.x)) + 360) % 360;
    const d = CesiumMath.toDegrees(Math.asin(CesiumMath.clamp(local.z, -1, 1)));
    const h = r / 15;
    status.textContent = `Sky · RA ${Math.floor(h)}h ${Math.floor((h % 1) * 60)}m · Dec ${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(1)}° · view ${Math.round(fov)}° across`;
  });
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      fov = CesiumMath.clamp(fov * Math.exp(e.deltaY * 0.0015), 1, 120);
      apply();
    },
    { passive: false },
  );
  status.textContent = 'Sky · drag to look around, scroll to zoom';
}

/** Search box and layer checkboxes for the Sky, in the toolbar. */
function skyControls(
  searchable: { name: string; ra: number; dec: number }[],
  go: (target: { ra: number; dec: number }) => void,
  show: (on: { lines: boolean; names: boolean }) => void,
): void {
  const box = document.createElement('div');
  box.id = 'world-tools';
  box.innerHTML = `
    <input type="search" list="sky-names" placeholder="Find a star or constellation" aria-label="Find a star or constellation" />
    <datalist id="sky-names">${[...new Set(searchable.map((s) => s.name))].sort().map((n) => `<option value="${n.replace(/"/g, '&quot;')}"></option>`).join('')}</datalist>
    <label class="check"><input class="lines" type="checkbox" checked /> Constellation lines</label>
    <label class="check"><input class="names" type="checkbox" checked /> Names</label>`;
  document.querySelector('#world-select')!.after(box);
  const input = box.querySelector<HTMLInputElement>('input[type="search"]')!;
  input.addEventListener('change', () => {
    const q = input.value.trim().toLowerCase();
    const hit = searchable.find((s) => s.name.toLowerCase() === q) ?? searchable.find((s) => s.name.toLowerCase().startsWith(q));
    if (hit) go(hit);
  });
  const update = () =>
    show({
      lines: box.querySelector<HTMLInputElement>('.lines')!.checked,
      names: box.querySelector<HTMLInputElement>('.names')!.checked,
    });
  box.querySelectorAll('input[type="checkbox"]').forEach((c) => c.addEventListener('change', update));
}

/** A small desktop menu bar for the other worlds: Explore, editing and the window. */
async function worldMenu(): Promise<void> {
  const { Menu, MenuItem, PredefinedMenuItem, Submenu } = await import('@tauri-apps/api/menu');
  const app = await Submenu.new({
    text: 'OpenOrbit',
    items: [
      await PredefinedMenuItem.new({ item: { About: null } }),
      await PredefinedMenuItem.new({ item: 'Separator' }),
      await PredefinedMenuItem.new({ item: 'Hide' }),
      await PredefinedMenuItem.new({ item: 'Quit' }),
    ],
  });
  const edit = await Submenu.new({
    text: 'Edit',
    items: await Promise.all(
      (['Undo', 'Redo', 'Cut', 'Copy', 'Paste', 'SelectAll'] as const).map((item) => PredefinedMenuItem.new({ item })),
    ),
  });
  const view = await Submenu.new({
    text: 'View',
    items: [
      await Submenu.new({
        text: 'Explore',
        items: await Promise.all(WORLDS.map((w) => MenuItem.new({ text: w.name, action: () => switchWorld(w.id) }))),
      }),
      await PredefinedMenuItem.new({ item: 'Fullscreen' }),
    ],
  });
  const windowMenu = await Submenu.new({
    text: 'Window',
    items: [await PredefinedMenuItem.new({ item: 'Minimize' }), await PredefinedMenuItem.new({ item: 'Maximize' })],
  });
  const menu = await Menu.new({ items: [app, edit, view, windowMenu] });
  await menu.setAsAppMenu();
}
