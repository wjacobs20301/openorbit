import { loadSetting, storeSetting } from './platform';

export type World = 'earth' | 'sky' | 'moon' | 'mars';
export const WORLDS: { id: World; name: string }[] = [
  { id: 'earth', name: 'Earth' },
  { id: 'sky', name: 'Sky' },
  { id: 'moon', name: 'Moon' },
  { id: 'mars', name: 'Mars' },
];

export function currentWorld(): World {
  const saved = loadSetting('world');
  return WORLDS.some((w) => w.id === saved) ? (saved as World) : 'earth';
}

/** Switches to another world. Each runs in its own fresh page, so the app reloads. */
export function switchWorld(world: World): void {
  if (world === currentWorld()) return;
  storeSetting('world', world);
  location.reload();
}

/** The Earth / Sky / Moon / Mars picker in the toolbar. */
export function setupWorldPicker(): void {
  const select = document.querySelector<HTMLSelectElement>('#world-select')!;
  select.innerHTML = WORLDS.map((w) => `<option value="${w.id}">${w.name}</option>`).join('');
  select.value = currentWorld();
  select.addEventListener('change', () => switchWorld(select.value as World));
}
