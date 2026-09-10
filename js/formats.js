/**
 * SPDX-FileCopyrightText: 2026 DonkeyCat GmbH <office@donkeycat.com>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Parsers for the NomadTracks sync-schema-v1 file formats
 * (see nomadtracks-addon/docs/sync-schema-v1.md in the main repo):
 *
 *  - Tracks:  GPX 1.1, standard <trk>/<trkseg>/<trkpt lat lon> plus <wpt>.
 *  - POIs:    single-Feature GeoJSON, properties: id, name, category,
 *             color (hex), isVisibleOnMap, …
 *  - Sidecar: <name>.nomadmeta.json — { schemaVersion, item: {type, id},
 *             updatedAt (epoch ms), colorHex, rating, … }
 *  - Routes:  .nomadroute package — 8-byte ASCII magic "NMDRTE01",
 *             big-endian UInt64 metadata length, metadata JSON (which
 *             embeds the full route GPX as the "gpx" string field),
 *             then concatenated photo bytes.
 *
 * All parsers are tolerant: they return null (or empty collections)
 * on malformed input instead of throwing.
 */
(function () {
	'use strict';

	const NT = (window.NomadTracks = window.NomadTracks || {});

	/** Default polyline color when no sidecar / metadata color exists. */
	const DEFAULT_TRACK_COLOR = '#1E88E5';

	/**
	 * Track categories, keyed by the raw value the sidecar carries.
	 * Mirrors `TrackCategory` in NomadTracksShared/TrackCategory.swift
	 * (raw value → displayName); the raw values are a data contract
	 * there and must not be renamed here either. The artwork in
	 * img/categories/<rawValue>.png is the app's own, so every key in
	 * this table has an icon.
	 */
	const TRACK_CATEGORY_NAMES = {
		unspecified:        'None',
		walking:            'Walking',
		nordicWalking:      'Nordic Walking',
		hiking:             'Hiking',
		trekking:           'Trekking',
		running:            'Running',
		trailRunning:       'Trail Running',
		cycling:            'Cycling',
		roadBiking:         'Road Biking',
		gravelBiking:       'Gravel Biking',
		mountainBiking:     'Mountain Biking',
		downhillBiking:     'Downhill',
		eBike:              'E-Bike',
		eMTB:               'E-MTB',
		rollerblading:      'Inline Skating',
		swimming:           'Swimming',
		kayaking:           'Kayaking',
		canoeing:           'Canoeing',
		paddleboarding:     'Paddleboarding',
		rafting:            'Rafting',
		sailing:            'Sailing',
		boating:            'Boating',
		kitesurfing:        'Kitesurfing',
		windsurfing:        'Windsurfing',
		skiing:             'Skiing',
		crossCountrySkiing: 'Cross-Country Skiing',
		skiTouring:         'Ski Touring',
		snowboarding:       'Snowboarding',
		splitboarding:      'Splitboarding',
		snowshoeing:        'Snowshoeing',
		iceSkating:         'Ice Skating',
		mountaineering:     'Mountaineering',
		climbing:           'Climbing',
		iceClimbing:        'Ice Climbing',
		paragliding:        'Paragliding',
		gliding:            'Gliding',
		flying:             'Flying',
		driving:            'Driving',
		motorcycling:       'Motorcycling',
		atv:                'ATV',
		offroad:            'Offroad',
		overlanding:        'Overlanding',
		horseriding:        'Horseriding',
		golf:               'Golf',
		surveying:          'Surveying',
		geocaching:         'Geocaching',
	};

	/**
	 * Normalise a sidecar category to a key of TRACK_CATEGORY_NAMES.
	 * Unknown or missing values fall back to 'unspecified', exactly
	 * like `Track.category` does in the app.
	 */
	function trackCategoryKey(raw) {
		return typeof raw === 'string'
			&& Object.prototype.hasOwnProperty.call(TRACK_CATEGORY_NAMES, raw)
			? raw : 'unspecified';
	}

	function trackCategoryName(raw) {
		return TRACK_CATEGORY_NAMES[trackCategoryKey(raw)];
	}

	/** Text of the first descendant element with this local name. */
	function firstText(el, localName) {
		if (!el) {
			return '';
		}
		const hits = el.getElementsByTagNameNS('*', localName);
		return hits.length > 0 ? (hits[0].textContent || '').trim() : '';
	}

	/** Text of the first *direct child* with this local name. */
	function childText(el, localName) {
		for (let n = el.firstElementChild; n; n = n.nextElementSibling) {
			if (n.localName === localName) {
				return (n.textContent || '').trim();
			}
		}
		return '';
	}

	/** ISO-8601 `<time>` → epoch seconds, or undefined. */
	function parseTimeSeconds(text) {
		if (!text) {
			return undefined;
		}
		const ms = Date.parse(text);
		return Number.isFinite(ms) ? ms / 1000 : undefined;
	}

	/**
	 * `<gpxtrkx:TrackStatsExtension>` — the pre-computed totals some
	 * source apps (Bergfex et al.) embed. The mobile app prefers these
	 * over its own re-derivation, per field, so this viewer reads them
	 * for the same reason: on already-smoothed altitudes a fresh pass
	 * through the noise-rejection filter would under-report against
	 * what the source app (and therefore the app's own UI) shows.
	 * Returns null when the block is absent.
	 */
	function parseTrackStatsExtension(trkEl) {
		if (!trkEl) {
			return null;
		}
		const blocks = trkEl.getElementsByTagNameNS('*', 'TrackStatsExtension');
		if (blocks.length === 0) {
			return null;
		}
		const fields = {
			Distance: 'distanceMeters',
			Ascent: 'ascentMeters',
			Descent: 'descentMeters',
			TotalElapsedTime: 'totalElapsedSeconds',
			MovingTime: 'movingSeconds',
			MaxSpeed: 'maxSpeedMetersPerSecond',
			MovingSpeed: 'movingSpeedMetersPerSecond',
			MinElevation: 'minElevationMeters',
			MaxElevation: 'maxElevationMeters',
		};
		const out = { hasTrustedFields: false };
		for (let n = blocks[0].firstElementChild; n; n = n.nextElementSibling) {
			const key = fields[n.localName];
			if (!key) {
				continue;
			}
			const value = parseFloat((n.textContent || '').trim());
			if (!Number.isFinite(value)) {
				continue;
			}
			out[key] = value;
			// Only Ascent / Descent mark the block authoritative —
			// mirrors `GPXImporter.applySourceStatsField`.
			if (n.localName === 'Ascent' || n.localName === 'Descent') {
				out.hasTrustedFields = true;
			}
		}
		return out;
	}

	/**
	 * Parse a GPX document string. Returns null on malformed input or
	 * when the document carries neither a track nor a waypoint.
	 *
	 * {
	 *   name,                              // <trk><name>, else <metadata><name>
	 *   description,                       // <trk><desc>, else <metadata><desc>
	 *   segments:      [ [ [lon, lat], … ] ],       // map geometry
	 *   pointSegments: [ [ { lat, lon, altitude?, timestamp?, hr? } ] ],
	 *   waypoints:     [ { lon, lat, name } ],
	 *   sourceStats:   { … } | null        // <gpxtrkx:TrackStatsExtension>
	 * }
	 *
	 * `timestamp` is epoch **seconds** and `hr` comes from Garmin's
	 * `<gpxtpx:TrackPointExtension><gpxtpx:hr>`; both are omitted when
	 * the point does not carry them. No value is ever invented.
	 */
	function parseGpx(text) {
		let doc;
		try {
			doc = new DOMParser().parseFromString(text, 'application/xml');
		} catch (e) {
			return null;
		}
		if (!doc || doc.getElementsByTagName('parsererror').length > 0) {
			return null;
		}

		const segments = [];
		const pointSegments = [];
		const segEls = doc.getElementsByTagNameNS('*', 'trkseg');
		for (let i = 0; i < segEls.length; i++) {
			const pts = [];
			const detailed = [];
			const ptEls = segEls[i].getElementsByTagNameNS('*', 'trkpt');
			for (let j = 0; j < ptEls.length; j++) {
				const el = ptEls[j];
				const lat = parseFloat(el.getAttribute('lat'));
				const lon = parseFloat(el.getAttribute('lon'));
				if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
					continue;
				}
				pts.push([lon, lat]);
				const point = { lat: lat, lon: lon };
				const ele = parseFloat(childText(el, 'ele'));
				if (Number.isFinite(ele)) {
					point.altitude = ele;
				}
				const ts = parseTimeSeconds(childText(el, 'time'));
				if (ts !== undefined) {
					point.timestamp = ts;
				}
				const hr = parseFloat(firstText(el, 'hr'));
				if (Number.isFinite(hr)) {
					point.hr = hr;
				}
				detailed.push(point);
			}
			if (pts.length > 1) {
				segments.push(pts);
				pointSegments.push(detailed);
			}
		}

		const waypoints = [];
		const wptEls = doc.getElementsByTagNameNS('*', 'wpt');
		for (let i = 0; i < wptEls.length; i++) {
			const lat = parseFloat(wptEls[i].getAttribute('lat'));
			const lon = parseFloat(wptEls[i].getAttribute('lon'));
			if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
				continue;
			}
			let name = '';
			const nameEls = wptEls[i].getElementsByTagNameNS('*', 'name');
			if (nameEls.length > 0) {
				name = (nameEls[0].textContent || '').trim();
			}
			waypoints.push({ lon: lon, lat: lat, name: name });
		}

		const trkEls = doc.getElementsByTagNameNS('*', 'trk');
		const trk = trkEls.length > 0 ? trkEls[0] : null;
		const metaEls = doc.getElementsByTagNameNS('*', 'metadata');
		const meta = metaEls.length > 0 ? metaEls[0] : null;

		// `<trk>` wins over `<metadata>` for both fields: that is the
		// precedence the app's importer applies (metadata name is only
		// a fallback for a track without its own).
		const name = (trk ? childText(trk, 'name') : '')
			|| (meta ? childText(meta, 'name') : '');
		// The app exports notes as `<metadata><desc>` and imports them
		// from `<trk><desc>`, so both spellings occur in the wild.
		const description = (trk ? childText(trk, 'desc') : '')
			|| (meta ? childText(meta, 'desc') : '');

		if (segments.length === 0 && waypoints.length === 0) {
			return null;
		}
		return {
			name: name,
			description: description,
			segments: segments,
			pointSegments: pointSegments,
			waypoints: waypoints,
			sourceStats: parseTrackStatsExtension(trk),
		};
	}

	/**
	 * Parse a POI GeoJSON file (single Feature; a FeatureCollection's
	 * first Point feature is accepted too).
	 * Returns { lon, lat, name, color, category, isVisibleOnMap } or null.
	 */
	function parsePoi(text) {
		let root;
		try {
			root = JSON.parse(text);
		} catch (e) {
			return null;
		}
		let feature = null;
		if (root && root.type === 'Feature') {
			feature = root;
		} else if (root && root.type === 'FeatureCollection' && Array.isArray(root.features)) {
			feature = root.features.find(function (f) {
				return f && f.geometry && f.geometry.type === 'Point';
			}) || null;
		}
		if (!feature || !feature.geometry || feature.geometry.type !== 'Point') {
			return null;
		}
		const coords = feature.geometry.coordinates;
		if (!Array.isArray(coords) || coords.length < 2
			|| !Number.isFinite(coords[0]) || !Number.isFinite(coords[1])) {
			return null;
		}
		const props = feature.properties || {};
		return {
			lon: coords[0],
			lat: coords[1],
			// The exporter appends altitude as the third coordinate
			// when the POI has one; it is absent otherwise.
			altitude: coords.length > 2 && Number.isFinite(coords[2]) ? coords[2] : null,
			name: typeof props.name === 'string' ? props.name : '',
			color: normalizeColor(props.color),
			category: typeof props.category === 'string' ? props.category : '',
			categoryDisplayName: typeof props.categoryDisplayName === 'string'
				? props.categoryDisplayName : '',
			notes: typeof props.notes === 'string' ? props.notes : '',
			createdAt: typeof props.createdAt === 'string' ? props.createdAt : '',
			horizontalAccuracy: typeof props.horizontalAccuracy === 'number'
				? props.horizontalAccuracy : null,
			folder: typeof props.folder === 'string' ? props.folder : '',
			folderPath: typeof props.folderPath === 'string' ? props.folderPath : '',
			source: typeof props.source === 'string' ? props.source : '',
			isVisibleOnMap: props.isVisibleOnMap !== false,
		};
	}

	/**
	 * Parse a `.nomadmeta.json` sidecar. Returns
	 * { itemType, itemId, updatedAt, colorHex, name, … } or null.
	 */
	function parseSidecar(text) {
		let root;
		try {
			root = JSON.parse(text);
		} catch (e) {
			return null;
		}
		if (!root || typeof root !== 'object'
			|| !root.item || typeof root.item.type !== 'string'
			|| typeof root.item.id !== 'string') {
			return null;
		}
		return {
			itemType: root.item.type,
			itemId: root.item.id,
			updatedAt: typeof root.updatedAt === 'number' ? root.updatedAt : 0,
			colorHex: normalizeColor(root.colorHex),
			rating: typeof root.rating === 'number' ? root.rating : null,
			category: typeof root.category === 'string' ? root.category : null,
			isVisibleOnMap: typeof root.isVisibleOnMap === 'boolean' ? root.isVisibleOnMap : null,
			name: typeof root.name === 'string' ? root.name : null,
			notes: typeof root.notes === 'string' ? root.notes : null,
			profileRaw: typeof root.profileRaw === 'string' ? root.profileRaw : null,
			isLoop: typeof root.isLoop === 'boolean' ? root.isLoop : null,
			address: parseAddress(root.address),
			photoCount: Array.isArray(root.photos) ? root.photos.length : null,
			device: typeof root.device === 'string' ? root.device : null,
		};
	}

	/**
	 * The sidecar's `address` block (§3.1) — the reverse-geocoded start
	 * location the app shows under "Start Location". Returns null when
	 * absent or when every component is empty.
	 */
	function parseAddress(value) {
		if (!value || typeof value !== 'object') {
			return null;
		}
		const keys = ['street', 'city', 'postalCode', 'region', 'country'];
		const out = {};
		let any = false;
		for (const key of keys) {
			const v = typeof value[key] === 'string' ? value[key].trim() : '';
			out[key] = v;
			if (v !== '') {
				any = true;
			}
		}
		return any ? out : null;
	}

	/**
	 * Parse a `.nomadroute` package (ArrayBuffer).
	 * Layout: "NMDRTE01" + UInt64 BE metadata length + metadata JSON
	 * + photo bytes. The metadata JSON carries the full route GPX in
	 * its "gpx" field, plus name / colorHex / waypoints / … .
	 * Returns { meta, gpx } (gpx already parsed via parseGpx) or null.
	 */
	function parseRoutePackage(buffer) {
		if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 16) {
			return null;
		}
		const bytes = new Uint8Array(buffer);
		const magic = String.fromCharCode.apply(null, bytes.subarray(0, 8));
		if (magic !== 'NMDRTE01') {
			return null;
		}
		const view = new DataView(buffer);
		const hi = view.getUint32(8, false);
		const lo = view.getUint32(12, false);
		if (hi !== 0) {
			return null; // > 4 GB metadata: not a sane package
		}
		const jsonLen = lo;
		if (16 + jsonLen > buffer.byteLength) {
			return null;
		}
		let meta;
		try {
			const jsonText = new TextDecoder('utf-8').decode(bytes.subarray(16, 16 + jsonLen));
			meta = JSON.parse(jsonText);
		} catch (e) {
			return null;
		}
		if (!meta || typeof meta !== 'object') {
			return null;
		}
		const gpx = typeof meta.gpx === 'string' ? parseGpx(meta.gpx) : null;
		return { meta: meta, gpx: gpx };
	}

	/**
	 * `Day 1.gpx` → `Day 1.nomadmeta.json` — mirror of
	 * NomadMetaCodec.sidecarPath on iOS/Android.
	 */
	function sidecarPathFor(dataPath) {
		const slash = dataPath.lastIndexOf('/');
		const dot = dataPath.lastIndexOf('.');
		if (dot <= slash) {
			return dataPath + '.nomadmeta.json';
		}
		return dataPath.substring(0, dot) + '.nomadmeta.json';
	}

	function isSidecarPath(path) {
		return path.toLowerCase().endsWith('.nomadmeta.json');
	}

	/** Accept only #RGB / #RRGGBB(AA) strings; anything else → null. */
	function normalizeColor(value) {
		if (typeof value !== 'string') {
			return null;
		}
		const v = value.trim();
		return /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3}([0-9a-fA-F]{2})?)?$/.test(v) ? v : null;
	}

	NT.formats = {
		DEFAULT_TRACK_COLOR: DEFAULT_TRACK_COLOR,
		parseGpx: parseGpx,
		parsePoi: parsePoi,
		parseSidecar: parseSidecar,
		parseRoutePackage: parseRoutePackage,
		sidecarPathFor: sidecarPathFor,
		isSidecarPath: isSidecarPath,
		normalizeColor: normalizeColor,
		TRACK_CATEGORY_NAMES: TRACK_CATEGORY_NAMES,
		trackCategoryKey: trackCategoryKey,
		trackCategoryName: trackCategoryName,
	};
})();
