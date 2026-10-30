/** How long the Undo message stays up (ms). */
const UNDO_TIME = 6000;

let el: HTMLDivElement | undefined;
let timer = 0;

/** Shows "text  Undo" at the bottom of the globe; Undo runs `undo`. Replaces any earlier one. */
export function showUndo(text: string, undo: () => void): void {
  if (!el) {
    el = document.createElement('div');
    el.id = 'undo-toast';
    el.setAttribute('role', 'status');
    document.querySelector('#globe')!.append(el);
  }
  const toast = el;
  window.clearTimeout(timer);
  toast.innerHTML = '';
  const label = document.createElement('span');
  label.textContent = text;
  const button = document.createElement('button');
  button.textContent = 'Undo';
  button.addEventListener('click', () => {
    toast.hidden = true;
    window.clearTimeout(timer);
    undo();
  });
  toast.append(label, button);
  toast.hidden = false;
  timer = window.setTimeout(() => (toast.hidden = true), UNDO_TIME);
}
