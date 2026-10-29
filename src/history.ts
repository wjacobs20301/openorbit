import { Credit, ImageryLayer, UrlTemplateImageryProvider, type Viewer } from 'cesium';
import { viaCache } from './platform';
import { CURRENT_S2_YEAR, historySnapshots, MODIS_FIRST_DAY, modisCredit, modisDailyUrl } from './sources';

/**
 * Time slider: shows a past imagery layer over the current one. While a past view is
 * showing, today's high-resolution layers are hidden so they don't cover it.
 *
 * @param currentLayers today's detailed layers to hide during past views
 * @param below the lowest overlay layer; past imagery goes directly beneath it
 */
export interface HistoryControl {
  /** Shows or hides the slider bar; hiding it returns to today's imagery. */
  setOpen(open: boolean): void;
  readonly open: boolean;
  /** What the imagery on screen is, for the status bar (e.g. "2025" or "1984"). */
  readonly imageryDate: string;
}

export function setupHistory(
  viewer: Viewer,
  currentLayers: () => ImageryLayer[],
  below: ImageryLayer,
  onChange: () => void,
): HistoryControl {
  const bar = document.querySelector<HTMLElement>('#time-bar')!;
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
  let imageryDate = String(CURRENT_S2_YEAR);

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
      imageryDate = date.value;
      show(modisDailyUrl(date.value), modisCredit, 9);
    } else {
      const snapshot = historySnapshots[Number(slider.value)];
      label.textContent = snapshot ? snapshot.label : `Now (${CURRENT_S2_YEAR})`;
      imageryDate = snapshot ? String(snapshot.year) : String(CURRENT_S2_YEAR);
      show(snapshot?.url ?? null, snapshot?.credit, snapshot?.maximumLevel);
    }
    viewer.scene.requestRender();
    onChange();
  }

  slider.addEventListener('input', update);
  daily.addEventListener('change', update);
  date.addEventListener('change', update);
  update();

  const control: HistoryControl = {
    setOpen(open: boolean) {
      bar.hidden = !open;
      if (!open && (daily.checked || slider.value !== String(now))) {
        daily.checked = false;
        slider.value = String(now);
        update();
      }
      onChange();
    },
    get open() {
      return !bar.hidden;
    },
    get imageryDate() {
      return imageryDate;
    },
  };
  document.querySelector('#time-close')!.addEventListener('click', () => control.setOpen(false));
  return control;
}
