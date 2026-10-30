/**
 * The filter box above Places: hides rows whose names don't contain the text, keeping
 * the folders that hold a match. Re-applies whenever a list redraws.
 */
export function setupPlacesFilter(): void {
  const input = document.querySelector<HTMLInputElement>('#places-filter')!;
  const tree = document.querySelector<HTMLElement>('#sidebar .tree')!;

  const apply = () => {
    const query = input.value.trim().toLowerCase();
    observer.disconnect();
    // Children come after their folder, so walking backwards settles them first.
    for (const li of [...tree.querySelectorAll('li')].reverse()) {
      if (!query) { li.hidden = false; continue; }
      const name = li.querySelector('.tree-name')?.textContent?.toLowerCase() ?? '';
      const childShown = [...li.querySelectorAll(':scope > ul > li')].some((c) => !(c as HTMLElement).hidden);
      li.hidden = !(name.includes(query) || childShown);
    }
    tree.classList.toggle('filtering', !!query);
    observer.observe(tree, { childList: true, subtree: true });
  };
  const observer = new MutationObserver(apply);

  input.addEventListener('input', apply);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && input.value) { input.value = ''; apply(); e.stopPropagation(); }
  });
  observer.observe(tree, { childList: true, subtree: true });
}
