import { createGooglePhotorealistic3DTileset, type Cesium3DTileset, type Viewer } from 'cesium';

/**
 * Google Photorealistic 3D Tiles, loaded with the user's own Map Tiles API key. They
 * replace the globe surface while on. Google requires its own geocoder alongside them,
 * so search switches to Google while this is active (see search.ts).
 */
export class Google3D {
  private tileset?: Cesium3DTileset;

  constructor(private readonly viewer: Viewer) {}

  get active(): boolean {
    return !!this.tileset;
  }

  async enable(key: string): Promise<void> {
    if (this.tileset) return;
    const tileset = await createGooglePhotorealistic3DTileset({ key, onlyUsingWithGoogleGeocoder: true });
    this.tileset = this.viewer.scene.primitives.add(tileset);
    this.viewer.scene.globe.show = false;
  }

  disable(): void {
    if (!this.tileset) return;
    this.viewer.scene.primitives.remove(this.tileset);
    this.tileset = undefined;
    this.viewer.scene.globe.show = true;
  }
}
