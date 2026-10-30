import { KmlDataSource, type Viewer } from 'cesium';
import { dropToGround } from './importer';
import { fetchBytes, loadSetting, storeSetting } from './platform';
import { showUndo } from './toast';

/** A KML or KMZ on the web that is loaded, and optionally refreshed, by link (Add › Network Link). */
interface NetworkLink {
  id: string;
  name: string;
  url: string;
  /** Seconds between refreshes; 0 loads it once. */
  refresh: number;
  hidden?: boolean;
}

const STORAGE_KEY = 'networkLinks';

/** Network links in My Places: each keeps its own data source and refresh timer. */
export class NetworkLinks {
  private links: NetworkLink[] = [];
  private readonly sources = new Map<string, KmlDataSource>();
  private readonly timers = new Map<string, number>();
  private readonly errors = new Map<string, string>();
  private readonly list = document.querySelector<HTMLUListElement>('#network-list')!;
  private readonly dialog = document.querySelector<HTMLDialogElement>('#network-dialog')!;

  constructor(private readonly viewer: Viewer) {
    try {
      this.links = JSON.parse(loadSetting(STORAGE_KEY) || '[]');
    } catch {
      this.links = [];
    }
    this.links.forEach((l) => this.start(l));
    this.render();

    const form = this.dialog.querySelector('form')!;
    form.addEventListener('submit', (e) => {
      const submitter = (e as SubmitEvent).submitter as HTMLButtonElement | null;
      if (submitter?.value !== 'add') return;
      const data = new FormData(form);
      const url = String(data.get('url') ?? '').trim();
      if (!/^https?:\/\//i.test(url)) {
        e.preventDefault();
        form.querySelector<HTMLInputElement>('[name=url]')!.setCustomValidity('Enter a web address starting with https://');
        form.reportValidity();
        return;
      }
      const link: NetworkLink = {
        id: crypto.randomUUID(),
        name: String(data.get('name') ?? '').trim() || nameFromUrl(url),
        url,
        refresh: Number(data.get('refresh')) || 0,
      };
      this.links.push(link);
      this.persist();
      this.start(link, true);
      this.render();
      form.reset();
    });
    form.querySelector<HTMLInputElement>('[name=url]')!.addEventListener('input', (e) => (e.target as HTMLInputElement).setCustomValidity(''));
  }

  /** Opens the Add Network Link window. */
  choose(): void {
    this.dialog.showModal();
  }

  private persist(): void {
    storeSetting(STORAGE_KEY, JSON.stringify(this.links));
  }

  private async start(link: NetworkLink, flyTo = false): Promise<void> {
    const source = new KmlDataSource({ camera: this.viewer.scene.camera, canvas: this.viewer.scene.canvas });
    source.show = !link.hidden;
    this.sources.set(link.id, source);
    await this.viewer.dataSources.add(source);
    await this.load(link);
    if (flyTo && source.entities.values.length) void this.viewer.flyTo(source);
    if (link.refresh > 0) this.timers.set(link.id, window.setInterval(() => void this.load(link), link.refresh * 1000));
  }

  /** Fetches the link and replaces what's shown with the new contents. */
  private async load(link: NetworkLink): Promise<void> {
    const source = this.sources.get(link.id);
    if (!source) return;
    try {
      const bytes = await fetchBytes(link.url);
      await source.load(new Blob([bytes]), { clampToGround: true, sourceUri: link.url });
      dropToGround(source);
      this.errors.delete(link.id);
    } catch (err) {
      this.errors.set(link.id, `Couldn't load: ${(err as Error).message ?? err}`);
    }
    this.render();
    this.viewer.scene.requestRender();
  }

  private remove(link: NetworkLink): void {
    const index = this.links.indexOf(link);
    window.clearInterval(this.timers.get(link.id));
    this.timers.delete(link.id);
    const source = this.sources.get(link.id);
    if (source) this.viewer.dataSources.remove(source, true);
    this.sources.delete(link.id);
    this.links = this.links.filter((l) => l !== link);
    this.persist();
    this.render();
    showUndo(`Deleted ${link.name}`, () => {
      this.links.splice(Math.min(index, this.links.length), 0, link);
      this.persist();
      void this.start(link);
      this.render();
    });
  }

  private render(): void {
    this.list.replaceChildren(
      ...this.links.map((link) => {
        const li = document.createElement('li');
        const visible = document.createElement('input');
        visible.type = 'checkbox';
        visible.checked = !link.hidden;
        visible.title = 'Show on the map';
        visible.addEventListener('change', () => {
          link.hidden = !visible.checked || undefined;
          const source = this.sources.get(link.id);
          if (source) source.show = visible.checked;
          this.persist();
          this.viewer.scene.requestRender();
        });
        const icon = document.createElement('span');
        icon.className = 'kind-icon';
        icon.textContent = '🔗';
        const name = document.createElement('span');
        name.className = 'tree-name';
        name.textContent = link.name;
        const error = this.errors.get(link.id);
        li.title = error ?? `${link.url}${link.refresh ? `\nRefreshes every ${every(link.refresh)}` : ''}`;
        if (error) li.classList.add('failed');
        const go = button('Go', 'Fly to', () => {
          const source = this.sources.get(link.id);
          if (source) void this.viewer.flyTo(source);
        });
        const refresh = button('↻', 'Refresh now', () => void this.load(link));
        const remove = button('×', 'Delete network link', () => this.remove(link));
        li.append(visible, icon, name, go, refresh, remove);
        return li;
      }),
    );
  }
}

function nameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    return decodeURIComponent(u.pathname.split('/').pop() || u.hostname);
  } catch {
    return url;
  }
}

function every(seconds: number): string {
  return seconds < 60 ? `${seconds} s` : seconds < 3600 ? `${seconds / 60} min` : `${seconds / 3600} h`;
}

function button(text: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = text;
  b.title = title;
  b.addEventListener('click', onClick);
  return b;
}
