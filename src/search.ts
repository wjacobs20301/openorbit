import { Cartesian3, Cartographic, Rectangle, type Viewer } from 'cesium';

/** Never fly lower than this, so small places don't put the camera underground. */
const MIN_VIEW_HEIGHT = 1500;
import { geocoder } from './sources';

interface PhotonFeature {
  geometry: { coordinates: [number, number] };
  properties: { name?: string; city?: string; state?: string; country?: string; extent?: [number, number, number, number] };
}

interface GoogleResult {
  formatted_address: string;
  geometry: {
    location: { lat: number; lng: number };
    viewport?: { northeast: { lat: number; lng: number }; southwest: { lat: number; lng: number } };
  };
}

/** A search hit: a name, a point, and optionally [west, south, east, north] in degrees. */
interface Place {
  label: string;
  lon: number;
  lat: number;
  bounds?: [number, number, number, number];
}

function photonLabel(p: PhotonFeature['properties']): string {
  return [p.name, p.city, p.state, p.country].filter((v, i, a) => v && a.indexOf(v) === i).join(', ');
}

async function searchPhoton(q: string, signal: AbortSignal): Promise<Place[]> {
  const url = `${geocoder.url}?q=${encodeURIComponent(q)}&limit=8`;
  const data = (await (await fetch(url, { signal })).json()) as { features: PhotonFeature[] };
  return data.features.map((f) => {
    const e = f.properties.extent;
    return {
      label: photonLabel(f.properties),
      lon: f.geometry.coordinates[0],
      lat: f.geometry.coordinates[1],
      bounds: e ? [e[0], e[3], e[2], e[1]] : undefined,
    };
  });
}

async function searchGoogle(q: string, key: string, signal: AbortSignal): Promise<Place[]> {
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(q)}&key=${encodeURIComponent(key)}`;
  const data = (await (await fetch(url, { signal })).json()) as { status: string; results: GoogleResult[]; error_message?: string };
  if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') throw new Error(data.error_message ?? data.status);
  return data.results.map((r) => {
    const v = r.geometry.viewport;
    return {
      label: r.formatted_address,
      lon: r.geometry.location.lng,
      lat: r.geometry.location.lat,
      bounds: v ? [v.southwest.lng, v.southwest.lat, v.northeast.lng, v.northeast.lat] : undefined,
    };
  });
}

/**
 * Place search. Uses Photon (OpenStreetMap) normally, and Google's geocoder whenever
 * `googleKey()` returns a key, as Google's 3D Tiles terms require.
 */
export function setupSearch(viewer: Viewer, googleKey: () => string | null): void {
  const form = document.querySelector<HTMLFormElement>('#search-form')!;
  const input = document.querySelector<HTMLInputElement>('#search-input')!;
  const results = document.querySelector<HTMLUListElement>('#search-results')!;
  let pending: AbortController | undefined;

  const flyTo = (place: Place) => {
    let destination = Cartesian3.fromDegrees(place.lon, place.lat, 3000);
    if (place.bounds) {
      const fit = Cartographic.fromCartesian(viewer.camera.getRectangleCameraCoordinates(Rectangle.fromDegrees(...place.bounds)));
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
      const key = googleKey();
      const places = key ? await searchGoogle(q, key, pending.signal) : await searchPhoton(q, pending.signal);
      results.innerHTML = '';
      if (!places.length) results.innerHTML = '<li class="hint">No places found</li>';
      for (const place of places) {
        const li = document.createElement('li');
        li.textContent = place.label;
        li.addEventListener('click', () => flyTo(place));
        results.append(li);
      }
      if (places.length === 1) flyTo(places[0]);
    } catch (err) {
      if ((err as Error).name !== 'AbortError') results.innerHTML = '<li class="hint">Search is unavailable right now</li>';
    }
  });
}
