import { Cartesian3, Cartographic, Rectangle, type Viewer } from 'cesium';

/** Never fly lower than this, so small places don't put the camera underground. */
const MIN_VIEW_HEIGHT = 1500;
import { loadSetting, storeSetting } from './platform';
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
  const url = `${geocoder.url}?q=${encodeURIComponent(q)}&limit=12`;
  const data = (await (await fetch(url, { signal })).json()) as { features: PhotonFeature[] };
  // OpenStreetMap often has a town, its district and its boundary under one name: list it once.
  const seen = new Set<string>();
  const unique = data.features.filter((f) => {
    const key = photonLabel(f.properties);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return unique.slice(0, 8).map((f) => {
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

  const flyTo = (place: Place, item?: HTMLLIElement) => {
    let destination = Cartesian3.fromDegrees(place.lon, place.lat, 3000);
    if (place.bounds) {
      const fit = Cartographic.fromCartesian(viewer.camera.getRectangleCameraCoordinates(Rectangle.fromDegrees(...place.bounds)));
      fit.height = Math.max(fit.height, MIN_VIEW_HEIGHT);
      destination = Cartographic.toCartesian(fit);
    }
    viewer.camera.flyTo({ destination });
    // Results stay listed (as in Google Earth); mark the one being shown.
    results.querySelectorAll('li').forEach((li) => li.classList.toggle('selected', li === item));
  };

  const run = async (q: string) => {
    pending?.abort();
    pending = new AbortController();
    remember(q);
    results.innerHTML = '<li class="hint">Searching…</li>';
    try {
      const key = googleKey();
      const places = key ? await searchGoogle(q, key, pending.signal) : await searchPhoton(q, pending.signal);
      results.innerHTML = '';
      if (!places.length) results.innerHTML = '<li class="hint">No places found</li>';
      for (const place of places) {
        const li = document.createElement('li');
        li.textContent = place.label;
        li.addEventListener('click', () => flyTo(place, li));
        results.append(li);
      }
      if (places.length) flyTo(places[0], results.querySelector('li')!);
    } catch (err) {
      if ((err as Error).name !== 'AbortError') results.innerHTML = '<li class="hint">Search is unavailable right now</li>';
    }
  };

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (q) void run(q);
  });

  // History: recent searches, newest first.
  document.querySelector('#search-history')!.addEventListener('click', () => {
    const past = recall();
    results.innerHTML = past.length ? '' : '<li class="hint">No searches yet</li>';
    for (const q of past) {
      const li = document.createElement('li');
      li.textContent = `🕘 ${q}`;
      li.addEventListener('click', () => {
        input.value = q;
        void run(q);
      });
      results.append(li);
    }
  });
}

const HISTORY_KEY = 'searchHistory';
const HISTORY_SIZE = 12;

function recall(): string[] {
  try {
    return JSON.parse(loadSetting(HISTORY_KEY) || '[]');
  } catch {
    return [];
  }
}

function remember(q: string): void {
  storeSetting(HISTORY_KEY, JSON.stringify([q, ...recall().filter((x) => x !== q)].slice(0, HISTORY_SIZE)));
}
