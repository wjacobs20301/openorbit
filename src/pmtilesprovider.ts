import { PMTiles } from 'pmtiles';
import { NoDataImageryProvider, type Image } from './nodata';

/**
 * Raster tiles read straight out of a PMTiles archive with HTTP range requests (no tile
 * server). Used for the Data for Canada city aerial photos. The tiles are decoded upright
 * (north at the top), as NoDataImageryProvider's clean-up expects of a canvas.
 */
export class PMTilesImageryProvider extends NoDataImageryProvider {
  private archive?: PMTiles;

  /** Set after construction: the base class needs a URL template, which isn't used. */
  setArchive(url: string): void {
    this.archive = new PMTiles(url);
  }

  protected override loadTile(x: number, y: number, level: number): Promise<Image | undefined> {
    return this.fetch(x, y, level);
  }

  private async fetch(x: number, y: number, level: number): Promise<Image | undefined> {
    const tile = await this.archive!.getZxy(level, x, y);
    if (!tile) return undefined;
    const bitmap = await createImageBitmap(new Blob([tile.data]));
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d', { willReadFrequently: true })!.drawImage(bitmap, 0, 0);
    bitmap.close();
    return canvas;
  }
}
