import { Cartesian2, Math as CesiumMath, type Cartographic } from 'cesium';
import { geocoder } from './sources';

export interface MenuItem {
  label: string;
  run: () => void;
}

/** "Street, City, State, Country" for a point, from Photon's reverse lookup. */
export async function whatsHere(lon: number, lat: number): Promise<string> {
  const url = geocoder.url.replace(/api\/?$/, 'reverse') + `?lon=${lon}&lat=${lat}`;
  const data = (await (await fetch(url, { signal: AbortSignal.timeout(8000) })).json()) as {
    features: { properties: Record<string, string | undefined> }[];
  };
  const p = data.features[0]?.properties;
  if (!p) return 'No address found here';
  const street = [p.housenumber, p.street].filter(Boolean).join(' ');
  return [p.name !== p.postcode ? p.name : undefined, street, p.city, p.state, p.country]
    .filter((v, i, a) => v && a.indexOf(v) === i)
    .join(', ');
}

/**
 * Right-click menu on the map (a click, not a drag: right-drag still zooms). Items are
 * built for the clicked ground point each time.
 */
export function setupContextMenu(
  canvas: HTMLCanvasElement,
  pick: (at: Cartesian2) => Cartographic | undefined,
  items: (ground: Cartographic) => MenuItem[],
): void {
  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.hidden = true;
  menu.setAttribute('role', 'menu');
  document.body.append(menu);
  const close = () => (menu.hidden = true);

  let downAt: [number, number] | null = null;
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button === 2) downAt = [e.clientX, e.clientY];
  });
  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    // Only a click opens the menu; a right-drag is a zoom.
    if (downAt && Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4) return;
    const box = canvas.getBoundingClientRect();
    const ground = pick(new Cartesian2(e.clientX - box.left, e.clientY - box.top));
    if (!ground) return;
    const lat = CesiumMath.toDegrees(ground.latitude).toFixed(5);
    const lon = CesiumMath.toDegrees(ground.longitude).toFixed(5);
    menu.innerHTML = `<div class="context-title">${lat}, ${lon}</div>`;
    for (const item of items(ground)) {
      const b = document.createElement('button');
      b.setAttribute('role', 'menuitem');
      b.textContent = item.label;
      b.addEventListener('click', () => {
        close();
        item.run();
      });
      menu.append(b);
    }
    menu.hidden = false;
    // Keep it on screen.
    const w = menu.offsetWidth;
    const h = menu.offsetHeight;
    menu.style.left = `${Math.min(e.clientX, window.innerWidth - w - 8)}px`;
    menu.style.top = `${Math.min(e.clientY, window.innerHeight - h - 8)}px`;
    (menu.querySelector('button') as HTMLButtonElement | null)?.focus();
  });
  document.addEventListener('pointerdown', (e) => {
    if (!menu.contains(e.target as Node)) close();
  });
  document.addEventListener('keydown', (e) => e.key === 'Escape' && close());
  window.addEventListener('blur', close);
  canvas.addEventListener('wheel', close, { passive: true });
}
