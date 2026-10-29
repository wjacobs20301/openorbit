import { Credit, ImageryLayer, UrlTemplateImageryProvider, type Viewer } from 'cesium';
import type { LayerEntry } from './globe';
import { viaCache } from './platform';
import { historySnapshots, MODIS_FIRST_DAY, modisCredit, modisDailyUrl } from './sources';

/**
 * Time slider: shows a past imagery layer over the current one. While a past view is
 * showing, today's local high-resolution layers are hidden so they don't cover it.
 */
export function setupHistory(viewer: Viewer, layers: LayerEntry[]): void {
  const slider = document.querySelector<HTMLInputElement>('#time-slider')!;
  const label = document.querySelector<HTMLElement>('#time-label')!;
  const daily = document.querySelector<HTMLInputElement>('#time-daily')!;
  const date = document.querySelector<HTMLInputElement>('#time-date')!;

  const now = historySnapshots.length;
  slider.min = '0';
  slider.max = String(now);
  slider.value = String(now);
  const today = new Date().toISOString().slice(0, 10);
  date.min = MODIS_FIRST_DAY;
  date.max = today;
  date.value = today;

  // Local layers (anything with bounds) are current-day imagery; hide them for past views.
  const localLayers = layers.filter((l) => l.source.bounds);
  let savedShow: boolean[] | null = null;
  let pastLayer: ImageryLayer | undefined;

  function show(url: string | null, credit = '', maximumLevel = 0): void {
    if (pastLayer) viewer.imageryLayers.remove(pastLayer, true);
    pastLayer = undefined;
    if (url) {
      savedShow ??= localLayers.map((l) => l.layer.show);
      localLayers.forEach((l) => (l.layer.show = false));
      const provider = new UrlTemplateImageryProvider({ url: viaCache(url), maximumLevel, credit: new Credit(credit) });
      pastLayer = viewer.imageryLayers.addImageryProvider(provider);
    } else if (savedShow) {
      localLayers.forEach((l, i) => (l.layer.show = savedShow![i]));
      savedShow = null;
    }
  }

  function update(): void {
    slider.disabled = daily.checked;
    date.disabled = !daily.checked;
    if (daily.checked) {
      label.textContent = `${date.value} · MODIS daily 250 m`;
      show(modisDailyUrl(date.value), modisCredit, 9);
      return;
    }
    const snapshot = historySnapshots[Number(slider.value)];
    label.textContent = snapshot ? snapshot.label : 'Now';
    show(snapshot?.url ?? null, snapshot?.credit, snapshot?.maximumLevel);
  }

  slider.addEventListener('input', update);
  daily.addEventListener('change', update);
  date.addEventListener('change', update);
  update();
}
