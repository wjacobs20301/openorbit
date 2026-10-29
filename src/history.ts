import { Credit, ImageryLayer, UrlTemplateImageryProvider, type Viewer } from 'cesium';
import { viaCache } from './platform';
import { historySnapshots, MODIS_FIRST_DAY, modisCredit, modisDailyUrl } from './sources';

/**
 * Time slider: shows a past imagery layer over the current one. While a past view is
 * showing, today's high-resolution layers are hidden so they don't cover it.
 *
 * @param currentLayers today's detailed layers to hide during past views
 * @param below the lowest overlay layer; past imagery goes directly beneath it
 */
export function setupHistory(viewer: Viewer, currentLayers: () => ImageryLayer[], below: ImageryLayer): void {
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

  let hidden: { layer: ImageryLayer; show: boolean }[] | null = null;
  let pastLayer: ImageryLayer | undefined;

  function show(url: string | null, credit = '', maximumLevel = 0): void {
    if (pastLayer) viewer.imageryLayers.remove(pastLayer, true);
    pastLayer = undefined;
    if (url) {
      hidden ??= currentLayers().map((layer) => ({ layer, show: layer.show }));
      hidden.forEach(({ layer }) => (layer.show = false));
      const provider = new UrlTemplateImageryProvider({ url: viaCache(url), maximumLevel, credit: new Credit(credit) });
      // Above today's imagery and below borders and roads.
      pastLayer = new ImageryLayer(provider);
      viewer.imageryLayers.add(pastLayer, viewer.imageryLayers.indexOf(below));
    } else if (hidden) {
      hidden.forEach(({ layer, show }) => (layer.show = show));
      hidden = null;
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
