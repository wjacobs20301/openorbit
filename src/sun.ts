import { JulianDate, Math as CesiumMath, type Viewer } from 'cesium';

export interface SunControl {
  setOpen(open: boolean): void;
  readonly open: boolean;
}

/**
 * Sunlight across the landscape: lights the globe for a chosen time of day, picked
 * with a slider in local solar time at the centre of the view (like Google Earth's Sun).
 */
export function setupSun(viewer: Viewer, onChange: () => void): SunControl {
  const bar = document.querySelector<HTMLElement>('#sun-bar')!;
  const slider = document.querySelector<HTMLInputElement>('#sun-slider')!;
  const label = document.querySelector<HTMLElement>('#sun-label')!;
  const now = new Date();
  slider.value = String(now.getHours() * 60 + now.getMinutes());

  const apply = () => {
    // Local solar time at the camera's longitude, converted to UTC for the clock.
    const lon = CesiumMath.toDegrees(viewer.camera.positionCartographic.longitude);
    const local = Number(slider.value);
    const utc = local - (lon / 15) * 60;
    const today = new Date();
    viewer.clock.currentTime = JulianDate.fromDate(
      new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 0, Math.round(utc))),
    );
    const hh = String(Math.floor(local / 60)).padStart(2, '0');
    const mm = String(local % 60).padStart(2, '0');
    label.textContent = `Sunlight · ${hh}:${mm} local solar time`;
    viewer.scene.requestRender();
  };
  slider.addEventListener('input', apply);

  const control: SunControl = {
    setOpen(open: boolean) {
      bar.hidden = !open;
      viewer.scene.globe.enableLighting = open;
      if (open) apply();
      viewer.scene.requestRender();
      onChange();
    },
    get open() {
      return !bar.hidden;
    },
  };
  document.querySelector('#sun-close')!.addEventListener('click', () => control.setOpen(false));
  return control;
}
