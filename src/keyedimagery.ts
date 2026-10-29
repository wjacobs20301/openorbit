import { Credit, ImageryLayer, UrlTemplateImageryProvider, type Viewer } from 'cesium';
import { loadSetting, storeSetting } from './platform';
import { keyedImagerySources, type KeyedImagerySource } from './sources';

/** Checks a key by fetching one world tile; returns an error message, or null if it works. */
async function checkKey(source: KeyedImagerySource, key: string): Promise<string | null> {
  try {
    const res = await fetch(source.url(key).replace('{z}', '0').replace('{x}', '0').replace('{y}', '0'));
    if (res.ok && res.headers.get('content-type')?.startsWith('image/')) return null;
    return `Rejected (HTTP ${res.status}). Check the key.`;
  } catch {
    return 'Could not reach the service.';
  }
}

/**
 * Optional sharp imagery layers that need the person's own key. Each gets a toggle in
 * Layers and a key field in Settings; layers sit just below the borders/roads overlays.
 */
export class KeyedImagery {
  private readonly layers = new Map<string, ImageryLayer>();

  constructor(
    private readonly viewer: Viewer,
    /** The lowest overlay layer; keyed imagery is inserted directly beneath it. */
    private readonly below: ImageryLayer,
    addToggle: (label: string, checked: boolean, onChange: (on: boolean) => void, note?: string) => HTMLInputElement,
  ) {
    const settings = document.querySelector<HTMLElement>('#keyed-imagery-settings')!;
    for (const source of keyedImagerySources) {
      const key = loadSetting(source.setting);
      const toggle = addToggle(source.name, !!key, (on) => this.setShown(source, on), `Needs a key from ${source.signup}`);
      toggle.disabled = !key;
      if (key) this.create(source, key);

      const field = document.createElement('label');
      field.className = 'field';
      field.textContent = source.name.replace(/ \(your (key|token)\)/, '') + ' key';
      const input = document.createElement('input');
      input.type = 'password';
      input.placeholder = `Optional, from ${source.signup.replace('https://', '')}`;
      input.value = key;
      const status = document.createElement('span');
      status.className = 'hint';
      field.append(input, status);
      settings.append(field);

      input.addEventListener('change', async () => {
        const next = input.value.trim();
        storeSetting(source.setting, next);
        this.remove(source);
        toggle.disabled = !next;
        toggle.checked = !!next;
        status.textContent = '';
        if (!next) return;
        // Esri serves tiles even for bad keys, so only services that reject them are checked.
        const problem = source.id === 'esri' ? null : await checkKey(source, next);
        if (problem) {
          status.textContent = problem;
          toggle.checked = false;
          toggle.disabled = true;
          return;
        }
        status.textContent = 'Key saved. The layer is on in Layers.';
        this.create(source, next);
      });
    }
  }

  /** The keyed layers currently on the globe, so the time slider can hide them. */
  get current(): ImageryLayer[] {
    return [...this.layers.values()];
  }

  private create(source: KeyedImagerySource, key: string): void {
    const provider = new UrlTemplateImageryProvider({
      url: source.url(key),
      maximumLevel: source.maximumLevel,
      tileWidth: source.tileSize,
      tileHeight: source.tileSize,
      credit: new Credit(source.credit),
    });
    const layer = new ImageryLayer(provider);
    this.viewer.imageryLayers.add(layer, this.viewer.imageryLayers.indexOf(this.below));
    this.layers.set(source.id, layer);
    this.viewer.scene.requestRender();
  }

  private remove(source: KeyedImagerySource): void {
    const layer = this.layers.get(source.id);
    if (layer) this.viewer.imageryLayers.remove(layer, true);
    this.layers.delete(source.id);
  }

  private setShown(source: KeyedImagerySource, on: boolean): void {
    const layer = this.layers.get(source.id);
    if (layer) layer.show = on;
  }
}
