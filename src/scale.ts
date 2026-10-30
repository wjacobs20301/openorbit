import { Cartesian2, Cartographic, EllipsoidGeodesic, type Viewer } from 'cesium';
import { pickGround } from './globe';
import { niceScale, onUnitsChange } from './units';

/** Longest the bar may be, in pixels. */
const MAX_BAR = 120;
const SAMPLE_PX = 100;

/**
 * Scale legend (View > Scale Legend in Google Earth): a bar for a round distance,
 * measured on the ground near the bottom of the view where it's most useful.
 */
export function setupScaleLegend(viewer: Viewer): { setShown(on: boolean): void; readonly shown: boolean } {
  const el = document.createElement('div');
  el.id = 'scale-legend';
  el.innerHTML = '<span></span><div class="bar"></div>';
  const label = el.querySelector('span')!;
  const bar = el.querySelector<HTMLElement>('.bar')!;
  document.querySelector('#globe')!.append(el);
  let shown = true;

  const update = () => {
    if (!shown) return;
    const { clientWidth: w, clientHeight: h } = viewer.canvas;
    const y = h - 70;
    const a = pickGround(viewer, new Cartesian2(w / 2 - SAMPLE_PX / 2, y));
    const b = pickGround(viewer, new Cartesian2(w / 2 + SAMPLE_PX / 2, y));
    if (!a || !b) {
      el.hidden = true;
      return;
    }
    const metresPerPx = new EllipsoidGeodesic(Cartographic.clone(a), Cartographic.clone(b)).surfaceDistance / SAMPLE_PX;
    const scale = niceScale(metresPerPx * MAX_BAR);
    el.hidden = false;
    bar.style.width = `${Math.round(scale.metres / metresPerPx)}px`;
    label.textContent = scale.label;
  };
  onUnitsChange(update);
  viewer.camera.changed.addEventListener(update);
  viewer.camera.moveEnd.addEventListener(update);
  window.setTimeout(update, 1500);

  return {
    setShown(on: boolean) {
      shown = on;
      el.hidden = !on;
      if (on) update();
    },
    get shown() {
      return shown;
    },
  };
}
