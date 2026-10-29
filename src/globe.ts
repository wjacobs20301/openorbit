import {
  Cartesian2,
  Cartographic,
  Credit,
  ImageryLayer,
  Math as CesiumMath,
  Rectangle,
  UrlTemplateImageryProvider,
  Viewer,
} from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import { NoDataImageryProvider } from './nodata';
import { viaCache } from './platform';
import { imagerySources, type ImagerySource } from './sources';
import { createTerrainProvider } from './terrain';

export interface LayerEntry {
  source: ImagerySource;
  layer: ImageryLayer;
}

export function createGlobe(container: string): { viewer: Viewer; layers: LayerEntry[] } {
  const viewer = new Viewer(container, {
    baseLayer: false,
    baseLayerPicker: false,
    geocoder: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    animation: false,
    timeline: false,
    fullscreenButton: false,
    // Our own balloon (balloon.ts) shows feature details instead.
    infoBox: false,
    selectionIndicator: false,
    terrainProvider: createTerrainProvider(),
    // Draw frames only when something changes, so an idle globe uses no CPU/GPU.
    // Code that changes the scene outside Cesium's own events calls scene.requestRender().
    requestRenderMode: true,
    maximumRenderTimeChange: Infinity,
  });

  const { scene } = viewer;
  scene.globe.depthTestAgainstTerrain = true;
  scene.globe.maximumScreenSpaceError = 1.5;
  scene.globe.tileCacheSize = 400;

  const layers = imagerySources.map((source) => {
    const Provider = source.fillsNoData ? NoDataImageryProvider : UrlTemplateImageryProvider;
    const provider = new Provider({
      url: viaCache(source.url),
      maximumLevel: source.maximumLevel,
      credit: new Credit(source.credit),
      rectangle: source.bounds ? Rectangle.fromDegrees(...source.bounds) : undefined,
    });
    if (provider instanceof NoDataImageryProvider) provider.outside = source.outside;
    const layer = new ImageryLayer(provider, { minimumTerrainLevel: source.showFromLevel });
    viewer.imageryLayers.add(layer);
    layer.show = source.enabledByDefault;
    return { source, layer };
  });

  return { viewer, layers };
}

/** The ground position under a screen point, or undefined when pointing at space. */
export function pickGround(viewer: Viewer, position: Cartesian2): Cartographic | undefined {
  const { scene } = viewer;
  const cartesian = scene.pickPositionSupported ? scene.pickPosition(position) : undefined;
  const fallback = cartesian ?? scene.globe.pick(viewer.camera.getPickRay(position)!, scene);
  return fallback ? Cartographic.fromCartesian(fallback) : undefined;
}

/** Degrees-minutes-seconds, as Google Earth shows them: 49°13'56.39" N  120°48'25.82" W. */
export function formatCoords(c: Cartographic): string {
  const dms = (deg: number, pos: string, neg: string) => {
    const a = Math.abs(deg);
    const d = Math.floor(a);
    const m = Math.floor((a - d) * 60);
    const s = ((a - d) * 60 - m) * 60;
    return `${d}°${String(m).padStart(2, '0')}'${s.toFixed(2).padStart(5, '0')}" ${deg >= 0 ? pos : neg}`;
  };
  return `${dms(CesiumMath.toDegrees(c.latitude), 'N', 'S')}  ${dms(CesiumMath.toDegrees(c.longitude), 'E', 'W')}`;
}

/** Eye altitude in metres or kilometres. */
export function formatAltitude(m: number): string {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(2)} km`;
}
