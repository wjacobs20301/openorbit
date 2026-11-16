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
import masks from './data/coverage-masks.json';
import { NoDataImageryProvider } from './nodata';
import { PMTilesImageryProvider } from './pmtilesprovider';
import { viaCache } from './platform';
import { imagerySources, type ImagerySource } from './sources';
import { createTerrainProvider } from './terrain';
import { formatLatLon } from './units';

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
    // The KML time bar (timebar.ts) drives the clock itself.
    automaticallyTrackDataSourceClocks: false,
    timeline: false,
    fullscreenButton: false,
    // Home lives in our navigation controls (navcontrols.ts).
    homeButton: false,
    // Our own balloon (balloon.ts) shows feature details instead.
    infoBox: false,
    selectionIndicator: false,
    terrainProvider: createTerrainProvider(),
    // Draw frames only when something changes, so an idle globe uses no CPU/GPU.
    // Code that changes the scene outside Cesium's own events calls scene.requestRender().
    requestRenderMode: true,
    maximumRenderTimeChange: Infinity,
    // Draw at the screen's full pixel density. Cesium's default draws Retina screens at
    // half resolution and stretches the result, which makes imagery and labels look soft.
    useBrowserRecommendedResolution: false,
  });

  const { scene } = viewer;
  scene.globe.depthTestAgainstTerrain = true;
  scene.globe.maximumScreenSpaceError = 1.5;
  scene.globe.tileCacheSize = 400;

  const layers = imagerySources.map((source) => {
    const Provider = source.pmtiles
      ? PMTilesImageryProvider
      : source.fillsNoData
        ? NoDataImageryProvider
        : UrlTemplateImageryProvider;
    const provider = new Provider({
      // PMTiles archives are read by range request, straight from the server.
      url: source.pmtiles ? `${source.url}#{z}/{x}/{y}` : viaCache(source.url),
      maximumLevel: source.maximumLevel,
      credit: new Credit(source.credit),
      rectangle: source.bounds ? Rectangle.fromDegrees(...source.bounds) : undefined,
    });
    if (provider instanceof PMTilesImageryProvider) provider.setArchive(source.url);
    if (provider instanceof NoDataImageryProvider) {
      provider.setCoverage({
        outside: source.outside,
        fillColour: source.fillColour,
        mask: source.mask && masks[source.mask],
        exclude: source.exclude?.map((id) => masks[id]),
        // Imagery levels run about one ahead of the terrain levels showFromLevel counts.
        missing: source.missingLevels
          ? { template: viaCache(source.url), minLevel: (source.showFromLevel ?? 0) + 1, levels: source.missingLevels }
          : undefined,
      });
    }
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
  const ray = viewer.camera.getPickRay(position);
  const onGlobe = ray && scene.globe.pick(ray, scene);
  // Out in space the depth buffer can still return a stray position; only trust it when
  // the pointer is actually over the planet.
  if (!onGlobe) return undefined;
  const cartesian = scene.pickPositionSupported ? scene.pickPosition(position) : undefined;
  return Cartographic.fromCartesian(cartesian ?? onGlobe);
}

/** The pointer position in the chosen coordinate format. */
export function formatCoords(c: Cartographic): string {
  return formatLatLon(CesiumMath.toDegrees(c.latitude), CesiumMath.toDegrees(c.longitude));
}
