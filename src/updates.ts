import { isDesktop, loadSetting, openExternal, storeSetting } from './platform';

/** Where releases are published. */
const LATEST = 'https://api.github.com/repos/wjacobs20301/openorbit/releases/latest';
/** Automatic checks happen at most this often. */
const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;

interface Release {
  tag_name: string;
  name?: string;
  html_url: string;
  draft?: boolean;
  prerelease?: boolean;
}

/** "v1.2.3" → [1, 2, 3]. */
function parse(version: string): number[] {
  return version.replace(/^v/, '').split(/[.-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0);
}

function isNewer(latest: string, current: string): boolean {
  const a = parse(latest);
  const b = parse(current);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

async function currentVersion(): Promise<string> {
  const { getVersion } = await import('@tauri-apps/api/app');
  return getVersion();
}

/**
 * Checks GitHub for a newer release: at startup (once a day at most) when automatic checks
 * are on, and on demand from Help › Check for Updates. A newer version shows a notice with
 * Download, Later, and Skip This Version.
 */
export function setupUpdates(onMessage: (text: string) => void): { check(): Promise<void> } {
  const notice = document.createElement('div');
  notice.id = 'update-notice';
  notice.setAttribute('role', 'status');
  notice.hidden = true;
  document.querySelector('#globe')!.append(notice);

  const auto = document.querySelector<HTMLInputElement>('#auto-update')!;
  auto.checked = loadSetting('autoUpdate') !== 'off';
  auto.addEventListener('change', () => storeSetting('autoUpdate', auto.checked ? 'on' : 'off'));

  const show = (release: Release, current: string) => {
    const version = release.tag_name.replace(/^v/, '');
    notice.innerHTML = `
      <strong>OpenOrbit ${escape(version)} is available</strong>
      <span>You have ${escape(current)}. Download the new version to update.</span>
      <div class="row end">
        <button class="skip">Skip This Version</button>
        <button class="later">Later</button>
        <button class="download primary">Download</button>
      </div>`;
    notice.hidden = false;
    notice.querySelector('.download')!.addEventListener('click', () => {
      void openExternal(release.html_url);
      notice.hidden = true;
    });
    notice.querySelector('.later')!.addEventListener('click', () => (notice.hidden = true));
    notice.querySelector('.skip')!.addEventListener('click', () => {
      storeSetting('skippedVersion', version);
      notice.hidden = true;
    });
  };

  /** `manual` reports "up to date" and errors, and ignores a skipped version. */
  const run = async (manual: boolean) => {
    if (!isDesktop) {
      if (manual) onMessage('Updates are checked in the desktop app.');
      return;
    }
    try {
      const current = await currentVersion();
      const response = await fetch(LATEST, { headers: { Accept: 'application/vnd.github+json' } });
      // 404 means nothing has been published yet.
      if (response.status === 404) {
        if (manual) onMessage(`OpenOrbit ${current} is the latest version.`);
        return;
      }
      if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
      const release = (await response.json()) as Release;
      storeSetting('lastUpdateCheck', String(Date.now()));
      const version = release.tag_name.replace(/^v/, '');
      if (!isNewer(version, current)) {
        if (manual) onMessage(`OpenOrbit ${current} is the latest version.`);
        return;
      }
      if (!manual && loadSetting('skippedVersion') === version) return;
      // The notice says it all; clear "Checking for updates…".
      if (manual) onMessage('');
      show(release, current);
    } catch (err) {
      if (manual) onMessage(`Couldn't check for updates: ${(err as Error).message ?? err}`);
    }
  };

  // A few seconds after startup, so it doesn't compete with the first map tiles.
  const last = Number(loadSetting('lastUpdateCheck')) || 0;
  if (auto.checked && Date.now() - last > CHECK_EVERY_MS) window.setTimeout(() => void run(false), 5000);

  return { check: () => run(true) };
}

function escape(s: string): string {
  return s.replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`);
}
