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
	 * `/style-topo.json`). This web client authenticates with its own
	 * `webkey`, separate from the `appkey` the mobile apps ship, so the
	 * map server can rate-limit and revoke the two independently. Like
	 * the app key it is a deliberately-public client key — it ships in
	 * the page source — not a secret.
	 */
	const WEB_KEY = '27af6da439502b114d47008a247d7f45cedd6448036d4c4f7f7c9e25c0651304';
	const MAP_TYPES = {
		standard: 'https://map.nomadtracks.app/style.json?webkey=' + WEB_KEY,
		terrain: 'https://map.nomadtracks.app/style-topo.json?webkey=' + WEB_KEY,
	};
	const MAP_TYPE_STORAGE_KEY = 'nomadtracks-map-type';
	const SIDEBAR_WIDTH_STORAGE_KEY = 'nomadtracks-sidebar-width';
	const SIDEBAR_DEFAULT_WIDTH = 300;
	const SIDEBAR_MIN_WIDTH = 200;
	const ARROWS_STORAGE_KEY = 'nomadtracks-arrows';

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
	/** Direction arrows along every drawn track (a per-browser choice). */
	let arrowsOn = false;
	let arrowsButton = null;
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
					sidecarPromise: null,
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
			// Every level of the tree starts collapsed; the user opens
			// what they want to look at.
			const section = document.createElement('details');
			section.className = 'nt-root';
			section.open = false;
			const summary = document.createElement('summary');
			if (hasVisibilityToggle(rootNode.kind)) {
				summary.appendChild(makeFolderBox(rootNode, rootNode.kind));
			}
			const h = document.createElement('h3');
			h.textContent = rootNode.name + ' (' + countItems(rootNode) + ')';
			summary.appendChild(h);
			section.appendChild(summary);
			section.appendChild(renderFolderContents(rootNode, rootNode.kind));
			container.appendChild(section);
		}
		updateFolderBoxes();
	}

	/** Tracks and POIs can be shown / hidden; maps and routes cannot. */
	function hasVisibilityToggle(kind) {
		return kind === 'track' || kind === 'poi';
	}

	/** Every item of `kind` below `node`, subfolders included. */
	function itemsUnder(node, kind, out) {
		out = out || [];
		for (const item of node.items) {
			if (item.kind === kind) {
				out.push(item);
			}
		}
		for (const folder of node.folders) {
			itemsUnder(folder, kind, out);
		}
		return out;
	}

	/** Registered folder / root checkboxes, for the tri-state refresh. */
	const folderBoxes = [];

	/**
	 * A select-all checkbox for a folder (or a root): ticks or unticks
	 * everything beneath it, like the folder toggle in the app. Lives
	 * inside the <summary>, so clicks must not bubble up and fold the
	 * folder.
	 */
	function makeFolderBox(node, kind) {
		const box = document.createElement('input');
		box.type = 'checkbox';
		box.className = 'nt-check nt-check-folder';
		box.title = kind === 'track'
			? tr('Show all tracks in this folder on the map')
			: tr('Show all POIs in this folder on the map');
		box.setAttribute('aria-label', box.title + ': ' + node.name);
		box.addEventListener('click', function (e) {
			e.stopPropagation();
		});
		box.addEventListener('change', function () {
			const list = itemsUnder(node, kind);
			if (kind === 'track') {
				setTracksShown(list, box.checked);
			} else {
				setPoisShown(list, box.checked);
			}
		});
		folderBoxes.push({ box: box, node: node, kind: kind });
		return box;
	}

	function updateFolderBoxes() {
		for (const entry of folderBoxes) {
			const list = itemsUnder(entry.node, entry.kind);
			const n = list.filter(function (i) { return i.checked; }).length;
			entry.box.disabled = list.length === 0;
			entry.box.checked = n > 0 && n === list.length;
			entry.box.indeterminate = n > 0 && n < list.length;
		}
	}

	function countItems(node) {
		let n = node.items.length;
		for (const f of node.folders) {
			n += countItems(f);
		}
		return n;
	}

	function renderFolderContents(node, kind) {
		const wrap = document.createElement('div');
		wrap.className = 'nt-children';
		for (const folder of node.folders) {
			const details = document.createElement('details');
			details.open = false;
			details.className = 'nt-folder';
			const summary = document.createElement('summary');
			if (hasVisibilityToggle(kind)) {
				summary.appendChild(makeFolderBox(folder, kind));
			}
			const name = document.createElement('span');
			name.className = 'nt-folder-name';
			name.textContent = folder.name;
			name.title = folder.name;
			summary.appendChild(name);
			details.appendChild(summary);
			details.appendChild(renderFolderContents(folder, kind));
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
		// The label is ellipsised when the sidebar is narrow; hovering
		// shows the whole name.
		label.title = item.name;
		btn.appendChild(label);
		btn.addEventListener('click', function () {
			onItemClick(item);
		});
		item.el = btn;

		if (!hasVisibilityToggle(item.kind)) {
			return btn;
		}

		// Tracks and POIs carry a "Show on Map" box like the app's
		// toggle. The initial state comes from the user's saved
		// selection (applyPersistedState); a track's GPX is fetched
		// only when it is first shown.
		const row = document.createElement('div');
		row.className = 'nt-row';
		const box = document.createElement('input');
		box.type = 'checkbox';
		box.className = 'nt-check';
		box.checked = !!item.checked;
		box.setAttribute('aria-label', tr('Show on map') + ': ' + item.name);
		box.title = item.kind === 'track'
			? tr('Show this track on the map')
			: tr('Show this POI on the map');
		box.addEventListener('change', function () {
			if (item.kind === 'track') {
				setTracksShown([item], box.checked);
			} else {
				setPoisShown([item], box.checked);
			}
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

	/**
	 * Swap a track's plain dot for its category glyph, tinted with the
	 * track colour — the same look as the app's library rows. The
	 * glyph is a CSS mask (see .nt-icon / .nt-cat-* in main.css), so
	 * the existing background-colour tint keeps doing the colouring.
	 */
	function applyCategoryIcon(item) {
		if (!item.el || item.kind !== 'track') {
			return;
		}
		const dot = item.el.querySelector('.nt-dot');
		const key = F.trackCategoryKey(item.sidecar && item.sidecar.category);
		for (const cls of Array.from(dot.classList)) {
			if (cls.indexOf('nt-cat-') === 0) {
				dot.classList.remove(cls);
			}
		}
		dot.classList.add('nt-icon', 'nt-cat-' + key);
		dot.title = F.trackCategoryName(key);
	}

	/**
	 * Fetch a track's sidecar on its own, ahead of the GPX, so colour
	 * and category show in the tree without the track being ticked.
	 * Resolves to the parsed sidecar (or null); never rejects.
	 */
	function loadSidecar(item) {
		if (!item.sidecarPromise) {
			item.sidecarPromise = (item.sidecarPath
				? NT.dav.getText(item.sidecarPath).then(F.parseSidecar)
				: Promise.resolve(null)
			).catch(function () {
				return null;
			}).then(function (sidecar) {
				if (item.sidecar === undefined) {
					item.sidecar = sidecar;
				}
				if (!item.loaded) {
					item.color = (sidecar && sidecar.colorHex) || F.DEFAULT_TRACK_COLOR;
				}
				setItemColor(item);
				applyCategoryIcon(item);
				return sidecar;
			});
		}
		return item.sidecarPromise;
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

	// ---- saved selection (per user, server side) -------------------

	/**
	 * Which tracks are ticked and which POIs are unticked, stored in
	 * the user's Nextcloud settings by StateController so the same
	 * selection comes back on every device. Tracks default to hidden
	 * and POIs to shown, so each list only holds the exceptions.
	 */
	let persisted = { tracks: [], hiddenPois: [] };
	let stateSaveTimer = null;

	function stateUrl() {
		return OC.generateUrl('/apps/nomadtracks/state');
	}

	async function loadPersistedState() {
		try {
			const res = await fetch(stateUrl(), {
				headers: { requesttoken: OC.requestToken, Accept: 'application/json' },
			});
			if (!res.ok) {
				throw new Error('GET state failed: ' + res.status);
			}
			const data = await res.json();
			persisted = {
				tracks: Array.isArray(data.tracks) ? data.tracks : [],
				hiddenPois: Array.isArray(data.hiddenPois) ? data.hiddenPois : [],
			};
		} catch (e) {
			// Not fatal: the page just starts with nothing ticked.
			console.warn('nomadtracks: could not load the saved selection', e);
		}
	}

	function applyPersistedState() {
		const shown = new Set(persisted.tracks);
		const hidden = new Set(persisted.hiddenPois);
		for (const item of items.track) {
			item.checked = shown.has(item.path);
		}
		for (const item of items.poi) {
			item.checked = !hidden.has(item.path);
		}
	}

	/** Coalesce a burst of toggles (a folder select-all) into one PUT. */
	function scheduleStateSave() {
		if (stateSaveTimer) {
			clearTimeout(stateSaveTimer);
		}
		stateSaveTimer = setTimeout(saveState, 400);
	}

	async function saveState() {
		stateSaveTimer = null;
		const body = {
			tracks: items.track.filter(function (i) {
				return i.checked && !i.external;
			}).map(function (i) { return i.path; }),
			hiddenPois: items.poi.filter(function (i) {
				return !i.checked;
			}).map(function (i) { return i.path; }),
		};
		try {
			const res = await fetch(stateUrl(), {
				method: 'PUT',
				headers: {
					requesttoken: OC.requestToken,
					'Content-Type': 'application/json',
					Accept: 'application/json',
				},
				body: JSON.stringify(body),
			});
			if (!res.ok) {
				throw new Error('PUT state failed: ' + res.status);
			}
			persisted = body;
		} catch (e) {
			console.warn('nomadtracks: could not save the selection', e);
			showToast(tr('Your selection could not be saved.'));
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

	function storedArrows() {
		try {
			return window.localStorage.getItem(ARROWS_STORAGE_KEY) === '1';
		} catch (e) {
			return false;
		}
	}

	function rememberArrows(on) {
		try {
			window.localStorage.setItem(ARROWS_STORAGE_KEY, on ? '1' : '0');
		} catch (e) {
			// Not fatal.
		}
	}

	/** Toggle button for the direction arrows, in the control stack. */
	function ArrowsControl() {}

	ArrowsControl.prototype.onAdd = function () {
		const container = document.createElement('div');
		container.className = 'maplibregl-ctrl maplibregl-ctrl-group';
		const button = document.createElement('button');
		button.type = 'button';
		button.className = 'nt-arrows-button';
		button.title = tr('Show direction of travel');
		button.setAttribute('aria-label', button.title);
		button.appendChild(makeEl('span', 'nt-arrows-glyph', '➤'));
		button.addEventListener('click', function () {
			setArrows(!arrowsOn);
		});
		container.appendChild(button);
		arrowsButton = button;
		this._container = container;
		updateArrowsButton();
		return container;
	};

	ArrowsControl.prototype.onRemove = function () {
		if (this._container && this._container.parentNode) {
			this._container.parentNode.removeChild(this._container);
		}
		arrowsButton = null;
	};

	function updateArrowsButton() {
		if (arrowsButton) {
			arrowsButton.classList.toggle('nt-arrows-active', arrowsOn);
			arrowsButton.setAttribute('aria-pressed', arrowsOn ? 'true' : 'false');
		}
	}

	function setArrows(on) {
		arrowsOn = !!on;
		rememberArrows(arrowsOn);
		updateArrowsButton();
		if (mapReady && map.getLayer('nt-tracks-arrows')) {
			map.setLayoutProperty('nt-tracks-arrows', 'visibility',
				arrowsOn ? 'visible' : 'none');
		}
	}

	/**
	 * The arrow glyph: a white chevron with a dark outline, pointing
	 * along +x, drawn at 2× for crisp edges. White-on-outline reads on
	 * any track colour, which is why the icon is not tinted per track.
	 */
	function arrowImage() {
		// 48 px at 2× = a 24 px glyph on screen before icon-size.
		const size = 48;
		const canvas = document.createElement('canvas');
		canvas.width = size;
		canvas.height = size;
		const ctx = canvas.getContext('2d');
		ctx.lineJoin = 'round';
		ctx.lineCap = 'round';
		ctx.beginPath();
		ctx.moveTo(15, 9);
		ctx.lineTo(35, 24);
		ctx.lineTo(15, 39);
		ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
		ctx.lineWidth = 11;
		ctx.stroke();
		ctx.strokeStyle = '#ffffff';
		ctx.lineWidth = 5.5;
		ctx.stroke();
		return ctx.getImageData(0, 0, size, size);
	}

	function initMap() {
		mapType = storedMapType();
		arrowsOn = storedArrows();
		map = new maplibregl.Map({
			container: 'nomadtracks-map',
			style: MAP_TYPES[mapType],
			center: [10, 30],
			zoom: 1.5,
			attributionControl: { compact: true },
		});
		map.addControl(new MapTypeControl(), 'top-right');
		map.addControl(new maplibregl.NavigationControl(), 'top-right');
		map.addControl(new ArrowsControl(), 'top-right');
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
		// Direction of travel: one chevron every ~80 px along each
		// drawn track, rotated with the line (which follows the GPX
		// point order). Images are dropped by a style switch too, so
		// the glyph is re-registered here each time.
		if (!map.hasImage('nt-arrow')) {
			map.addImage('nt-arrow', arrowImage(), { pixelRatio: 2 });
		}
		map.addLayer({
			id: 'nt-tracks-arrows',
			type: 'symbol',
			source: 'nt-tracks',
			layout: {
				'symbol-placement': 'line',
				'symbol-spacing': 70,
				'icon-image': 'nt-arrow',
				// Grows with zoom: readable on a whole-route view, not
				// a wall of chevrons when zoomed in on a street.
				'icon-size': ['interpolate', ['linear'], ['zoom'],
					8, 0.6,
					13, 0.9,
					16, 1.1,
					19, 1.4],
				'icon-rotation-alignment': 'map',
				'icon-pitch-alignment': 'map',
				'icon-keep-upright': false,
				'icon-allow-overlap': true,
				'icon-ignore-placement': true,
				visibility: arrowsOn ? 'visible' : 'none',
			},
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
		// The sidecar is (or is already being) fetched by the tree's
		// background pass; share that request rather than repeat it.
		const results = await Promise.all([
			NT.dav.getText(item.path),
			loadSidecar(item),
		]);
		const parsed = F.parseGpx(results[0]);
		if (!parsed || parsed.segments.length === 0) {
			throw new Error('no track geometry in ' + item.path);
		}
		const sidecar = results[1];
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
					.setText(poi.name || item.name));
			if (item.checked) {
				item.marker.addTo(map);
				item.markerOnMap = true;
			}
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

	function setChecked(item, checked) {
		item.checked = checked;
		if (item.checkbox) {
			item.checkbox.checked = checked;
		}
	}

	/**
	 * Show or hide a set of tracks (one box, or a whole folder).
	 * Tracks are fetched on first show, a few at a time; any that
	 * fail to load are unticked again and reported once.
	 */
	async function setTracksShown(list, checked) {
		for (const item of list) {
			setChecked(item, checked);
		}
		if (checked) {
			const pending = list.filter(function (i) {
				return !i.loaded && !i.failed;
			});
			for (const item of pending) {
				setBusy(item, true);
			}
			await NT.dav.mapLimit(pending, FETCH_CONCURRENCY, async function (item) {
				await loadTrack(item);
				setBusy(item, false);
			});
			let failed = 0;
			for (const item of list) {
				if (!item.loaded) {
					setChecked(item, false);
					failed++;
				}
			}
			if (failed === 1 && list.length === 1) {
				showToast(tr('Could not load this track.'));
			} else if (failed > 0) {
				showToast(tr('Some tracks could not be loaded and were left unticked.'));
			}
		} else {
			// Untick the track that is currently highlighted: drop the
			// highlight and the details panel too, so the map really is
			// free of it. Other tracks are unaffected.
			if (selectedItem && list.indexOf(selectedItem) !== -1) {
				markActive(null);
				setSelectedFeature(null);
				hideDetails();
			}
		}
		refreshTrackSource();
		updateFooter();
		updateFolderBoxes();
		refreshSummarySection();
		scheduleStateSave();
	}

	/** Show or hide POI markers; unloaded POIs are fetched on show. */
	async function setPoisShown(list, checked) {
		for (const item of list) {
			setChecked(item, checked);
		}
		if (checked) {
			await NT.dav.mapLimit(list, FETCH_CONCURRENCY, loadPoi);
			for (const item of list) {
				if (item.loaded && item.marker && !item.markerOnMap) {
					item.marker.addTo(map);
					item.markerOnMap = true;
				}
			}
		} else {
			for (const item of list) {
				if (item.marker && item.markerOnMap) {
					item.marker.remove();
					item.markerOnMap = false;
				}
				if (selectedItem === item) {
					markActive(null);
					hideDetails();
				}
			}
		}
		updateFolderBoxes();
		scheduleStateSave();
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
		if (!item.checked) {
			await setTracksShown([item], true);
		}
		setSelectedFeature(item.feature);
		fitBounds(boundsOfSegments(item.segments));
		showTrackDetails(item);
	}

	async function selectPoi(item) {
		if (!item.checked) {
			await setPoisShown([item], true);
		} else {
			await loadPoi(item);
		}
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

	/** What the panel currently shows: 'track' | 'summary' | 'other' | null. */
	let detailsMode = null;

	function hideDetails() {
		detailsMode = null;
		const panel = detailsPanel();
		panel.hidden = true;
		document.getElementById('nomadtracks-details-body').textContent = '';
		document.getElementById('nomadtracks-details-title').textContent = '';
		document.getElementById('nomadtracks-app').classList.remove('nt-has-details');
	}

	function openDetails(title, mode) {
		detailsMode = mode || 'other';
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
			(gpx && gpx.name) ? gpx.name : item.name,
			'track'
		);
		addHeader(body, item, tr('Track'));
		buildTrackBody(body, item, d, gpx, tr('Recorded'));
		const summary = renderSelectionSummary();
		if (summary) {
			body.appendChild(summary);
		}
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
			if (F.trackCategoryKey(sidecar.category) !== 'unspecified') {
				addStat(grid, tr('Category'), tr(F.trackCategoryName(sidecar.category)));
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

	// ---- selection summary -----------------------------------------

	const SUMMARY_ID = 'nomadtracks-selection';

	/** Ticked tracks whose GPX has been parsed, oldest first. */
	function shownTracks() {
		return items.track.filter(function (i) {
			return i.checked && i.loaded && i.detail;
		}).sort(function (a, b) {
			return (a.detail.startedAt || 0) - (b.detail.startedAt || 0);
		});
	}

	/**
	 * Totals over several tracks. Sums only what every summed track
	 * actually has: a duration total over tracks that carry no
	 * timestamps would be a silent lie, so each total also reports
	 * how many tracks it covers.
	 */
	function aggregateTracks(list) {
		const agg = {
			count: list.length,
			distanceMeters: 0,
			durationSeconds: 0, durationCount: 0,
			movingSeconds: 0, movingCount: 0,
			gain: 0, gainCount: 0,
			loss: 0, lossCount: 0,
			firstStart: null, lastStart: null,
			categories: {},
		};
		for (const t of list) {
			const d = t.detail;
			agg.distanceMeters += d.distanceMeters || 0;
			if (d.durationSeconds !== null) {
				agg.durationSeconds += d.durationSeconds;
				agg.durationCount++;
			}
			if (d.stats.movingTimeSeconds !== null) {
				agg.movingSeconds += d.stats.movingTimeSeconds;
				agg.movingCount++;
			}
			if (d.elevationGain !== null) {
				agg.gain += d.elevationGain;
				agg.gainCount++;
			}
			if (d.elevationLoss !== null) {
				agg.loss += d.elevationLoss;
				agg.lossCount++;
			}
			if (d.startedAt !== null) {
				agg.firstStart = agg.firstStart === null
					? d.startedAt : Math.min(agg.firstStart, d.startedAt);
				agg.lastStart = agg.lastStart === null
					? d.startedAt : Math.max(agg.lastStart, d.startedAt);
			}
			const key = F.trackCategoryKey(t.sidecar && t.sidecar.category);
			agg.categories[key] = (agg.categories[key] || 0) + 1;
		}
		return agg;
	}

	function coverageHint(n, total) {
		return n === total ? null
			: tr('Only %n of the selected tracks carry this value; the total covers those.')
				.replace('%n', String(n));
	}

	/**
	 * The "Selected tracks" section: totals, a category breakdown and
	 * the add-ons menu. Returns null when fewer than two tracks are
	 * shown — one track's numbers are already its own details.
	 */
	function renderSelectionSummary() {
		const list = shownTracks();
		if (list.length < 2) {
			return null;
		}
		const agg = aggregateTracks(list);
		const section = makeEl('section', 'nt-section nt-selection');
		section.id = SUMMARY_ID;
		section.appendChild(makeEl('h3', null,
			tr('Selected tracks') + ' (' + agg.count + ')'));

		const grid = makeEl('div', 'nt-stats');
		addStat(grid, tr('Distance'), S.formatDistance(agg.distanceMeters));
		addStat(grid, tr('Duration'), agg.durationCount > 0
			? S.formatDuration(agg.durationSeconds) : null,
			coverageHint(agg.durationCount, agg.count));
		addStat(grid, tr('Time in Motion'), agg.movingCount > 0
			? S.formatDuration(agg.movingSeconds) : null,
			coverageHint(agg.movingCount, agg.count));
		addStat(grid, tr('Avg Speed'), agg.durationCount > 0 && agg.durationSeconds > 0
			? S.formatSpeed(agg.distanceMeters / agg.durationSeconds) : null,
			tr('Total distance over total duration.'));
		addStat(grid, tr('Elev. Gain'), agg.gainCount > 0
			? S.formatElevation(agg.gain) : null,
			coverageHint(agg.gainCount, agg.count));
		addStat(grid, tr('Elev. Loss'), agg.lossCount > 0
			? S.formatElevation(agg.loss) : null,
			coverageHint(agg.lossCount, agg.count));
		addStat(grid, tr('First'), formatDateTime(agg.firstStart));
		addStat(grid, tr('Last'), formatDateTime(agg.lastStart));
		section.appendChild(grid);

		const keys = Object.keys(agg.categories).sort(function (a, b) {
			return agg.categories[b] - agg.categories[a];
		});
		if (keys.length > 1 || keys[0] !== 'unspecified') {
			const list2 = makeEl('ul', 'nt-list nt-categories');
			for (const key of keys) {
				const li = makeEl('li');
				const icon = makeEl('span', 'nt-dot nt-icon nt-cat-' + key);
				icon.style.backgroundColor = 'currentColor';
				li.appendChild(icon);
				li.appendChild(makeEl('span', null,
					tr(F.trackCategoryName(key)) + ' × ' + agg.categories[key]));
				list2.appendChild(li);
			}
			section.appendChild(list2);
		}

		const addons = renderAddons(list, agg);
		if (addons) {
			section.appendChild(addons);
		}
		return section;
	}

	/**
	 * Keep whatever is open in sync with the selection: the summary
	 * panel re-renders, a track's details get their trailing summary
	 * section swapped, and the footer button follows the count.
	 */
	function refreshSummarySection() {
		const count = shownTracks().length;
		const button = document.getElementById('nomadtracks-summary');
		if (button) {
			button.hidden = count < 2;
			button.textContent = tr('Summary of %n tracks').replace('%n', String(count));
		}
		if (detailsMode === 'summary') {
			if (count < 2) {
				hideDetails();
			} else {
				showSummaryPanel();
			}
		} else if (detailsMode === 'track') {
			const body = document.getElementById('nomadtracks-details-body');
			const old = document.getElementById(SUMMARY_ID);
			const fresh = renderSelectionSummary();
			if (old && fresh) {
				body.replaceChild(fresh, old);
			} else if (old) {
				body.removeChild(old);
			} else if (fresh) {
				body.appendChild(fresh);
			}
		}
	}

	function showSummaryPanel() {
		const section = renderSelectionSummary();
		if (!section) {
			return;
		}
		const body = openDetails(tr('Selected tracks'), 'summary');
		// The section brings its own heading; the panel title has it.
		section.removeChild(section.querySelector('h3'));
		body.appendChild(section);
	}

	// ---- add-ons ----------------------------------------------------
	//
	// Special-purpose tools that work on the selected tracks live in
	// js/addons/*.js and register themselves with NT.addons (see
	// js/addons.js for the contract). They are reached through a
	// small "Add-ons" menu at the end of the selection summary, so
	// none of them is in the way when it is not wanted.

	/** Which add-on's panel is open, so a summary re-render keeps it. */
	let activeAddonId = null;

	function addonContext(list, agg) {
		return {
			tracks: list,
			aggregate: agg,
			ui: { makeEl: makeEl, tr: tr, showToast: showToast },
		};
	}

	function renderAddons(list, agg) {
		if (!NT.addons) {
			return null;
		}
		const ctx = addonContext(list, agg);
		const available = NT.addons.all().filter(function (addon) {
			try {
				return typeof addon.appliesTo !== 'function' || addon.appliesTo(ctx);
			} catch (e) {
				console.warn('nomadtracks: add-on', addon.id, 'failed in appliesTo', e);
				return false;
			}
		});
		if (available.length === 0) {
			return null;
		}
		if (activeAddonId && !available.some(function (a) { return a.id === activeAddonId; })) {
			activeAddonId = null;
		}

		const wrap = makeEl('div', 'nt-addons');
		const bar = makeEl('div', 'nt-addons-bar');
		const toggle = makeEl('button', 'nt-button nt-addons-toggle', tr('Add-ons') + ' ▾');
		toggle.type = 'button';
		toggle.setAttribute('aria-haspopup', 'menu');
		toggle.setAttribute('aria-expanded', 'false');
		const menu = makeEl('ul', 'nt-addons-menu');
		menu.setAttribute('role', 'menu');
		menu.hidden = true;
		for (const addon of available) {
			const li = makeEl('li');
			li.setAttribute('role', 'none');
			const button = makeEl('button', 'nt-addons-item');
			button.type = 'button';
			button.setAttribute('role', 'menuitem');
			button.appendChild(makeEl('span', 'nt-addons-item-title', addon.title()));
			if (typeof addon.description === 'function') {
				button.appendChild(makeEl('span', 'nt-addons-item-desc', addon.description()));
			}
			button.addEventListener('click', function () {
				closeMenu();
				activeAddonId = addon.id;
				showAddonPanel(wrap, addon, ctx);
			});
			li.appendChild(button);
			menu.appendChild(li);
		}
		bar.appendChild(toggle);
		bar.appendChild(menu);
		wrap.appendChild(bar);

		const onOutsideClick = function (e) {
			if (!bar.contains(e.target)) {
				closeMenu();
			}
		};
		const closeMenu = function () {
			menu.hidden = true;
			toggle.setAttribute('aria-expanded', 'false');
			document.removeEventListener('click', onOutsideClick, true);
		};
		toggle.addEventListener('click', function () {
			if (menu.hidden) {
				menu.hidden = false;
				toggle.setAttribute('aria-expanded', 'true');
				document.addEventListener('click', onOutsideClick, true);
			} else {
				closeMenu();
			}
		});

		if (activeAddonId) {
			const active = available.find(function (a) { return a.id === activeAddonId; });
			showAddonPanel(wrap, active, ctx);
		}
		return wrap;
	}

	function showAddonPanel(wrap, addon, ctx) {
		const old = wrap.querySelector('.nt-addon-panel');
		if (old) {
			wrap.removeChild(old);
		}
		const panel = makeEl('div', 'nt-addon-panel');
		const header = makeEl('div', 'nt-addon-header');
		header.appendChild(makeEl('h4', null, addon.title()));
		const close = makeEl('button', 'nt-close', '×');
		close.type = 'button';
		close.title = tr('Close');
		close.setAttribute('aria-label', tr('Close') + ': ' + addon.title());
		close.addEventListener('click', function () {
			activeAddonId = null;
			wrap.removeChild(panel);
		});
		header.appendChild(close);
		panel.appendChild(header);
		const body = makeEl('div', 'nt-addon-body');
		try {
			addon.render(body, ctx);
		} catch (e) {
			console.error('nomadtracks: add-on', addon.id, 'failed to render', e);
			body.appendChild(makeEl('p', 'nt-hint', tr('This add-on could not be shown. See the browser console for details.')));
		}
		panel.appendChild(body);
		wrap.appendChild(panel);
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

	// ---- ?file= (arriving from the Files app) ----------------------

	/** Unfold every folder above an item and scroll it into view. */
	function revealItem(item) {
		const container = document.getElementById('nomadtracks-tree');
		let el = item.el;
		while (el && el !== container) {
			if (el.tagName === 'DETAILS') {
				el.open = true;
			}
			el = el.parentElement;
		}
		if (item.el && typeof item.el.scrollIntoView === 'function') {
			item.el.scrollIntoView({ block: 'center' });
		}
	}

	/**
	 * The Files app's "Open in NomadTracks" lands here with
	 * `?file=/path/to/track.gpx`. A file that is part of the library
	 * is simply selected; any other GPX is fetched and shown as a
	 * temporary track under its own "Opened file" heading. Temporary
	 * tracks are never written to the saved selection.
	 */
	async function openRequestedFile() {
		let file;
		try {
			file = new URLSearchParams(window.location.search).get('file');
		} catch (e) {
			return false;
		}
		if (!file) {
			return false;
		}
		const path = file.replace(/^\/+/, '');
		const hit = items.track.find(function (i) {
			return i.path === path;
		});
		if (hit) {
			revealItem(hit);
			await selectTrack(hit);
			return true;
		}
		if (!/\.gpx$/i.test(path)) {
			showToast(tr('Only GPX files can be opened here.'));
			return false;
		}
		const base = path.substring(path.lastIndexOf('/') + 1);
		const item = {
			kind: 'track',
			name: base.substring(0, base.length - 4),
			path: path,
			size: 0,
			sidecarPath: null,
			loaded: false,
			failed: false,
			checked: false,
			color: null,
			el: null,
			checkbox: null,
			loadPromise: null,
			sidecarPromise: null,
			external: true,
		};
		items.track.push(item);
		const node = { name: tr('Opened file'), kind: 'track', folders: [], items: [item] };
		const container = document.getElementById('nomadtracks-tree');
		const section = document.createElement('details');
		section.className = 'nt-root nt-root-external';
		section.open = true;
		const summary = document.createElement('summary');
		const h = document.createElement('h3');
		h.textContent = node.name;
		summary.appendChild(h);
		section.appendChild(summary);
		section.appendChild(renderFolderContents(node, 'track'));
		container.insertBefore(section, container.firstChild);
		loadSidecar(item);
		await selectTrack(item);
		return item.loaded;
	}

	// ---- resizable sidebar ------------------------------------------

	function sidebarMaxWidth() {
		// Leave the map at least 320 px plus room for the details pane.
		return Math.max(SIDEBAR_MIN_WIDTH, window.innerWidth - 320 - 340);
	}

	function applySidebarWidth(width) {
		const clamped = Math.round(Math.min(sidebarMaxWidth(),
			Math.max(SIDEBAR_MIN_WIDTH, width)));
		document.getElementById('nomadtracks-sidebar').style.width = clamped + 'px';
		return clamped;
	}

	function initSidebarResizer() {
		const app = document.getElementById('nomadtracks-app');
		const handle = document.getElementById('nomadtracks-resizer');
		const sidebar = document.getElementById('nomadtracks-sidebar');
		if (!handle || !sidebar) {
			return;
		}
		let stored = null;
		try {
			stored = parseInt(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY), 10);
		} catch (e) {
			// Fine — default width.
		}
		if (Number.isFinite(stored)) {
			applySidebarWidth(stored);
		}

		let startX = 0;
		let startWidth = 0;
		const onMove = function (e) {
			applySidebarWidth(startWidth + (e.clientX - startX));
		};
		const onUp = function () {
			app.classList.remove('nt-resizing');
			window.removeEventListener('pointermove', onMove);
			window.removeEventListener('pointerup', onUp);
			window.removeEventListener('pointercancel', onUp);
			try {
				window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY,
					String(sidebar.getBoundingClientRect().width));
			} catch (e) {
				// Not fatal.
			}
			if (map) {
				map.resize();
			}
		};
		handle.addEventListener('pointerdown', function (e) {
			if (e.button !== 0) {
				return;
			}
			e.preventDefault();
			startX = e.clientX;
			startWidth = sidebar.getBoundingClientRect().width;
			app.classList.add('nt-resizing');
			window.addEventListener('pointermove', onMove);
			window.addEventListener('pointerup', onUp);
			window.addEventListener('pointercancel', onUp);
		});
		handle.addEventListener('dblclick', function () {
			applySidebarWidth(SIDEBAR_DEFAULT_WIDTH);
			try {
				window.localStorage.removeItem(SIDEBAR_WIDTH_STORAGE_KEY);
			} catch (e) {
				// Not fatal.
			}
			if (map) {
				map.resize();
			}
		});
		// Keyboard: the separator is focusable and nudges by 16 px.
		handle.tabIndex = 0;
		handle.addEventListener('keydown', function (e) {
			const step = e.key === 'ArrowLeft' ? -16 : e.key === 'ArrowRight' ? 16 : 0;
			if (!step) {
				return;
			}
			e.preventDefault();
			const w = applySidebarWidth(sidebar.getBoundingClientRect().width + step);
			try {
				window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(w));
			} catch (e2) {
				// Not fatal.
			}
			if (map) {
				map.resize();
			}
		});
		window.addEventListener('resize', function () {
			// Keep the map usable if the window shrinks below the saved width.
			applySidebarWidth(sidebar.getBoundingClientRect().width);
		});
	}

	// ---- boot -----------------------------------------------------

	async function start() {
		if (typeof maplibregl === 'undefined') {
			console.error('nomadtracks: MapLibre GL failed to load');
			return;
		}
		initSidebarResizer();
		initMap();
		document.getElementById('nomadtracks-details-close')
			.addEventListener('click', function () {
				markActive(null);
				setSelectedFeature(null);
				hideDetails();
			});
		document.getElementById('nomadtracks-summary')
			.addEventListener('click', function () {
				markActive(null);
				setSelectedFeature(null);
				showSummaryPanel();
			});

		let tree;
		try {
			const results = await Promise.all([scanLibrary(), loadPersistedState()]);
			tree = results[0];
		} catch (e) {
			console.error('nomadtracks:', e);
			showToast(tr('Could not read your files. See the browser console for details.'));
			return;
		}
		if (tree === null) {
			showEmptyState();
			// A GPX opened from the Files app still works without a
			// library; the empty-state overlay makes way for the map.
			await new Promise(function (resolve) {
				if (mapReady) {
					resolve();
				} else {
					map.on('load', resolve);
				}
			});
			if (await openRequestedFile()) {
				document.getElementById('nomadtracks-empty').hidden = true;
			}
			return;
		}
		applyPersistedState();
		renderTree(tree);
		updateFooter();

		// Colour + category for every track, filled in progressively
		// as the (small) sidecars arrive. Not awaited: the map and the
		// POIs must not wait on 100+ tiny requests.
		NT.dav.mapLimit(items.track, FETCH_CONCURRENCY, loadSidecar);

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
		// Everything the user left ticked last time comes back: shown
		// POIs first (cheap), then the shown tracks.
		await NT.dav.mapLimit(items.poi.filter(function (p) {
			return p.checked;
		}), FETCH_CONCURRENCY, loadPoi);
		const restoredTracks = items.track.filter(function (t) {
			return t.checked;
		});
		if (restoredTracks.length > 0) {
			await setTracksShown(restoredTracks, true);
		}
		updateFolderBoxes();

		if (!userMovedMap) {
			const b = new maplibregl.LngLatBounds();
			for (const poi of items.poi) {
				if (poi.loaded && poi.checked) {
					b.extend([poi.poi.lon, poi.poi.lat]);
				}
			}
			for (const track of items.track) {
				if (track.loaded && track.checked) {
					for (const seg of track.segments) {
						for (const c of seg) {
							b.extend(c);
						}
					}
				}
			}
			fitBounds(b);
		}
		await openRequestedFile();
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', start);
	} else {
		start();
	}
})();
