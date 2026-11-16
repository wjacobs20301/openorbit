import './style.css';
import { currentWorld } from './worlds';

// Earth is the full app; the Sky, the Moon and Mars are lighter viewers of their own.
const world = currentWorld();
if (world === 'earth') void import('./earth');
else {
  // Hide Earth's panels straight away, before the other world's code has loaded.
  document.querySelector('#app')!.classList.add('other-world', 'no-sidebar');
  void import('./otherworlds').then(({ startOtherWorld }) => startOtherWorld(world));
}
