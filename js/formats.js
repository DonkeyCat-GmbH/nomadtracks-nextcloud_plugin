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
	 * Parse a GPX document string.
	 * Returns { name, segments: [ [ [lon, lat], … ], … ],
	 *           waypoints: [ { lon, lat, name } ] } or null.
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
		const segEls = doc.getElementsByTagNameNS('*', 'trkseg');
		for (let i = 0; i < segEls.length; i++) {
			const pts = [];
			const ptEls = segEls[i].getElementsByTagNameNS('*', 'trkpt');
			for (let j = 0; j < ptEls.length; j++) {
				const lat = parseFloat(ptEls[j].getAttribute('lat'));
				const lon = parseFloat(ptEls[j].getAttribute('lon'));
				if (Number.isFinite(lat) && Number.isFinite(lon)) {
					pts.push([lon, lat]);
				}
			}
			if (pts.length > 1) {
				segments.push(pts);
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

		let name = '';
		const trkEls = doc.getElementsByTagNameNS('*', 'trk');
		if (trkEls.length > 0) {
			const nameEls = trkEls[0].getElementsByTagNameNS('*', 'name');
			if (nameEls.length > 0) {
				name = (nameEls[0].textContent || '').trim();
			}
		}

		if (segments.length === 0 && waypoints.length === 0) {
			return null;
		}
		return { name: name, segments: segments, waypoints: waypoints };
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
			name: typeof props.name === 'string' ? props.name : '',
			color: normalizeColor(props.color),
			category: typeof props.category === 'string' ? props.category : '',
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
		};
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
	};
})();
