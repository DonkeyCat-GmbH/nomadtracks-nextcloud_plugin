# NomadTracks for Nextcloud

A read-only web viewer for the library that the NomadTracks mobile app
(iOS / Android) syncs into the `NomadTracks/` folder of your Nextcloud
files.

## What it does

- Adds a **NomadTracks** entry to the Nextcloud navigation.
- Three panes: **folder tree** on the left, **MapLibre GL map** in the
  middle, **details of the selected item** on the right. The map uses
  the same NomadTracks map server (`map.nomadtracks.app`) the mobile
  apps use. On viewports narrower than 900 px the details pane
  overlays the map instead of sitting beside it.
- The **folder tree** lists your synced `Tracks/`, `POIs/`, `Maps/`
  and `Routes/` folders, nested folders included.
- **Tracks are opt-in.** Each track row has a checkbox, unchecked by
  default, so the map starts with no tracks on it — the same way the
  mobile app only draws a track on the Live map when its "Show on
  Map" toggle is on. Ticking a box fetches that one GPX and draws it;
  unticking removes it and leaves every other track and all POI
  markers alone. A track that has been fetched once is kept in memory
  for the rest of the page visit, so re-ticking it does not refetch.
- **Click a track row** (not its checkbox) to select it: it is ticked
  if it wasn't, highlighted on the map, zoomed to, and its details
  open on the right.
- **All POIs** are placed as markers when the page loads. Click a
  marker or its tree row for its details.
- **Click a route** (`.nomadroute` package) to draw the route line and
  its stop markers from the GPX embedded in the package, zoom to it,
  and show its details.
- **Maps** (`.nomadmap` custom map packages) are listed in the tree
  but are not rendered on the web map.
- **Map type switcher** (top right): **Standard** and **Terrain**, the
  two styles the mobile apps offer (`/style.json` and
  `/style-topo.json` on the same server). The choice is remembered in
  the browser's local storage, and the tracks, highlight and POI
  markers currently on screen are re-applied after the switch.
- Track and POI colors come from the app's own data — `colorHex` in
  the `.nomadmeta.json` sidecar for tracks, `color` in the GeoJSON for
  POIs — falling back to `#1E88E5` when neither is present.

### Details pane

For a **track** (and, where they apply, for a route) the pane shows,
using the same labels as the app's track detail view: Distance,
Duration, Time in Motion, Avg Speed, Avg Moving Speed, Max Speed,
Pace, Avg. Pace, Elev. Gain, Elev. Loss, Max Elevation, Min Elevation,
Avg./Max./Min. Heartrate, Recorded, Points, and — when the sidecar
carries them — Rating, Category, Color, the number of photos it lists,
and the reverse-geocoded start location. Notes come from the GPX's
`<desc>`. Below the numbers is an **elevation profile** (distance
against altitude) drawn as an inline SVG with a hover readout — no
charting library, no CDN, since the Nextcloud CSP blocks both.

**A row is only shown when its value can actually be derived from the
files.** A GPX without timestamps (an imported line, a planned route)
shows distance and altitude rows only; a track without heart rate
shows no heart-rate rows. Nothing is estimated or filled in with a
placeholder.

Elevation gain and loss are computed with a JavaScript port of the
app's own `ElevationStats` filter — vertical-accuracy gate,
cadence-widened time-windowed median, threshold hysteresis with a
noise-scaled deadband — so the figures match what the app shows for
the same track rather than the much larger number a naive sum of
positive altitude deltas would give. `tests/elevation-smoke.js`
(`node tests/elevation-smoke.js`) checks that port, including against
gain/loss values taken from compiling the app's own Swift
implementation over the same inputs. When a GPX embeds its own
`<gpxtrkx:TrackStatsExtension>` totals (Bergfex and similar), those
are preferred over re-derivation for distance, ascent and descent —
which is what the mobile app does with the same files.

For a **POI**, the pane shows the fields its GeoJSON actually carries:
category, coordinates, altitude, horizontal accuracy, creation date,
color, folder, whether the app has it visible on its map, source, plus
notes and — from the sidecar — rating, photo count and address.

Everything is read-only: the app never writes to, moves, or deletes
the synced files. All file access happens in the browser through the
standard Nextcloud WebDAV endpoint with the logged-in user's own
session — there is no server-side parsing and no extra database.

The `_Trash/` and `Photos/` folders of the sync layout are ignored,
as are `.nomadmeta.json` sidecars (they are read only as metadata for
their data file, not shown as entries).

## Requirements

- Nextcloud 28 – 34 (the range declared in `appinfo/info.xml`).
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
| `Tracks/**/*.gpx` | GPX 1.1 | track polyline, per-point altitude / time / heart rate, name, notes |
| `POIs/**/*.geojson` | single-Feature GeoJSON | POI markers and their properties |
| `**/*.nomadmeta.json` | JSON sidecar | rating, color, category, photo count, address |
| `Routes/**/*.nomadroute` | `NMDRTE01` package (embedded GPX) | route line + stops |
| `Maps/**/*.nomadmap` | `NMDMAP01` package | listed only |

## Tests

```sh
node tests/elevation-smoke.js
```

Checks the elevation / track-stats port in `js/stats.js` — the only
part of this app with non-trivial numerics. There is no test harness
for the DOM or map code.

## License

AGPL-3.0-or-later. Vendored MapLibre GL JS is BSD-3-Clause
(see `js/vendor/maplibre-gl/LICENSE.txt`).
