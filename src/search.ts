import { Cartesian3, Cartographic, Rectangle, type Viewer } from 'cesium';

/** Never fly lower than this, so small places don't put the camera underground. */
const MIN_VIEW_HEIGHT = 1500;
import { geocoder } from './sources';

interface PhotonFeature {
  geometry: { coordinates: [number, number] };
  properties: { name?: string; city?: string; state?: string; country?: string; extent?: [number, number, number, number] };
}

function label(p: PhotonFeature['properties']): string {
  return [p.name, p.city, p.state, p.country].filter((v, i, a) => v && a.indexOf(v) === i).join(', ');
}

export function setupSearch(viewer: Viewer): void {
  const form = document.querySelector<HTMLFormElement>('#search-form')!;
  const input = document.querySelector<HTMLInputElement>('#search-input')!;
  const results = document.querySelector<HTMLUListElement>('#search-results')!;
  let pending: AbortController | undefined;

  const flyTo = (f: PhotonFeature) => {
    const [lon, lat] = f.geometry.coordinates;
    const extent = f.properties.extent;
    let destination = Cartesian3.fromDegrees(lon, lat, 3000);
    if (extent) {
      const fit = Cartographic.fromCartesian(
        viewer.camera.getRectangleCameraCoordinates(Rectangle.fromDegrees(extent[0], extent[3], extent[2], extent[1])),
      );
      fit.height = Math.max(fit.height, MIN_VIEW_HEIGHT);
      destination = Cartographic.toCartesian(fit);
    }
    viewer.camera.flyTo({ destination });
    results.hidden = true;
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q) return;
    pending?.abort();
    pending = new AbortController();
    results.hidden = false;
    results.innerHTML = '<li class="hint">Searching…</li>';
    try {
      const url = `${geocoder.url}?q=${encodeURIComponent(q)}&limit=8`;
      const data = (await (await fetch(url, { signal: pending.signal })).json()) as { features: PhotonFeature[] };
      results.innerHTML = '';
      if (!data.features.length) results.innerHTML = '<li class="hint">No places found</li>';
      for (const f of data.features) {
        const li = document.createElement('li');
        li.textContent = label(f.properties);
        li.addEventListener('click', () => flyTo(f));
        results.append(li);
      }
      if (data.features.length === 1) flyTo(data.features[0]);
    } catch (err) {
      if ((err as Error).name !== 'AbortError') results.innerHTML = '<li class="hint">Search is unavailable right now</li>';
    }
  });
}
