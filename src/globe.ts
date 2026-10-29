import {
  Cartesian2,
  Cartographic,
  Color,
  Credit,
  ImageryLayer,
  Math as CesiumMath,
  Rectangle,
  UrlTemplateImageryProvider,
  Viewer,
} from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
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
    terrainProvider: createTerrainProvider(),
  });

  const { scene } = viewer;
  scene.globe.depthTestAgainstTerrain = true;
  scene.globe.maximumScreenSpaceError = 1.5;
  scene.globe.tileCacheSize = 400;

  const layers = imagerySources.map((source) => {
    const provider = new UrlTemplateImageryProvider({
      url: viaCache(source.url),
      maximumLevel: source.maximumLevel,
      credit: new Credit(source.credit),
      rectangle: source.bounds ? Rectangle.fromDegrees(...source.bounds) : undefined,
    });
    const layer = new ImageryLayer(provider, {
      minimumTerrainLevel: source.showFromLevel,
      colorToAlpha: source.blackIsNoData ? Color.BLACK : undefined,
      colorToAlphaThreshold: 0.02,
    });
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

export function formatCoords(c: Cartographic): string {
  const lat = CesiumMath.toDegrees(c.latitude);
  const lon = CesiumMath.toDegrees(c.longitude);
  return `${Math.abs(lat).toFixed(5)}°${lat >= 0 ? 'N' : 'S'}  ${Math.abs(lon).toFixed(5)}°${lon >= 0 ? 'E' : 'W'}`;
}
