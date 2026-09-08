# NomadTracks for Nextcloud

A read-only web viewer for the library that the NomadTracks mobile app
(iOS / Android) syncs into the `NomadTracks/` folder of your Nextcloud
files.

## What it does

- Adds a **NomadTracks** entry to the Nextcloud navigation.
- Shows a **folder tree** of your synced `Tracks/`, `POIs/`, `Maps/`
  and `Routes/` folders in a left sidebar (nested folders included).
- Renders a **MapLibre GL** map on the right, using the same
  NomadTracks map server (`map.nomadtracks.app`) the mobile apps use.
- **Default view**: all POIs are placed as markers, and the first 50
  tracks are drawn as polylines. A "Load 50 more" button in the
  sidebar loads further tracks in batches (so large libraries do not
  fetch every GPX up front). Track colors come from the
  `.nomadmeta.json` sidecar written by the app (`colorHex`), falling
  back to `#1E88E5` when no sidecar exists.
- **Click a track** in the tree to load its GPX (if not already
  loaded), highlight it on the map and zoom to it.
- **Click a POI** to fly to its marker and open its name popup.
- **Click a route** (`.nomadroute` package) to draw the route line and
  its stop markers from the GPX embedded in the package, and zoom to
  it.
- **Maps** (`.nomadmap` custom map packages) are listed in the tree
  but are not rendered on the web map.

Everything is read-only: the app never writes to, moves, or deletes
the synced files. All file access happens in the browser through the
standard Nextcloud WebDAV endpoint with the logged-in user's own
session — there is no server-side parsing and no extra database.

The `_Trash/` and `Photos/` folders of the sync layout are ignored,
as are `.nomadmeta.json` sidecars (they are read only as metadata for
their data file, not shown as entries).

## Requirements

- Nextcloud 28 – 31.
- A NomadTracks library synced into the `NomadTracks/` folder at the
  root of the user's files (the mobile app's Nextcloud sync provider
  creates this). Without it, the app shows an explanatory empty state.
- The browser must be able to reach `https://map.nomadtracks.app`
  (basemap style, tiles, glyphs, sprites). Track/POI/route data never
  leaves your Nextcloud.

## Install

The app is plain PHP + JS — no build step, no dependencies to
install. MapLibre GL JS 5.24.0 is vendored into the app
(`js/vendor/maplibre-gl/maplibre-gl.js`,
`css/vendor/maplibre-gl/maplibre-gl.css`) because Nextcloud's
Content-Security-Policy blocks CDNs.

1. Copy this repository into your Nextcloud apps directory under the
   name `nomadtracks`:

   ```sh
   cd /path/to/nextcloud/apps
   git clone https://git.donkeyserver.eu/marco/nomadtracks-nextcloud_plugin.git nomadtracks
   ```

   (or `rsync` / `cp -r` the checkout — the directory name **must** be
   `nomadtracks`, matching the app id).

2. Enable it:

   ```sh
   sudo -u www-data php occ app:enable nomadtracks
   ```

   or via *Settings → Apps* in the web UI.

3. Open the **NomadTracks** entry in the navigation bar.

## File formats read

Defined by NomadTracks sync schema v1 (see the main repo,
`nomadtracks-addon/docs/sync-schema-v1.md`):

| File | Format | Used for |
|---|---|---|
| `Tracks/**/*.gpx` | GPX 1.1 | track polylines |
| `POIs/**/*.geojson` | single-Feature GeoJSON | POI markers (name, `color`) |
| `**/*.nomadmeta.json` | JSON sidecar | track color (`colorHex`) |
| `Routes/**/*.nomadroute` | `NMDRTE01` package (embedded GPX) | route line + stops |
| `Maps/**/*.nomadmap` | `NMDMAP01` package | listed only |

## License

AGPL-3.0-or-later. Vendored MapLibre GL JS is BSD-3-Clause
(see `js/vendor/maplibre-gl/LICENSE.txt`).
