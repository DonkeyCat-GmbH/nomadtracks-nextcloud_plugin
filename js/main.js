/**
 * SPDX-FileCopyrightText: 2026 DonkeyCat GmbH <office@donkeycat.com>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * NomadTracks library viewer: folder tree of the synced
 * `NomadTracks/` folder on the left, MapLibre map on the right.
 * Read-only — this page never writes to the synced files.
 */
(function () {
	'use strict';

	const NT = window.NomadTracks || {};
	const F = NT.formats;

	/** Root folder the mobile apps sync into (user's files root). */
	const LIBRARY_ROOT = 'NomadTracks';

	/**
	 * Style URL of the NomadTracks map server. The appkey is the same
	 * deliberately-public client key the iOS/Android apps ship (it
	 * exists so the server can refuse third-party scrapers, not as a
	 * secret — see NomadTracksMapConfig in the iOS repo).
	 */
	const STYLE_URL = 'https://map.nomadtracks.app/style.json'
		+ '?appkey=8d94d1b903bf853f7b8602f2498e3249fe5d498d1498a1489a6aeaf52734f6e4';

	/** How many tracks the initial "show all" view loads eagerly. */
	const INITIAL_TRACK_LIMIT = 50;
	const LOAD_MORE_BATCH = 50;
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
	const items = { track: [], poi: [], map: [], route: [] };
	const sidecarPaths = new Set();
	let selectedEl = null;
	let routeMarkers = [];
	let loadedTrackCount = 0;
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
					color: null,
					el: null,
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
		return btn;
	}

	function setItemColor(item) {
		if (item.el) {
			item.el.querySelector('.nt-dot').style.backgroundColor =
				item.color || F.DEFAULT_TRACK_COLOR;
		}
	}

	function markActive(item) {
		if (selectedEl) {
			selectedEl.classList.remove('nt-active');
		}
		selectedEl = item.el;
		if (selectedEl) {
			selectedEl.classList.add('nt-active');
		}
	}

	// ---- map ------------------------------------------------------

	function initMap() {
		map = new maplibregl.Map({
			container: 'nomadtracks-map',
			style: STYLE_URL,
			center: [10, 30],
			zoom: 1.5,
			attributionControl: { compact: true },
		});
		map.addControl(new maplibregl.NavigationControl(), 'top-right');
		map.addControl(new maplibregl.ScaleControl());
		map.on('dragstart', function () {
			userMovedMap = true;
		});
		map.on('load', function () {
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
			map.on('click', 'nt-tracks-line', function (e) {
				const f = e.features && e.features[0];
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
			mapReady = true;
			refreshTrackSource();
		});
	}

	function refreshTrackSource() {
		if (!mapReady) {
			return;
		}
		const features = items.track
			.filter(function (i) { return i.loaded && i.feature; })
			.map(function (i) { return i.feature; });
		map.getSource('nt-tracks').setData({
			type: 'FeatureCollection',
			features: features,
		});
	}

	function setSelectedFeature(feature) {
		if (!mapReady) {
			return;
		}
		for (const m of routeMarkers) {
			m.remove();
		}
		routeMarkers = [];
		map.getSource('nt-selected').setData(
			feature
				? { type: 'FeatureCollection', features: [feature] }
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

	async function loadTrack(item) {
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
			const parsed = F.parseGpx(results[0]);
			if (!parsed || parsed.segments.length === 0) {
				throw new Error('no track geometry in ' + item.path);
			}
			let color = null;
			if (results.length > 1 && results[1]) {
				const sidecar = F.parseSidecar(results[1]);
				if (sidecar && sidecar.colorHex) {
					color = sidecar.colorHex;
				}
			}
			item.color = color || F.DEFAULT_TRACK_COLOR;
			item.segments = parsed.segments;
			item.feature = {
				type: 'Feature',
				properties: { path: item.path, name: item.name, color: item.color },
				geometry: { type: 'MultiLineString', coordinates: parsed.segments },
			};
			item.loaded = true;
			loadedTrackCount++;
			setItemColor(item);
		} catch (e) {
			item.failed = true;
			if (item.el) {
				item.el.classList.add('nt-failed');
				item.el.title = tr('Could not load this file');
			}
			console.warn('nomadtracks:', e);
		}
	}

	async function loadPoi(item) {
		if (item.loaded || item.failed) {
			return;
		}
		try {
			const text = await NT.dav.getText(item.path);
			const poi = F.parsePoi(text);
			if (!poi) {
				throw new Error('not a POI GeoJSON: ' + item.path);
			}
			item.poi = poi;
			item.color = poi.color || F.DEFAULT_TRACK_COLOR;
			item.marker = new maplibregl.Marker({ color: item.color })
				.setLngLat([poi.lon, poi.lat])
				.setPopup(new maplibregl.Popup({ offset: 24 })
					.setText(poi.name || item.name))
				.addTo(map);
			item.loaded = true;
			setItemColor(item);
		} catch (e) {
			item.failed = true;
			if (item.el) {
				item.el.classList.add('nt-failed');
				item.el.title = tr('Could not load this file');
			}
			console.warn('nomadtracks:', e);
		}
	}

	async function loadTrackBatch(count) {
		const pending = items.track.filter(function (i) {
			return !i.loaded && !i.failed;
		}).slice(0, count);
		await NT.dav.mapLimit(pending, FETCH_CONCURRENCY, loadTrack);
		refreshTrackSource();
		updateFooter();
	}

	function updateFooter() {
		const footer = document.getElementById('nomadtracks-sidebar-footer');
		const countEl = document.getElementById('nomadtracks-track-count');
		const moreBtn = document.getElementById('nomadtracks-load-more');
		const total = items.track.length;
		if (total === 0) {
			footer.hidden = true;
			return;
		}
		footer.hidden = false;
		countEl.textContent = tr('Tracks on map:') + ' '
			+ loadedTrackCount + ' / ' + total;
		const remaining = items.track.some(function (i) {
			return !i.loaded && !i.failed;
		});
		moreBtn.hidden = !remaining;
	}

	// ---- selection ------------------------------------------------

	function onItemClick(item) {
		markActive(item);
		if (item.kind === 'track') {
			selectTrack(item);
		} else if (item.kind === 'poi') {
			selectPoi(item);
		} else if (item.kind === 'route') {
			selectRoute(item);
		} else if (item.kind === 'map') {
			showToast(tr('Custom map packages (.nomadmap) are listed here but not rendered on the web map.'));
		}
	}

	async function selectTrack(item) {
		await loadTrack(item);
		if (!item.loaded) {
			showToast(tr('Could not load this track.'));
			return;
		}
		refreshTrackSource();
		updateFooter();
		setSelectedFeature(item.feature);
		fitBounds(boundsOfSegments(item.segments));
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
				if (!color && results.length > 1 && results[1]) {
					const sidecar = F.parseSidecar(results[1]);
					if (sidecar && sidecar.colorHex) {
						color = sidecar.colorHex;
					}
				}
				item.route = pkg;
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
		} catch (e) {
			item.failed = true;
			if (item.el) {
				item.el.classList.add('nt-failed');
			}
			console.warn('nomadtracks:', e);
			showToast(tr('Could not load this route.'));
		}
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
		document.getElementById('nomadtracks-load-more')
			.addEventListener('click', function () {
				loadTrackBatch(LOAD_MORE_BATCH);
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

		// "Show all" default view: every POI, plus the first batch of
		// tracks (the rest load on demand / via "Load 50 more").
		const waitForMap = new Promise(function (resolve) {
			if (mapReady) {
				resolve();
			} else {
				map.on('load', resolve);
			}
		});
		await waitForMap;
		await NT.dav.mapLimit(items.poi, FETCH_CONCURRENCY, loadPoi);
		await loadTrackBatch(INITIAL_TRACK_LIMIT);

		if (!userMovedMap) {
			const b = new maplibregl.LngLatBounds();
			for (const track of items.track) {
				if (track.loaded) {
					for (const seg of track.segments) {
						for (const c of seg) {
							b.extend(c);
						}
					}
				}
			}
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
