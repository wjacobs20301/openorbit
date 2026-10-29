# OpenOrbit

An open-source desktop globe for macOS, Windows and Linux, built to fill the gap left by
Google Earth Pro. It reads public map data directly, so the project runs no servers.

## Features

- 3D globe with terrain (CesiumJS)
- Imagery: Sentinel-2 cloudless (world, 10 m) and USGS imagery (US, sub-metre)
- Optional sharp worldwide imagery with your own key: Esri World Imagery (ArcGIS
  Location Platform) or Mapbox Satellite; these are never written to the disk cache
- Time slider: Landsat back to 1984 (30 m), yearly Sentinel-2 from 2016, and a daily
  MODIS image for any date since February 2000 (250 m)
- Place search (Photon / OpenStreetMap)
- Place names, country/state borders and roads from OpenStreetMap vector tiles
- 3D buildings worldwide from OpenStreetMap (heights and colours from the map data)
- Optional Google Photorealistic 3D Tiles with your own Google Maps API key; search
  switches to Google's geocoder while they're on, as Google's terms require
- Placemarks, paths and polygons with colours, live length/area, saved between
  sessions and exported as styled KML
- Import KML/KMZ, GeoJSON, GPX, CSV (latitude/longitude columns) and shapefiles
  (zipped, or .shp with its .dbf/.prj), with no vertex limit; flat KML is draped on the terrain, the
  file's folders show as a tree with checkboxes, and **Keep** saves a file in My Places
- Click any feature for a details balloon (including KML ExtendedData/SchemaData)
- Elevation profile for paths and lines (distance, elevation range, climb, steepest grade)
- Opens where you left off, or at a start location you set; scale legend
- Distance measuring
- Street-level photos: Panoramax (no key), Mapillary (optional token), and a one-click
  "Open in Google Street View" button
- Disk tile cache on desktop, so places you've visited load instantly and work offline
- "Save this view for offline": prefetches the visible area (capped at 4,000 tiles)

## Layout and controls

The layout follows Google Earth Pro so it's familiar:

- **Toolbar:** hide sidebar · add placemark, polygon, path · historical imagery · sun ·
  ruler · save image · view in Google Maps · settings
- **Sidebar:** Search (with history), Places (My Places and Temporary Places for opened
  files, each with a show/hide checkbox), Layers (Imagery, Borders and Labels, Roads,
  3D Buildings, Street photos, Terrain, Atmosphere)
- **Navigation (top right):** look ring (drag to turn, N for north), move joystick,
  street view person, zoom slider
- **Status bar:** imagery date, pointer position, elevation, eye altitude
- **Menus (desktop app):** File, Edit, View, Tools, Add, Window, Help

| Action | Mouse / trackpad | Keyboard |
|---|---|---|
| Move | Drag | Arrow keys |
| Tilt and turn | Shift+drag (or middle-drag, Ctrl+drag) | Shift+arrows |
| Look around in place | Option/Alt+drag | |
| Zoom | Scroll / pinch, zoom slider | + and − |
| Reset north / tilt / both | Click N on the ring | N / U / R |
| Add placemark / polygon / path | Toolbar | ⇧⌘P / ⇧⌘G / ⇧⌘T |
| Sidebar · Search · Save image | | ⌥⌘B · ⌘F · ⌥⌘S |

Street view: drag the person from the navigation controls onto a blue line (it snaps to
the nearest photo), or click it and then click a blue line. The person on the map turns
with your view. In street view: drag or ←/→ to look around 360° photos, click the road to
move there (the ground cursor turns solid where there's a photo and shows ✕ where there
isn't), ↑/↓ (or W/S) to step along the route, F to expand the viewer. Moving keeps the
direction you're facing.

## Data sources

All endpoints live in [`src/sources.ts`](src/sources.ts). Update that file if a provider
moves an endpoint or changes its terms.

| Data | Source | Licence |
|---|---|---|
| World imagery | EOX Sentinel-2 cloudless 2025 (2016–2024 in the time slider) | CC BY-NC-SA 4.0 (non-commercial); 2016 is CC BY 4.0 |
| Historical imagery | NASA GIBS: Landsat WELD annual, MODIS Terra daily | Open, attribution requested |
| US imagery | USGS The National Map | Public domain |
| Terrain | AWS Terrain Tiles | Open data, attribution required |
| Search | Photon (komoot), OpenStreetMap | ODbL, fair use |
| Labels, borders, roads, buildings | OpenFreeMap vector tiles (OpenMapTiles schema) | ODbL, free with attribution |
| Sharp imagery (optional) | Esri World Imagery, Mapbox Satellite, user's own key | Provider terms; free tiers, attribution required |
| Photorealistic 3D (optional) | Google Map Tiles API + Geocoding API, user's own key | Google Maps Platform terms; billed to the user |
| Street photos | Panoramax, Mapillary | CC BY-SA 4.0 |

Please be a good citizen of these free services: keep the cache on and don't add bulk
"download a region" features for providers that forbid it.

## Development

Requires Node 20+ and Rust (via [rustup](https://rustup.rs)).

```bash
npm install
npm run tauri dev     # desktop app
npm run dev           # browser only, at http://localhost:1420
npm run tauri build   # installers for the current OS
```

## Releasing

Pushing a version tag builds installers for every platform on GitHub Actions
([`.github/workflows/release.yml`](.github/workflows/release.yml)) and attaches them to a
draft release:

```bash
git tag v0.1.0
git push origin v0.1.0
```

| Platform | Files |
|---|---|
| macOS (Apple Silicon and Intel) | `.dmg`, `.app.tar.gz` |
| Windows | `.msi`, `-setup.exe` |
| Linux | `.AppImage`, `.deb`, `.rpm` |

Review the draft on GitHub, then publish it. Bump `version` in `package.json`,
`src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json` before tagging.

Builds are unsigned. macOS shows an "unidentified developer" warning (right-click the app
and choose Open), and Windows SmartScreen asks for confirmation. To sign them, add an Apple
Developer ID and/or a Windows certificate as repository secrets; see Tauri's
[macOS](https://v2.tauri.app/distribute/sign/macos/) and
[Windows](https://v2.tauri.app/distribute/sign/windows/) signing guides.

Every push and pull request also runs [`ci.yml`](.github/workflows/ci.yml): front-end
type-check and build, plus `cargo clippy` on the desktop shell.

## Layout

- `src/` – web front end (TypeScript, CesiumJS)
  - `globe.ts` viewer and imagery layers, `terrain.ts` terrain from Terrarium tiles
  - `search.ts`, `places.ts` (saved places + KML export), `draw.ts` (paths/polygons),
    `measure.ts`, `streetview.ts`, `geometry.ts` (length/area)
  - `vectortiles.ts` tile loading, `overlay.ts` borders/roads, `labels.ts` place names
  - `buildings.ts` OpenStreetMap 3D buildings, `google3d.ts` Google 3D Tiles
  - `history.ts` time slider, `importer.ts` GIS file import, `offline.ts` area downloads
  - `platform.ts` desktop/browser helpers, `sources.ts` data endpoints
- `src-tauri/` – desktop shell (Rust): `tile_cache.rs` serves `tiles://` requests from disk

## Licence

MIT. Map data remains under its providers' licences; credits are shown on the globe.
