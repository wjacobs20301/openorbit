import { convertFileSrc, invoke } from '@tauri-apps/api/core';

/** True when running inside the Tauri desktop shell rather than a plain browser. */
export const isDesktop = '__TAURI_INTERNALS__' in window;

/** `tiles://localhost/` on macOS/Linux, `http://tiles.localhost/` on Windows. */
const tilePrefix = isDesktop ? convertFileSrc('', 'tiles') : '';

/**
 * Route a remote URL (or URL template) through the desktop app's disk cache.
 * `https://host/a/{z}` becomes `<prefix>https/host/a/{z}` so template tags stay intact.
 * In a browser the URL is returned unchanged.
 */
export function viaCache(url: string): string {
  if (!isDesktop) return url;
  return tilePrefix + url.replace('://', '/');
}

export async function openExternal(url: string): Promise<void> {
  if (isDesktop) {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(url);
  } else {
    window.open(url, '_blank', 'noopener');
  }
}

/** Save text with a native "Save as" dialog on desktop, or a download in the browser. */
export async function saveTextFile(defaultName: string, contents: string): Promise<void> {
  if (isDesktop) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const path = await save({ defaultPath: defaultName, filters: [{ name: 'KML', extensions: ['kml'] }] });
    if (path) await invoke('write_text_file', { path, contents });
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([contents], { type: 'application/vnd.google-earth.kml+xml' }));
  a.download = defaultName;
  a.click();
  URL.revokeObjectURL(a.href);
}

export async function clearTileCache(): Promise<number> {
  return isDesktop ? invoke<number>('clear_tile_cache') : 0;
}

/** True when a key press is going into a text field, so global shortcuts should ignore it. */
export function isTyping(e: KeyboardEvent): boolean {
  return e.target instanceof Element && !!e.target.closest('input, select, textarea');
}

export function loadSetting(key: string): string {
  try {
    return localStorage.getItem(`openorbit.${key}`) ?? '';
  } catch {
    return '';
  }
}

export function storeSetting(key: string, value: string): void {
  try {
    localStorage.setItem(`openorbit.${key}`, value);
  } catch {
    // Storage can be unavailable (private mode); settings then last for the session only.
  }
}
