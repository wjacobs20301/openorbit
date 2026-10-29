import { CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu } from '@tauri-apps/api/menu';

/** What the menus can do; implemented in main.ts. */
export interface AppActions {
  open(): void;
  saveKml(): void;
  saveImage(): void;
  googleMaps(): void;
  googleEarthWeb(): void;
  copyViewLocation(): void;
  find(): void;
  settings(): void;
  shortcuts(): void;
  addPlacemark(): void;
  addPath(): void;
  addPolygon(): void;
  ruler(): void;
  streetView(): void;
  northUp(): void;
  resetTilt(): void;
  resetTiltAndNorth(): void;
  /** On/off views, shown with checkmarks. */
  toggles: Record<ToggleId, { get(): boolean; set(on: boolean): void }>;
}

export type ToggleId = 'toolbar' | 'sidebar' | 'statusBar' | 'navigation' | 'atmosphere' | 'sun' | 'history';

/**
 * Native menu bar for the desktop app, laid out like Google Earth Pro's. Returns a
 * function that refreshes the checkmarks after something changes elsewhere.
 */
export async function setupMenu(a: AppActions): Promise<() => void> {
  const item = (text: string, action: () => void, accelerator?: string) => MenuItem.new({ text, action, accelerator });
  const separator = () => PredefinedMenuItem.new({ item: 'Separator' });
  const checks = new Map<ToggleId, CheckMenuItem>();
  const check = async (id: ToggleId, text: string, accelerator?: string) => {
    const t = a.toggles[id];
    const c = await CheckMenuItem.new({
      text,
      accelerator,
      checked: t.get(),
      action: () => {
        t.set(!t.get());
        void c.setChecked(t.get());
      },
    });
    checks.set(id, c);
    return c;
  };

  const appMenu = await Submenu.new({
    text: 'OpenOrbit',
    items: [
      await PredefinedMenuItem.new({ item: { About: { name: 'OpenOrbit' } } }),
      await separator(),
      await item('Settings…', a.settings, 'CmdOrCtrl+,'),
      await separator(),
      await PredefinedMenuItem.new({ item: 'Services' }),
      await separator(),
      await PredefinedMenuItem.new({ item: 'Hide' }),
      await PredefinedMenuItem.new({ item: 'HideOthers' }),
      await PredefinedMenuItem.new({ item: 'ShowAll' }),
      await separator(),
      await PredefinedMenuItem.new({ item: 'Quit' }),
    ],
  });

  const file = await Submenu.new({
    text: 'File',
    items: [
      await item('Open…', a.open, 'CmdOrCtrl+O'),
      await item('Save My Places as KML…', a.saveKml, 'CmdOrCtrl+S'),
      await separator(),
      await item('Save Image…', a.saveImage, 'Alt+CmdOrCtrl+S'),
      await separator(),
      await item('View in Google Maps', a.googleMaps),
      await item('View in Google Earth on Web', a.googleEarthWeb),
      await separator(),
      await PredefinedMenuItem.new({ item: 'CloseWindow' }),
    ],
  });

  // Text fields need the standard editing commands in the menu to get ⌘C/⌘V on macOS.
  const edit = await Submenu.new({
    text: 'Edit',
    items: [
      await PredefinedMenuItem.new({ item: 'Undo' }),
      await PredefinedMenuItem.new({ item: 'Redo' }),
      await separator(),
      await PredefinedMenuItem.new({ item: 'Cut' }),
      await PredefinedMenuItem.new({ item: 'Copy' }),
      await PredefinedMenuItem.new({ item: 'Paste' }),
      await PredefinedMenuItem.new({ item: 'SelectAll' }),
      await separator(),
      await item('Copy View Location', a.copyViewLocation, 'Shift+CmdOrCtrl+C'),
      await item('Find', a.find, 'CmdOrCtrl+F'),
    ],
  });

  const reset = await Submenu.new({
    text: 'Reset',
    items: [
      await item('Tilt (U)', a.resetTilt),
      await item('Compass (N)', a.northUp),
      await item('Tilt and Compass (R)', a.resetTiltAndNorth),
    ],
  });

  const view = await Submenu.new({
    text: 'View',
    items: [
      await check('toolbar', 'Toolbar', 'Alt+CmdOrCtrl+T'),
      await check('sidebar', 'Sidebar', 'Alt+CmdOrCtrl+B'),
      await check('statusBar', 'Status Bar'),
      await check('navigation', 'Show Navigation'),
      await separator(),
      await check('atmosphere', 'Atmosphere'),
      await check('sun', 'Sun'),
      await check('history', 'Historical Imagery'),
      await separator(),
      reset,
      await separator(),
      await PredefinedMenuItem.new({ item: 'Fullscreen' }),
    ],
  });

  const tools = await Submenu.new({
    text: 'Tools',
    items: [
      await item('Ruler', a.ruler, 'Alt+CmdOrCtrl+R'),
      await item('Street View', a.streetView),
      await separator(),
      await item('Save This View for Offline…', a.settings),
    ],
  });

  const add = await Submenu.new({
    text: 'Add',
    items: [
      await item('Placemark', a.addPlacemark, 'Shift+CmdOrCtrl+P'),
      await item('Path', a.addPath, 'Shift+CmdOrCtrl+T'),
      await item('Polygon', a.addPolygon, 'Shift+CmdOrCtrl+G'),
    ],
  });

  const windowMenu = await Submenu.new({
    text: 'Window',
    items: [await PredefinedMenuItem.new({ item: 'Minimize' }), await PredefinedMenuItem.new({ item: 'Maximize' })],
  });

  const help = await Submenu.new({
    text: 'Help',
    items: [await item('Keyboard Shortcuts', a.shortcuts, 'CmdOrCtrl+/')],
  });

  const menu = await Menu.new({ items: [appMenu, file, edit, view, tools, add, windowMenu, help] });
  await menu.setAsAppMenu();

  return () => {
    for (const [id, c] of checks) void c.setChecked(a.toggles[id].get());
  };
}
