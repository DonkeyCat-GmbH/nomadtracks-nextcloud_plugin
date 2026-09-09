/**
 * SPDX-FileCopyrightText: 2026 DonkeyCat GmbH <office@donkeycat.com>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * NomadTracks library viewer: folder tree of the synced
 * `NomadTracks/` folder on the left, MapLibre map in the middle,
 * details of the selected item on the right.
 * Read-only — this page never writes to the synced files.
 */
(function () {
	'use strict';

	const NT = window.NomadTracks || {};
	const F = NT.formats;
	const S = NT.stats;

	/** Root folder the mobile apps sync into (user's files root). */
	const LIBRARY_ROOT = 'NomadTracks';

	/**
	 * Style URLs of the NomadTracks map server — the same two styles
	 * the mobile apps offer (see `NomadTracksMapConfig.styleURL(for:)`
	 * in the iOS repo: Standard is `/style.json`, Terrain is
	 * `/style-topo.json`). The appkey is the same deliberately-public
	 * client key the apps ship: it exists so the server can refuse
	 * third-party scrapers, not as a secret.
	 */
	const APP_KEY = '8d94d1b903bf853f7b8602f2498e3249fe5d498d1498a1489a6aeaf52734f6e4';
	const MAP_TYPES = {
		standard: 'https://map.nomadtracks.app/style.json?appkey=' + APP_KEY,
		terrain: 'https://map.nomadtracks.app/style-topo.json?appkey=' + APP_KEY,
	};
	const MAP_TYPE_STORAGE_KEY = 'nomadtracks-map-type';

	const FETCH_CONCURRENCY = 6;

	const ROOTS = [
		{ dir: 'Tracks', kind: 'track', ext: '.gpx' },
		{ dir: 'POIs', kind: 'poi', ext: '.geojson' },
		{ dir: 'Maps', kind: 'map', ext: '.nomadmap' },
		{ dir: 'Routes', kind: 'route', ext: '.nomadroute' },
	];

	// ---- state ----------------------------------------------------

	let map = null;
	let mapReady = false;
	let mapType = 'standard';
	let mapTypeButtons = {};
	const items = { track: [], poi: [], map: [], route: [] };
	const sidecarPaths = new Set();
	let selectedItem = null;
	let selectedFeature = null;
	/** Where the chart scrubber currently points, or null. */
	let cursorFeature = null;
	let routeMarkers = [];
	let userMovedMap = false;

	const EMPTY_FC = { type: 'FeatureCollection', features: [] };

	function tr(text) {
		return typeof t === 'function' ? t('nomadtracks', text) : text;
	}

	// ---- library scan ---------------------------------------------

	async function scanLibrary() {
		const rootEntries = await NT.dav.listFolder(LIBRARY_ROOT);
		if (rootEntries === null) {
			return null;
		}
		const tree = [];
		for (const root of ROOTS) {
			const node = { name: root.dir, kind: root.kind, folders: [], items: [] };
			tree.push(node);
			const present = rootEntries.some(function (e) {
				return e.isDir && e.name === root.dir;
			});
			if (present) {
				await walkFolder(LIBRARY_ROOT + '/' + root.dir, root, node);
			}
		}
		// Pair sidecars with their data files (path minus extension).
		for (const kind of Object.keys(items)) {
			for (const item of items[kind]) {
				const sp = F.sidecarPathFor(item.path);
				item.sidecarPath = sidecarPaths.has(sp) ? sp : null;
			}
		}
		return tree;
	}

	async function walkFolder(path, root, node) {
		let entries;
		try {
			entries = await NT.dav.listFolder(path);
		} catch (e) {
			console.warn('nomadtracks: listing failed for', path, e);
			return;
		}
		if (!entries) {
			return;
		}
		for (const entry of entries) {
			if (entry.isDir) {
				const child = { name: entry.name, folders: [], items: [] };
				node.folders.push(child);
				await walkFolder(entry.path, root, child);
			} else if (F.isSidecarPath(entry.name)) {
				sidecarPaths.add(entry.path);
			} else if (entry.name.toLowerCase().endsWith(root.ext)) {
				const item = {
					kind: root.kind,
					name: entry.name.substring(0, entry.name.length - root.ext.length),
					path: entry.path,
					size: entry.size,
					sidecarPath: null,
					loaded: false,
					failed: false,
					checked: false,
					color: null,
					el: null,
					checkbox: null,
					loadPromise: null,
				};
				items[root.kind].push(item);
				node.items.push(item);
			}
			// Anything else (unknown extensions, files of another
			// library kind in the wrong root) is ignored, per schema §7.
		}
	}

	// ---- tree rendering -------------------------------------------

	function renderTree(tree) {
		const container = document.getElementById('nomadtracks-tree');
		container.textContent = '';
		for (const rootNode of tree) {
			const section = document.createElement('div');
			section.className = 'nt-root';
			const h = document.createElement('h3');
			h.textContent = rootNode.name + ' (' + countItems(rootNode) + ')';
			section.appendChild(h);
			section.appendChild(renderFolderContents(rootNode));
			container.appendChild(section);
		}
	}

	function countItems(node) {
		let n = node.items.length;
		for (const f of node.folders) {
			n += countItems(f);
		}
		return n;
	}

	function renderFolderContents(node) {
		const wrap = document.createElement('div');
		wrap.className = 'nt-children';
		for (const folder of node.folders) {
			const details = document.createElement('details');
			details.open = true;
			details.className = 'nt-folder';
			const summary = document.createElement('summary');
			summary.textContent = folder.name;
			details.appendChild(summary);
			details.appendChild(renderFolderContents(folder));
			wrap.appendChild(details);
		}
		for (const item of node.items) {
			wrap.appendChild(renderItem(item));
		}
		return wrap;
	}

	function renderItem(item) {
		const btn = document.createElement('button');
		btn.type = 'button';
		btn.className = 'nt-item nt-item-' + item.kind;
		const dot = document.createElement('span');
		dot.className = 'nt-dot';
		btn.appendChild(dot);
		const label = document.createElement('span');
		label.className = 'nt-label';
		label.textContent = item.name;
		btn.appendChild(label);
		btn.addEventListener('click', function () {
			onItemClick(item);
		});
		item.el = btn;

		if (item.kind !== 'track') {
			return btn;
		}

		// Tracks are opt-in, like the mobile app's "Show on Map"
		// toggle: nothing is drawn until its box is ticked, and the
		// GPX is only fetched at that moment.
		const row = document.createElement('div');
		row.className = 'nt-row';
		const box = document.createElement('input');
		box.type = 'checkbox';
		box.className = 'nt-check';
		box.checked = false;
		box.setAttribute('aria-label', tr('Show on map') + ': ' + item.name);
		box.title = tr('Show this track on the map');
		box.addEventListener('change', function () {
			onTrackToggle(item, box.checked);
		});
		item.checkbox = box;
		row.appendChild(box);
		row.appendChild(btn);
		return row;
	}

	function setItemColor(item) {
		if (item.el) {
			item.el.querySelector('.nt-dot').style.backgroundColor =
				item.color || F.DEFAULT_TRACK_COLOR;
		}
	}

	function markActive(item) {
		if (selectedItem && selectedItem.el) {
			selectedItem.el.classList.remove('nt-active');
		}
		selectedItem = item;
		if (item && item.el) {
			item.el.classList.add('nt-active');
		}
	}

	function setBusy(item, busy) {
		if (item.el) {
			item.el.classList.toggle('nt-busy', !!busy);
		}
	}

	function markFailed(item) {
		item.failed = true;
		if (item.el) {
			item.el.classList.add('nt-failed');
			item.el.title = tr('Could not load this file');
		}
	}

	// ---- map ------------------------------------------------------

	function storedMapType() {
		try {
			const stored = window.localStorage.getItem(MAP_TYPE_STORAGE_KEY);
			if (stored && Object.prototype.hasOwnProperty.call(MAP_TYPES, stored)) {
				return stored;
			}
		} catch (e) {
			// Storage can be unavailable (private mode, blocked
			// cookies) — fall back to the default silently.
		}
		return 'standard';
	}

	function rememberMapType(type) {
		try {
			window.localStorage.setItem(MAP_TYPE_STORAGE_KEY, type);
		} catch (e) {
			// Not fatal: the choice just won't survive a reload.
		}
	}

	/**
	 * Segmented Standard / Terrain switcher, styled like the other
	 * MapLibre controls so it sits naturally in the top-right stack.
	 */
	function MapTypeControl() {}

	MapTypeControl.prototype.onAdd = function () {
		const container = document.createElement('div');
		container.className = 'maplibregl-ctrl maplibregl-ctrl-group nt-maptype';
		mapTypeButtons = {};
		const labels = { standard: tr('Standard'), terrain: tr('Terrain') };
		for (const type of ['standard', 'terrain']) {
			const button = document.createElement('button');
			button.type = 'button';
			button.className = 'nt-maptype-button';
			button.textContent = labels[type];
			button.title = tr('Switch the base map');
			button.addEventListener('click', function () {
				setMapType(type);
			});
			mapTypeButtons[type] = button;
			container.appendChild(button);
		}
		this._container = container;
		updateMapTypeButtons();
		return container;
	};

	MapTypeControl.prototype.onRemove = function () {
		if (this._container && this._container.parentNode) {
			this._container.parentNode.removeChild(this._container);
		}
		mapTypeButtons = {};
	};

	function updateMapTypeButtons() {
		for (const type of Object.keys(mapTypeButtons)) {
			const active = type === mapType;
			mapTypeButtons[type].classList.toggle('nt-maptype-active', active);
			mapTypeButtons[type].setAttribute('aria-pressed', active ? 'true' : 'false');
		}
	}

	function setMapType(type) {
		if (type === mapType || !MAP_TYPES[type]) {
			return;
		}
		mapType = type;
		rememberMapType(type);
		updateMapTypeButtons();
		// setStyle drops every custom source and layer; `style.load`
		// below puts them back and re-pushes the current data.
		mapReady = false;
		map.setStyle(MAP_TYPES[type]);
	}

	function initMap() {
		mapType = storedMapType();
		map = new maplibregl.Map({
			container: 'nomadtracks-map',
			style: MAP_TYPES[mapType],
			center: [10, 30],
			zoom: 1.5,
			attributionControl: { compact: true },
		});
		map.addControl(new MapTypeControl(), 'top-right');
		map.addControl(new maplibregl.NavigationControl(), 'top-right');
		map.addControl(new maplibregl.ScaleControl());
		map.on('dragstart', function () {
			userMovedMap = true;
		});

		// Layer-scoped handlers live on the map, not on the style, so
		// they survive a style switch and must only be attached once.
		map.on('click', 'nt-tracks-line', function (e) {
			const f = e.features && e.features[0];
			if (f && f.properties && f.properties.path) {
				const hit = items.track.find(function (i) {
					return i.path === f.properties.path;
				});
				if (hit) {
					onItemClick(hit);
					return;
				}
			}
			if (f && f.properties && f.properties.name) {
				new maplibregl.Popup()
					.setLngLat(e.lngLat)
					.setText(f.properties.name)
					.addTo(map);
			}
		});
		map.on('mouseenter', 'nt-tracks-line', function () {
			map.getCanvas().style.cursor = 'pointer';
		});
		map.on('mouseleave', 'nt-tracks-line', function () {
			map.getCanvas().style.cursor = '';
		});

		// Fires for the initial style and again after every
		// `setMapType`, which is what makes the switcher safe.
		map.on('style.load', function () {
			addOverlayLayers();
			mapReady = true;
			refreshTrackSource();
			pushSelectedFeature();
			pushCursorFeature();
		});
	}

	function addOverlayLayers() {
		map.addSource('nt-tracks', { type: 'geojson', data: EMPTY_FC });
		map.addLayer({
			id: 'nt-tracks-line',
			type: 'line',
			source: 'nt-tracks',
			layout: { 'line-join': 'round', 'line-cap': 'round' },
			paint: {
				'line-color': ['get', 'color'],
				'line-width': 3,
				'line-opacity': 0.85,
			},
		});
		map.addSource('nt-selected', { type: 'geojson', data: EMPTY_FC });
		map.addLayer({
			id: 'nt-selected-halo',
			type: 'line',
			source: 'nt-selected',
			layout: { 'line-join': 'round', 'line-cap': 'round' },
			paint: { 'line-color': '#ffffff', 'line-width': 8, 'line-opacity': 0.9 },
		});
		map.addLayer({
			id: 'nt-selected-line',
			type: 'line',
			source: 'nt-selected',
			layout: { 'line-join': 'round', 'line-cap': 'round' },
			paint: { 'line-color': ['get', 'color'], 'line-width': 4 },
		});
		// Chart scrubber dot, styled like the app's `nomad-cursor`
		// layer: the track's own colour inside a white ring. Added
		// last so it sits above every line.
		map.addSource('nt-cursor', { type: 'geojson', data: EMPTY_FC });
		map.addLayer({
			id: 'nt-cursor-dot',
			type: 'circle',
			source: 'nt-cursor',
			paint: {
				'circle-radius': 6.5,
				'circle-color': ['get', 'color'],
				'circle-stroke-color': '#ffffff',
				'circle-stroke-width': 2.5,
			},
		});
	}

	/**
	 * Re-publish the collection of ticked tracks. One source holding
	 * every checked track means adding or removing one track never
	 * touches the others — and POI markers are DOM elements, so they
	 * are untouched by this and by a style switch.
	 */
	function refreshTrackSource() {
		if (!mapReady) {
			return;
		}
		const features = items.track
			.filter(function (i) { return i.checked && i.loaded && i.feature; })
			.map(function (i) { return i.feature; });
		map.getSource('nt-tracks').setData({
			type: 'FeatureCollection',
			features: features,
		});
	}

	function setSelectedFeature(feature) {
		selectedFeature = feature || null;
		// A stale dot from the previously scrubbed track would sit on
		// the map with nothing pointing at it.
		cursorFeature = null;
		pushCursorFeature();
		for (const m of routeMarkers) {
			m.remove();
		}
		routeMarkers = [];
		pushSelectedFeature();
	}

	function pushSelectedFeature() {
		if (!mapReady) {
			return;
		}
		map.getSource('nt-selected').setData(
			selectedFeature
				? { type: 'FeatureCollection', features: [selectedFeature] }
				: EMPTY_FC
		);
	}

	/**
	 * Move the chart-scrubber dot to `sample` (a profile sample, which
	 * carries the lat/lon it was measured at), or clear it with null.
	 * `color` paints the dot in the scrubbed track's own colour.
	 */
	function setCursorSample(sample, color) {
		cursorFeature = sample
			&& Number.isFinite(sample.lat) && Number.isFinite(sample.lon)
			? {
				type: 'Feature',
				geometry: { type: 'Point', coordinates: [sample.lon, sample.lat] },
				properties: { color: color || F.DEFAULT_TRACK_COLOR },
			}
			: null;
		pushCursorFeature();
	}

	function pushCursorFeature() {
		if (!mapReady) {
			return;
		}
		map.getSource('nt-cursor').setData(
			cursorFeature
				? { type: 'FeatureCollection', features: [cursorFeature] }
				: EMPTY_FC
		);
	}

	function boundsOfSegments(segments) {
		const b = new maplibregl.LngLatBounds();
		for (const seg of segments) {
			for (const c of seg) {
				b.extend(c);
			}
		}
		return b;
	}

	function fitBounds(b) {
		if (!b.isEmpty()) {
			map.fitBounds(b, { padding: 60, maxZoom: 15 });
		}
	}

	// ---- loading --------------------------------------------------

	/**
	 * Fetch + parse a track once. The parsed geometry, stats and
	 * sidecar stay on the item for the rest of the session, so
	 * re-ticking a box never refetches.
	 */
	function loadTrack(item) {
		if (item.loaded || item.failed) {
			return Promise.resolve();
		}
		if (!item.loadPromise) {
			item.loadPromise = loadTrackOnce(item).catch(function (e) {
				markFailed(item);
				console.warn('nomadtracks:', e);
			});
		}
		return item.loadPromise;
	}

	async function loadTrackOnce(item) {
		const jobs = [NT.dav.getText(item.path)];
		if (item.sidecarPath) {
			jobs.push(NT.dav.getText(item.sidecarPath).catch(function () {
				return null;
			}));
		}
		const results = await Promise.all(jobs);
		const parsed = F.parseGpx(results[0]);
		if (!parsed || parsed.segments.length === 0) {
			throw new Error('no track geometry in ' + item.path);
		}
		const sidecar = results.length > 1 && results[1]
			? F.parseSidecar(results[1])
			: null;
		item.sidecar = sidecar;
		item.gpx = parsed;
		item.color = (sidecar && sidecar.colorHex) || F.DEFAULT_TRACK_COLOR;
		item.segments = parsed.segments;
		item.detail = deriveTrackDetail(parsed);
		item.feature = {
			type: 'Feature',
			properties: { path: item.path, name: item.name, color: item.color },
			geometry: { type: 'MultiLineString', coordinates: parsed.segments },
		};
		item.loaded = true;
		setItemColor(item);
	}

	/**
	 * Everything the details panel shows, derived from the GPX alone
	 * (plus the file's own `TrackStatsExtension` when it carries one).
	 * Any value that cannot be derived stays null and its row is
	 * omitted — nothing here is ever guessed.
	 */
	function deriveTrackDetail(parsed) {
		const points = [];
		for (const seg of parsed.pointSegments) {
			for (const p of seg) {
				points.push(p);
			}
		}
		const source = parsed.sourceStats;

		const timed = points.filter(function (p) {
			return Number.isFinite(p.timestamp);
		});
		const startedAt = timed.length > 0 ? timed[0].timestamp : null;
		let durationSeconds = null;
		if (source && Number.isFinite(source.totalElapsedSeconds)) {
			durationSeconds = source.totalElapsedSeconds;
		} else if (timed.length >= 2) {
			durationSeconds = timed[timed.length - 1].timestamp - timed[0].timestamp;
		}

		const distanceMeters = source && Number.isFinite(source.distanceMeters)
			? source.distanceMeters
			: S.totalDistance(points);

		// The elevation filter is a time-domain algorithm: it needs a
		// timestamp per sample. Points without one are not fed to it
		// (and a track without any timestamps simply shows no gain /
		// loss rather than a number derived from a different method).
		const elevationPoints = points.filter(function (p) {
			return Number.isFinite(p.altitude) && Number.isFinite(p.timestamp);
		});
		const derived = elevationPoints.length >= 2
			? S.elevationStats(elevationPoints)
			: null;
		const gain = source && Number.isFinite(source.ascentMeters)
			? source.ascentMeters
			: (derived ? derived.gain : null);
		const loss = source && Number.isFinite(source.descentMeters)
			? source.descentMeters
			: (derived ? derived.loss : null);

		const stats = S.trackStats(points, distanceMeters, durationSeconds || 0);

		return {
			points: points,
			pointCount: points.length,
			startedAt: startedAt,
			durationSeconds: durationSeconds,
			distanceMeters: distanceMeters,
			elevationGain: gain,
			elevationLoss: loss,
			elevationFromFile: !!(source && source.hasTrustedFields
				&& (Number.isFinite(source.ascentMeters)
					|| Number.isFinite(source.descentMeters))),
			stats: stats,
			profile: buildProfile(points),
		};
	}

	/**
	 * Elevation profile samples: cumulative distance (m) against
	 * altitude (m), for the points that actually carry an `<ele>`.
	 * Empty when the file has fewer than two of them.
	 */
	function buildProfile(points) {
		const cumulative = S.cumulativeDistance(points);
		const samples = [];
		for (let i = 0; i < points.length; i++) {
			if (Number.isFinite(points[i].altitude)) {
				// lat/lon ride along so scrubbing the chart can put a
				// dot at that point on the map (the app's chart
				// scrubber).
				samples.push({
					d: cumulative[i],
					a: points[i].altitude,
					lat: points[i].lat,
					lon: points[i].lon,
				});
			}
		}
		return samples.length >= 2 ? samples : [];
	}

	async function loadPoi(item) {
		if (item.loaded || item.failed) {
			return;
		}
		try {
			const jobs = [NT.dav.getText(item.path)];
			if (item.sidecarPath) {
				jobs.push(NT.dav.getText(item.sidecarPath).catch(function () {
					return null;
				}));
			}
			const results = await Promise.all(jobs);
			const poi = F.parsePoi(results[0]);
			if (!poi) {
				throw new Error('not a POI GeoJSON: ' + item.path);
			}
			item.poi = poi;
			item.sidecar = results.length > 1 && results[1]
				? F.parseSidecar(results[1])
				: null;
			item.color = poi.color || F.DEFAULT_TRACK_COLOR;
			item.marker = new maplibregl.Marker({ color: item.color })
				.setLngLat([poi.lon, poi.lat])
				.setPopup(new maplibregl.Popup({ offset: 24 })
					.setText(poi.name || item.name))
				.addTo(map);
			item.marker.getElement().addEventListener('click', function () {
				markActive(item);
				showPoiDetails(item);
			});
			item.loaded = true;
			setItemColor(item);
		} catch (e) {
			markFailed(item);
			console.warn('nomadtracks:', e);
		}
	}

	function updateFooter() {
		const footer = document.getElementById('nomadtracks-sidebar-footer');
		const countEl = document.getElementById('nomadtracks-track-count');
		const total = items.track.length;
		if (total === 0) {
			footer.hidden = true;
			return;
		}
		footer.hidden = false;
		const shown = items.track.filter(function (i) {
			return i.checked && i.loaded;
		}).length;
		countEl.textContent = tr('Tracks on map:') + ' ' + shown + ' / ' + total;
	}

	// ---- selection ------------------------------------------------

	async function onTrackToggle(item, checked) {
		item.checked = checked;
		if (checked) {
			setBusy(item, true);
			await loadTrack(item);
			setBusy(item, false);
			if (!item.loaded) {
				item.checked = false;
				if (item.checkbox) {
					item.checkbox.checked = false;
				}
				showToast(tr('Could not load this track.'));
				updateFooter();
				return;
			}
		} else if (selectedItem === item) {
			// Untick the track that is currently highlighted: drop the
			// highlight and the details panel too, so the map really is
			// free of it. Other tracks are unaffected.
			markActive(null);
			setSelectedFeature(null);
			hideDetails();
		}
		refreshTrackSource();
		updateFooter();
	}

	function onItemClick(item) {
		markActive(item);
		if (item.kind === 'track') {
			selectTrack(item);
		} else if (item.kind === 'poi') {
			selectPoi(item);
		} else if (item.kind === 'route') {
			selectRoute(item);
		} else if (item.kind === 'map') {
			hideDetails();
			showToast(tr('Custom map packages (.nomadmap) are listed here but not rendered on the web map.'));
		}
	}

	async function selectTrack(item) {
		setBusy(item, true);
		await loadTrack(item);
		setBusy(item, false);
		if (!item.loaded) {
			showToast(tr('Could not load this track.'));
			return;
		}
		// Selecting implies showing: tick the box if it wasn't.
		item.checked = true;
		if (item.checkbox) {
			item.checkbox.checked = true;
		}
		refreshTrackSource();
		updateFooter();
		setSelectedFeature(item.feature);
		fitBounds(boundsOfSegments(item.segments));
		showTrackDetails(item);
	}

	async function selectPoi(item) {
		await loadPoi(item);
		if (!item.loaded) {
			showToast(tr('Could not load this POI.'));
			return;
		}
		map.flyTo({ center: [item.poi.lon, item.poi.lat], zoom: 14 });
		if (item.marker && !item.marker.getPopup().isOpen()) {
			item.marker.togglePopup();
		}
		showPoiDetails(item);
	}

	async function selectRoute(item) {
		try {
			if (!item.route) {
				const jobs = [NT.dav.getBinary(item.path)];
				if (item.sidecarPath) {
					jobs.push(NT.dav.getText(item.sidecarPath).catch(function () {
						return null;
					}));
				}
				const results = await Promise.all(jobs);
				const pkg = F.parseRoutePackage(results[0]);
				if (!pkg || !pkg.gpx || pkg.gpx.segments.length === 0) {
					throw new Error('no route geometry in ' + item.path);
				}
				let color = F.normalizeColor(pkg.meta.colorHex);
				const sidecar = results.length > 1 && results[1]
					? F.parseSidecar(results[1])
					: null;
				if (!color && sidecar && sidecar.colorHex) {
					color = sidecar.colorHex;
				}
				item.route = pkg;
				item.sidecar = sidecar;
				item.detail = deriveTrackDetail(pkg.gpx);
				item.color = color || F.DEFAULT_TRACK_COLOR;
				item.loaded = true;
				setItemColor(item);
			}
			const gpx = item.route.gpx;
			setSelectedFeature({
				type: 'Feature',
				properties: { path: item.path, name: item.name, color: item.color },
				geometry: { type: 'MultiLineString', coordinates: gpx.segments },
			});
			for (const wpt of gpx.waypoints) {
				const marker = new maplibregl.Marker({ color: item.color, scale: 0.8 })
					.setLngLat([wpt.lon, wpt.lat]);
				if (wpt.name) {
					marker.setPopup(new maplibregl.Popup({ offset: 24 }).setText(wpt.name));
				}
				marker.addTo(map);
				routeMarkers.push(marker);
			}
			fitBounds(boundsOfSegments(gpx.segments));
			showRouteDetails(item);
		} catch (e) {
			markFailed(item);
			console.warn('nomadtracks:', e);
			showToast(tr('Could not load this route.'));
		}
	}

	// ---- details panel --------------------------------------------

	function detailsPanel() {
		return document.getElementById('nomadtracks-details');
	}

	function hideDetails() {
		const panel = detailsPanel();
		panel.hidden = true;
		document.getElementById('nomadtracks-details-body').textContent = '';
		document.getElementById('nomadtracks-details-title').textContent = '';
		document.getElementById('nomadtracks-app').classList.remove('nt-has-details');
	}

	function openDetails(title) {
		const panel = detailsPanel();
		panel.hidden = false;
		document.getElementById('nomadtracks-app').classList.add('nt-has-details');
		document.getElementById('nomadtracks-details-title').textContent = title;
		const body = document.getElementById('nomadtracks-details-body');
		body.textContent = '';
		body.scrollTop = 0;
		return body;
	}

	function makeEl(tag, className, text) {
		const el = document.createElement(tag);
		if (className) {
			el.className = className;
		}
		if (text !== undefined && text !== null) {
			el.textContent = text;
		}
		return el;
	}

	/** A stat tile. Skipped entirely when `value` is null / empty. */
	function addStat(grid, label, value, hint) {
		if (value === null || value === undefined || value === '') {
			return;
		}
		const cell = makeEl('div', 'nt-stat');
		cell.appendChild(makeEl('span', 'nt-stat-label', label));
		cell.appendChild(makeEl('span', 'nt-stat-value', value));
		if (hint) {
			cell.title = hint;
		}
		grid.appendChild(cell);
	}

	function addSection(body, title) {
		const section = makeEl('section', 'nt-section');
		if (title) {
			section.appendChild(makeEl('h3', null, title));
		}
		body.appendChild(section);
		return section;
	}

	function formatDateTime(epochSeconds) {
		if (!Number.isFinite(epochSeconds)) {
			return null;
		}
		const d = new Date(epochSeconds * 1000);
		if (Number.isNaN(d.getTime())) {
			return null;
		}
		try {
			return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
		} catch (e) {
			return d.toLocaleString();
		}
	}

	function formatRating(rating) {
		if (!Number.isFinite(rating) || rating <= 0) {
			return null;
		}
		const stars = Math.max(0, Math.min(5, Math.round(rating)));
		return '★'.repeat(stars) + '☆'.repeat(5 - stars);
	}

	function formatAddress(address) {
		if (!address) {
			return null;
		}
		const line1 = address.street;
		const line2 = [address.postalCode, address.city].filter(Boolean).join(' ');
		const line3 = [address.region, address.country].filter(Boolean).join(', ');
		const lines = [line1, line2, line3].filter(function (l) { return l; });
		return lines.length > 0 ? lines.join('\n') : null;
	}

	/** Header: colour swatch + what kind of file this is. */
	function addHeader(body, item, kindLabel) {
		const header = makeEl('div', 'nt-details-meta');
		const swatch = makeEl('span', 'nt-details-swatch');
		swatch.style.backgroundColor = item.color || F.DEFAULT_TRACK_COLOR;
		header.appendChild(swatch);
		header.appendChild(makeEl('span', 'nt-details-kind', kindLabel));
		body.appendChild(header);
		const pathEl = makeEl('p', 'nt-details-path', item.path);
		pathEl.title = item.path;
		body.appendChild(pathEl);
	}

	function showTrackDetails(item) {
		const d = item.detail;
		const gpx = item.gpx;
		const body = openDetails(
			(gpx && gpx.name) ? gpx.name : item.name
		);
		addHeader(body, item, tr('Track'));
		buildTrackBody(body, item, d, gpx, tr('Recorded'));
	}

	function showRouteDetails(item) {
		const d = item.detail;
		const gpx = item.route ? item.route.gpx : null;
		const meta = item.route ? item.route.meta : null;
		const name = (meta && typeof meta.name === 'string' && meta.name)
			|| (gpx && gpx.name)
			|| item.name;
		const body = openDetails(name);
		addHeader(body, item, tr('Route'));
		buildTrackBody(body, item, d, gpx, tr('First point'));
		if (gpx && gpx.waypoints.length > 0) {
			const section = addSection(body, tr('Stops'));
			const list = makeEl('ul', 'nt-list');
			for (const wpt of gpx.waypoints) {
				list.appendChild(makeEl('li', null, wpt.name || tr('Unnamed stop')));
			}
			section.appendChild(list);
		}
	}

	/**
	 * The shared stat grid + elevation profile + notes. Used for both
	 * tracks and routes: a route simply has no timestamps, so every
	 * time-derived row omits itself.
	 */
	function buildTrackBody(body, item, d, gpx, dateLabel) {
		if (!d) {
			return;
		}
		const stats = d.stats;
		const grid = makeEl('div', 'nt-stats');

		addStat(grid, tr('Distance'), S.formatDistance(d.distanceMeters));
		addStat(grid, tr('Duration'), d.durationSeconds !== null
			? S.formatDuration(d.durationSeconds) : null);
		addStat(grid, tr('Time in Motion'), stats.movingTimeSeconds !== null
			? S.formatDuration(stats.movingTimeSeconds) : null);
		addStat(grid, tr('Avg Speed'), S.formatSpeed(stats.avgSpeedMps));
		addStat(grid, tr('Avg Moving Speed'), S.formatSpeed(stats.avgMovingSpeedMps));
		addStat(grid, tr('Max Speed'), S.formatSpeed(stats.maxSpeedMps));
		addStat(grid, tr('Pace'), stats.movingTimeSeconds !== null
			? S.formatPace(stats.movingTimeSeconds, d.distanceMeters) : null);
		addStat(grid, tr('Avg. Pace'), d.durationSeconds !== null
			? S.formatPace(d.durationSeconds, d.distanceMeters) : null);

		const elevationHint = d.elevationFromFile
			? tr('Taken from the totals embedded in the GPX file, as the mobile app does.')
			: tr('Computed with the same filter the mobile app uses.');
		addStat(grid, tr('Elev. Gain'), d.elevationGain !== null
			? S.formatElevation(d.elevationGain) : null, elevationHint);
		addStat(grid, tr('Elev. Loss'), d.elevationLoss !== null
			? S.formatElevation(d.elevationLoss) : null, elevationHint);
		addStat(grid, tr('Max Elevation'), stats.maxAltitudeMeters !== null
			? S.formatElevation(stats.maxAltitudeMeters) : null);
		addStat(grid, tr('Min Elevation'), stats.minAltitudeMeters !== null
			? S.formatElevation(stats.minAltitudeMeters) : null);

		if (stats.avgHeartRateBpm !== null) {
			addStat(grid, tr('Avg. Heartrate'),
				Math.round(stats.avgHeartRateBpm) + ' bpm');
			addStat(grid, tr('Max. Heartrate'),
				Math.round(stats.maxHeartRateBpm) + ' bpm');
			addStat(grid, tr('Min. Heartrate'),
				Math.round(stats.minHeartRateBpm) + ' bpm');
		}

		addStat(grid, dateLabel, formatDateTime(d.startedAt));
		addStat(grid, tr('Points'), d.pointCount > 0
			? d.pointCount.toLocaleString() : null);

		const sidecar = item.sidecar;
		if (sidecar) {
			addStat(grid, tr('Rating'), formatRating(sidecar.rating));
			if (sidecar.category && sidecar.category !== 'unspecified') {
				addStat(grid, tr('Category'), sidecar.category);
			}
			if (sidecar.colorHex) {
				addStat(grid, tr('Color'), sidecar.colorHex);
			}
			if (Number.isFinite(sidecar.photoCount) && sidecar.photoCount > 0) {
				addStat(grid, tr('Photos in sidecar'), String(sidecar.photoCount));
			}
		}

		if (grid.childElementCount > 0) {
			body.appendChild(grid);
		}

		const profile = elevationProfile(d.profile, function (sample) {
			setCursorSample(sample, item.color);
		});
		if (profile) {
			const section = addSection(body, tr('Elevation profile'));
			section.appendChild(profile);
		}

		const notes = gpx && gpx.description ? gpx.description : '';
		if (notes) {
			const section = addSection(body, tr('Notes'));
			section.appendChild(makeEl('p', 'nt-notes', notes));
		}

		const address = sidecar ? formatAddress(sidecar.address) : null;
		if (address) {
			const section = addSection(body, tr('Start Location'));
			section.appendChild(makeEl('p', 'nt-address', address));
		}
	}

	function showPoiDetails(item) {
		const poi = item.poi;
		if (!poi) {
			return;
		}
		const body = openDetails(poi.name || item.name);
		addHeader(body, item, tr('Point of interest'));

		const grid = makeEl('div', 'nt-stats');
		addStat(grid, tr('Category'),
			poi.categoryDisplayName || (poi.category !== 'unspecified' ? poi.category : ''));
		addStat(grid, tr('Coordinates'),
			poi.lat.toFixed(5) + ', ' + poi.lon.toFixed(5));
		addStat(grid, tr('Altitude'), poi.altitude !== null
			? S.formatElevation(poi.altitude) : null);
		addStat(grid, tr('Accuracy'), poi.horizontalAccuracy !== null
			? '±' + S.formatElevation(poi.horizontalAccuracy) : null);
		if (poi.createdAt) {
			const ms = Date.parse(poi.createdAt);
			addStat(grid, tr('Created'), Number.isFinite(ms)
				? formatDateTime(ms / 1000) : poi.createdAt);
		}
		addStat(grid, tr('Color'), poi.color);
		addStat(grid, tr('Folder'), poi.folderPath || poi.folder);
		addStat(grid, tr('Shown on map in the app'),
			poi.isVisibleOnMap ? tr('Yes') : tr('No'));
		addStat(grid, tr('Source'), poi.source);
		if (item.sidecar) {
			addStat(grid, tr('Rating'), formatRating(item.sidecar.rating));
			if (Number.isFinite(item.sidecar.photoCount) && item.sidecar.photoCount > 0) {
				addStat(grid, tr('Photos in sidecar'), String(item.sidecar.photoCount));
			}
		}
		if (grid.childElementCount > 0) {
			body.appendChild(grid);
		}

		if (poi.notes) {
			const section = addSection(body, tr('Notes'));
			section.appendChild(makeEl('p', 'nt-notes', poi.notes));
		}
		const address = item.sidecar ? formatAddress(item.sidecar.address) : null;
		if (address) {
			const section = addSection(body, tr('Address'));
			section.appendChild(makeEl('p', 'nt-address', address));
		}
	}

	// ---- elevation profile (inline SVG, no charting library) -------

	const SVG_NS = 'http://www.w3.org/2000/svg';
	const CHART_W = 320;
	const CHART_H = 140;
	const CHART_PAD = { top: 8, right: 8, bottom: 20, left: 38 };
	/** Cap the drawn samples; a 10 000-point GPX needs no more. */
	const CHART_MAX_SAMPLES = 500;

	function svgEl(name, attrs) {
		const el = document.createElementNS(SVG_NS, name);
		for (const key of Object.keys(attrs || {})) {
			el.setAttribute(key, attrs[key]);
		}
		return el;
	}

	/**
	 * Distance (X) against altitude (Y) as a plain inline SVG —
	 * no charting library and no CDN, both of which the Nextcloud CSP
	 * would block anyway. Returns null when the file has no usable
	 * elevation data.
	 */
	function elevationProfile(samples, onScrub) {
		if (!samples || samples.length < 2) {
			return null;
		}
		const step = Math.ceil(samples.length / CHART_MAX_SAMPLES);
		const data = [];
		for (let i = 0; i < samples.length; i += step) {
			data.push(samples[i]);
		}
		if (data[data.length - 1] !== samples[samples.length - 1]) {
			data.push(samples[samples.length - 1]);
		}

		const maxD = data[data.length - 1].d;
		let minA = data[0].a;
		let maxA = data[0].a;
		for (const s of data) {
			if (s.a < minA) { minA = s.a; }
			if (s.a > maxA) { maxA = s.a; }
		}
		if (maxD <= 0) {
			return null;
		}
		// A perfectly flat track would divide by zero; give it a
		// nominal 1 m band so the line lands in the middle.
		const spanA = maxA - minA > 0.5 ? maxA - minA : 1;
		const plotW = CHART_W - CHART_PAD.left - CHART_PAD.right;
		const plotH = CHART_H - CHART_PAD.top - CHART_PAD.bottom;
		const x = function (d) {
			return CHART_PAD.left + (d / maxD) * plotW;
		};
		const y = function (a) {
			return CHART_PAD.top + plotH - ((a - minA) / spanA) * plotH;
		};

		const wrap = makeEl('div', 'nt-chart');
		const svg = svgEl('svg', {
			viewBox: '0 0 ' + CHART_W + ' ' + CHART_H,
			class: 'nt-chart-svg',
			role: 'img',
			'aria-label': tr('Elevation profile: altitude against distance'),
		});

		// Baseline + axis frame.
		svg.appendChild(svgEl('line', {
			class: 'nt-chart-axis',
			x1: CHART_PAD.left, y1: CHART_PAD.top,
			x2: CHART_PAD.left, y2: CHART_PAD.top + plotH,
		}));
		svg.appendChild(svgEl('line', {
			class: 'nt-chart-axis',
			x1: CHART_PAD.left, y1: CHART_PAD.top + plotH,
			x2: CHART_PAD.left + plotW, y2: CHART_PAD.top + plotH,
		}));

		let line = '';
		for (let i = 0; i < data.length; i++) {
			line += (i === 0 ? 'M' : 'L') + x(data[i].d).toFixed(2)
				+ ' ' + y(data[i].a).toFixed(2);
		}
		const areaPath = line
			+ 'L' + x(data[data.length - 1].d).toFixed(2) + ' ' + (CHART_PAD.top + plotH)
			+ 'L' + x(data[0].d).toFixed(2) + ' ' + (CHART_PAD.top + plotH) + 'Z';
		svg.appendChild(svgEl('path', { class: 'nt-chart-area', d: areaPath }));
		svg.appendChild(svgEl('path', { class: 'nt-chart-line', d: line }));

		// Axis labels: the numbers the shape is drawn from, nothing
		// interpolated.
		const maxLabel = svgEl('text', {
			class: 'nt-chart-label', x: CHART_PAD.left - 4,
			y: CHART_PAD.top + 4, 'text-anchor': 'end',
		});
		maxLabel.textContent = Math.round(maxA) + ' m';
		svg.appendChild(maxLabel);
		const minLabel = svgEl('text', {
			class: 'nt-chart-label', x: CHART_PAD.left - 4,
			y: CHART_PAD.top + plotH, 'text-anchor': 'end',
		});
		minLabel.textContent = Math.round(minA) + ' m';
		svg.appendChild(minLabel);
		const distLabel = svgEl('text', {
			class: 'nt-chart-label', x: CHART_PAD.left + plotW,
			y: CHART_H - 6, 'text-anchor': 'end',
		});
		distLabel.textContent = S.formatDistance(maxD);
		svg.appendChild(distLabel);
		const zeroLabel = svgEl('text', {
			class: 'nt-chart-label', x: CHART_PAD.left, y: CHART_H - 6,
		});
		zeroLabel.textContent = '0';
		svg.appendChild(zeroLabel);

		// Hover readout.
		const cursor = svgEl('line', {
			class: 'nt-chart-cursor',
			x1: 0, y1: CHART_PAD.top, x2: 0, y2: CHART_PAD.top + plotH,
			visibility: 'hidden',
		});
		svg.appendChild(cursor);
		const dot = svgEl('circle', {
			class: 'nt-chart-dot', cx: 0, cy: 0, r: 3, visibility: 'hidden',
		});
		svg.appendChild(dot);
		wrap.appendChild(svg);

		const readout = makeEl('p', 'nt-chart-readout', ' ');
		wrap.appendChild(readout);

		svg.addEventListener('pointermove', function (event) {
			const rect = svg.getBoundingClientRect();
			if (rect.width <= 0) {
				return;
			}
			const vx = ((event.clientX - rect.left) / rect.width) * CHART_W;
			const dTarget = ((vx - CHART_PAD.left) / plotW) * maxD;
			let best = 0;
			let bestDelta = Infinity;
			for (let i = 0; i < data.length; i++) {
				const delta = Math.abs(data[i].d - dTarget);
				if (delta < bestDelta) {
					bestDelta = delta;
					best = i;
				}
			}
			const s = data[best];
			cursor.setAttribute('x1', x(s.d));
			cursor.setAttribute('x2', x(s.d));
			cursor.setAttribute('visibility', 'visible');
			dot.setAttribute('cx', x(s.d));
			dot.setAttribute('cy', y(s.a));
			dot.setAttribute('visibility', 'visible');
			readout.textContent = S.formatDistance(s.d) + ' · ' + S.formatElevation(s.a);
			if (onScrub) {
				onScrub(s);
			}
		});
		svg.addEventListener('pointerleave', function () {
			cursor.setAttribute('visibility', 'hidden');
			dot.setAttribute('visibility', 'hidden');
			readout.textContent = ' ';
			if (onScrub) {
				onScrub(null);
			}
		});

		return wrap;
	}

	// ---- misc UI --------------------------------------------------

	let toastTimer = null;
	function showToast(message) {
		const el = document.getElementById('nomadtracks-toast');
		el.textContent = message;
		el.hidden = false;
		if (toastTimer) {
			clearTimeout(toastTimer);
		}
		toastTimer = setTimeout(function () {
			el.hidden = true;
		}, 5000);
	}

	function showEmptyState() {
		document.getElementById('nomadtracks-empty').hidden = false;
		const container = document.getElementById('nomadtracks-tree');
		container.textContent = '';
		const p = document.createElement('p');
		p.className = 'nt-empty-side';
		p.textContent = tr('No "NomadTracks" folder in your files yet.');
		container.appendChild(p);
	}

	// ---- boot -----------------------------------------------------

	async function start() {
		if (typeof maplibregl === 'undefined') {
			console.error('nomadtracks: MapLibre GL failed to load');
			return;
		}
		initMap();
		document.getElementById('nomadtracks-details-close')
			.addEventListener('click', function () {
				markActive(null);
				setSelectedFeature(null);
				hideDetails();
			});

		let tree;
		try {
			tree = await scanLibrary();
		} catch (e) {
			console.error('nomadtracks:', e);
			showToast(tr('Could not read your files. See the browser console for details.'));
			return;
		}
		if (tree === null) {
			showEmptyState();
			return;
		}
		renderTree(tree);
		updateFooter();

		// The map starts with no tracks drawn: a track appears only
		// when its checkbox is ticked, mirroring the app's "Show on
		// Map" toggle. POIs are placed straight away.
		const waitForMap = new Promise(function (resolve) {
			if (mapReady) {
				resolve();
			} else {
				map.on('load', resolve);
			}
		});
		await waitForMap;
		await NT.dav.mapLimit(items.poi, FETCH_CONCURRENCY, loadPoi);

		if (!userMovedMap) {
			const b = new maplibregl.LngLatBounds();
			for (const poi of items.poi) {
				if (poi.loaded) {
					b.extend([poi.poi.lon, poi.poi.lat]);
				}
			}
			fitBounds(b);
		}
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', start);
	} else {
		start();
	}
})();
