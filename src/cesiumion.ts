import {
  Cesium3DTileset,
  CesiumTerrainProvider,
  Google2DImageryProvider,
  ImageryLayer,
  type ImageryProvider,
  Ion,
  IonImageryProvider,
  createOsmBuildingsAsync,
  type TerrainProvider,
  type Viewer,
} from 'cesium';
import { loadSetting, storeSetting } from './platform';

/** Cesium ion asset ids (see https://ion.cesium.com/assetdepot). */
const ASSETS = {
  bingAerial: 2,
  google2d: 3830184,
  worldTerrain: 1,
};

const NOTE = 'Needs a free Cesium ion token (ion.cesium.com). The free plan is for non-commercial use.';

type AddToggle = (
  label: string,
  checked: boolean,
  onChange: (on: boolean) => void,
  note?: string,
  group?: string,
) => HTMLInputElement;

/** Checks a token against one asset; returns an error message, or null if it works. */
async function checkToken(token: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://api.cesium.com/v1/assets/${ASSETS.bingAerial}/endpoint?access_token=${encodeURIComponent(token)}`,
    );
    if (res.ok) return null;
    return res.status === 401 ? 'Cesium ion rejected the token.' : `Cesium ion answered HTTP ${res.status}.`;
  } catch {
    return 'Could not reach Cesium ion.';
  }
}

/**
 * Optional data from Cesium ion with the person's own (free) token: Bing Maps and Google
 * satellite imagery, Cesium World Terrain and Cesium OSM Buildings. Each gets a toggle in
 * Layers; the token goes in Settings.
 */
export class CesiumIon {
  private readonly imagery = new Map<string, ImageryLayer>();
  private buildings?: Cesium3DTileset;
  private terrain?: Promise<TerrainProvider>;
  private readonly toggles: HTMLInputElement[] = [];
  /** Whether the person wants Cesium World Terrain instead of the open terrain. */
  terrainWanted = false;

  constructor(
    private readonly viewer: Viewer,
    /** The lowest overlay layer; imagery goes directly beneath it. */
    private readonly below: ImageryLayer,
    addToggle: AddToggle,
    /** Called when World Terrain is switched, so the caller can rebuild the terrain. */
    private readonly onTerrainChange: () => void,
    /** Called when Cesium OSM Buildings is switched (true while showing). */
    private readonly onBuildingsChange: (on: boolean) => void,
  ) {
    Ion.defaultAccessToken = loadSetting('ionToken');
    const has = !!Ion.defaultAccessToken;

    const bing = addToggle('Bing Maps aerial (Cesium ion)', false, (on) => this.setImagery('bing', on), NOTE, 'Imagery');
    const google = addToggle('Google satellite (Cesium ion)', false, (on) => this.setImagery('google', on), NOTE, 'Imagery');
    const terrain = addToggle(
      'Cesium World Terrain (Cesium ion)',
      false,
      (on) => {
        this.terrainWanted = on && !!Ion.defaultAccessToken;
        this.onTerrainChange();
      },
      NOTE,
    );
    this.buildingsToggle = addToggle('Cesium OSM Buildings (Cesium ion)', false, (on) => this.setBuildings(on), NOTE, '3D Buildings');
    this.toggles.push(bing, google, terrain, this.buildingsToggle);
    for (const box of this.toggles) box.disabled = !has;

    const input = document.querySelector<HTMLInputElement>('#ion-token')!;
    const status = document.querySelector<HTMLElement>('#ion-token-status')!;
    input.value = Ion.defaultAccessToken ?? '';
    input.addEventListener('change', async () => {
      const token = input.value.trim();
      status.textContent = '';
      const problem = token ? await checkToken(token) : null;
      if (problem) {
        status.textContent = problem;
        return;
      }
      storeSetting('ionToken', token);
      Ion.defaultAccessToken = token;
      // Drop anything loaded with the previous token.
      for (const box of this.toggles) {
        if (box.checked) box.click();
        box.disabled = !token;
      }
      this.terrain = undefined;
      if (token) {
        status.textContent = 'Token saved. Bing Maps aerial is on; more in Layers.';
        bing.click();
      }
    });
  }

  private readonly buildingsToggle: HTMLInputElement;

  /** The ion imagery layers on the globe, so the time slider can hide them. */
  get current(): ImageryLayer[] {
    return [...this.imagery.values()];
  }

  /** Cesium World Terrain, loaded once per token. */
  worldTerrain(): Promise<TerrainProvider> {
    this.terrain ??= CesiumTerrainProvider.fromIonAssetId(ASSETS.worldTerrain, { requestVertexNormals: true });
    return this.terrain;
  }

  /** Hides OSM Buildings while Google 3D (which already has buildings) is showing. */
  setBuildingsAllowed(allowed: boolean): void {
    this.buildingsToggle.disabled = !allowed || !Ion.defaultAccessToken;
    if (this.buildings) this.buildings.show = allowed;
  }

  private setImagery(id: 'bing' | 'google', on: boolean): void {
    const existing = this.imagery.get(id);
    if (existing) this.viewer.imageryLayers.remove(existing, true);
    this.imagery.delete(id);
    if (!on || !Ion.defaultAccessToken) return this.viewer.scene.requestRender();
    // Cesium's typings for Google2DImageryProvider differ slightly from ImageryProvider's.
    const provider = (
      id === 'bing'
        ? IonImageryProvider.fromAssetId(ASSETS.bingAerial)
        : Google2DImageryProvider.fromIonAssetId({ assetId: String(ASSETS.google2d), mapType: 'satellite' })
    ) as Promise<ImageryProvider>;
    const layer = ImageryLayer.fromProviderAsync(provider, {});
    this.viewer.imageryLayers.add(layer, this.viewer.imageryLayers.indexOf(this.below));
    this.imagery.set(id, layer);
  }

  private async setBuildings(on: boolean): Promise<void> {
    if (this.buildings) this.viewer.scene.primitives.remove(this.buildings);
    this.buildings = undefined;
    on &&= !!Ion.defaultAccessToken;
    this.onBuildingsChange(on);
    if (!on) return this.viewer.scene.requestRender();
    const tileset = await createOsmBuildingsAsync();
    // Switched off again while loading.
    if (!this.buildingsToggle.checked) return;
    this.buildings = this.viewer.scene.primitives.add(tileset);
    this.viewer.scene.requestRender();
  }
}
