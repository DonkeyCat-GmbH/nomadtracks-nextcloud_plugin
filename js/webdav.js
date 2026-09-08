/**
 * SPDX-FileCopyrightText: 2026 DonkeyCat GmbH <office@donkeycat.com>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Minimal WebDAV client for the current user's Nextcloud files,
 * using plain fetch + the OC requesttoken (no build step, no
 * external dependency). Read-only: PROPFIND + GET only.
 */
(function () {
	'use strict';

	const NT = (window.NomadTracks = window.NomadTracks || {});

	function davRoot() {
		const uid = OC.getCurrentUser().uid;
		// e.g. https://cloud.example.com/remote.php/dav/files/<uid>
		return OC.linkToRemote('dav/files/' + uid);
	}

	/** Encode each path segment, keep the slashes. */
	function encodePath(path) {
		return path.split('/').map(encodeURIComponent).join('/');
	}

	function davUrl(path) {
		let p = path.replace(/^\/+/, '');
		return davRoot() + '/' + encodePath(p);
	}

	function davHeaders(extra) {
		return Object.assign({ requesttoken: OC.requestToken }, extra || {});
	}

	const PROPFIND_BODY =
		'<?xml version="1.0" encoding="UTF-8"?>\n' +
		'<d:propfind xmlns:d="DAV:">\n' +
		'  <d:prop>\n' +
		'    <d:resourcetype/>\n' +
		'    <d:getcontentlength/>\n' +
		'    <d:getlastmodified/>\n' +
		'  </d:prop>\n' +
		'</d:propfind>\n';

	/**
	 * List one folder (Depth: 1).
	 * Resolves to an array of { name, path, isDir, size } where `path`
	 * is relative to the user's files root (decoded, no leading slash).
	 * The folder itself is not included.
	 * Resolves to null when the folder does not exist (404).
	 */
	async function listFolder(path) {
		const res = await fetch(davUrl(path), {
			method: 'PROPFIND',
			headers: davHeaders({
				Depth: '1',
				'Content-Type': 'application/xml; charset=utf-8',
			}),
			body: PROPFIND_BODY,
		});
		if (res.status === 404) {
			return null;
		}
		if (!res.ok && res.status !== 207) {
			throw new Error('PROPFIND ' + path + ' failed: ' + res.status);
		}
		const text = await res.text();
		return parseMultistatus(text, path);
	}

	function parseMultistatus(xmlText, requestedPath) {
		const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
		const responses = doc.getElementsByTagNameNS('DAV:', 'response');
		const rootPrefix = new URL(davRoot(), window.location.href).pathname
			.replace(/\/+$/, '') + '/';
		const requested = requestedPath.replace(/^\/+/, '').replace(/\/+$/, '');
		const entries = [];
		for (let i = 0; i < responses.length; i++) {
			const r = responses[i];
			const hrefEl = r.getElementsByTagNameNS('DAV:', 'href')[0];
			if (!hrefEl) {
				continue;
			}
			// href is a URL-encoded absolute path like
			// /remote.php/dav/files/marco/NomadTracks/Tracks/Caf%C3%A9%20Runde.gpx
			let href = hrefEl.textContent || '';
			let decoded;
			try {
				decoded = href.split('/').map(decodeURIComponent).join('/');
			} catch (e) {
				decoded = href;
			}
			if (!decoded.startsWith(rootPrefix)) {
				continue;
			}
			const rel = decoded.substring(rootPrefix.length).replace(/\/+$/, '');
			if (rel === requested) {
				continue; // the folder itself
			}
			const isDir = r.getElementsByTagNameNS('DAV:', 'collection').length > 0;
			const sizeEl = r.getElementsByTagNameNS('DAV:', 'getcontentlength')[0];
			const size = sizeEl ? parseInt(sizeEl.textContent, 10) || 0 : 0;
			const name = rel.substring(rel.lastIndexOf('/') + 1);
			entries.push({ name: name, path: rel, isDir: isDir, size: size });
		}
		entries.sort(function (a, b) {
			return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
		});
		return entries;
	}

	async function getText(path) {
		const res = await fetch(davUrl(path), { headers: davHeaders() });
		if (!res.ok) {
			throw new Error('GET ' + path + ' failed: ' + res.status);
		}
		return res.text();
	}

	async function getBinary(path) {
		const res = await fetch(davUrl(path), { headers: davHeaders() });
		if (!res.ok) {
			throw new Error('GET ' + path + ' failed: ' + res.status);
		}
		return res.arrayBuffer();
	}

	/** Run `worker(item)` over `items` with at most `limit` in flight. */
	async function mapLimit(items, limit, worker) {
		const results = new Array(items.length);
		let next = 0;
		async function run() {
			while (next < items.length) {
				const i = next++;
				try {
					results[i] = await worker(items[i], i);
				} catch (e) {
					results[i] = null;
					console.warn('nomadtracks:', e);
				}
			}
		}
		const runners = [];
		for (let i = 0; i < Math.min(limit, items.length); i++) {
			runners.push(run());
		}
		await Promise.all(runners);
		return results;
	}

	NT.dav = {
		listFolder: listFolder,
		getText: getText,
		getBinary: getBinary,
		mapLimit: mapLimit,
	};
})();
