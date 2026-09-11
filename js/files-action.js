/**
 * SPDX-FileCopyrightText: 2026 DonkeyCat GmbH <office@donkeycat.com>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * "Open in NomadTracks" for GPX files in the Files app. Loaded into
 * the Files page by LoadAdditionalScriptsListener.
 *
 * This app has no build step, so it cannot import @nextcloud/files.
 * It registers the action the way that library does internally:
 * Nextcloud 34+ keeps the actions in a Map under
 * `window._nc_files_scope.v4_0.fileActions` and notifies a registry
 * event target; Nextcloud 28–33 keep an array in
 * `window._nc_fileactions`. Both are written, so whichever Files app
 * is running finds the action. Callback signatures differ between
 * the two generations (v4 passes one context object, v3 passes
 * positional arguments); the helpers below accept either.
 */
(function () {
	'use strict';

	const APP_ID = 'nomadtracks';
	const GPX_MIME = 'application/gpx+xml';

	// The app icon (img/app.svg) in currentColor, so it follows the
	// menu's text colour in both themes.
	const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">'
		+ '<path d="M1.5 14.5 C3.5 10.5 5.5 14 8 11.5 C9.2 10.3 10.2 11.6 11 12" '
		+ 'fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>'
		+ '<circle cx="1.5" cy="14.5" r="1.3" fill="currentColor"/>'
		+ '<path fill="currentColor" fill-rule="evenodd" '
		+ 'd="M11 1 a4 4 0 0 1 4 4 c0 2.9 -4 7 -4 7 s-4 -4.1 -4 -7 a4 4 0 0 1 4 -4 z '
		+ 'M11 6.6 a1.6 1.6 0 1 0 0 -3.2 a1.6 1.6 0 0 0 0 3.2 z"/>'
		+ '</svg>';

	function tr(text) {
		return typeof window.t === 'function' ? window.t(APP_ID, text) : text;
	}

	function isGpx(node) {
		return !!node && (node.mime === GPX_MIME
			|| /\.gpx$/i.test(node.basename || node.name || ''));
	}

	/** v4 passes `{ nodes, view, folder }`; v3 passes `nodes, view`. */
	function nodesOf(context) {
		if (Array.isArray(context)) {
			return context;
		}
		return context && Array.isArray(context.nodes) ? context.nodes : [];
	}

	/** v4 passes `{ nodes: [node] }`; v3 passes `node, view, dir`. */
	function singleNode(context) {
		if (context && Array.isArray(context.nodes)) {
			return context.nodes[0];
		}
		return context;
	}

	function openInNomadTracks(node) {
		if (!node || typeof node.path !== 'string') {
			return false;
		}
		// `path` is relative to the user's files root, e.g.
		// "/NomadTracks/Tracks/Ride.gpx" — exactly what the map page's
		// WebDAV client expects (leading slash stripped there).
		window.location.href = OC.generateUrl('/apps/' + APP_ID + '/')
			+ '?file=' + encodeURIComponent(node.path);
		return true;
	}

	const action = {
		id: APP_ID + '-open',
		displayName: function () {
			return tr('Open in NomadTracks');
		},
		iconSvgInline: function () {
			return ICON;
		},
		enabled: function (context) {
			const nodes = nodesOf(context);
			return nodes.length === 1 && isGpx(nodes[0]);
		},
		exec: function (context) {
			return Promise.resolve(openInNomadTracks(singleNode(context)));
		},
		// Default actions are tried in ascending order; the Viewer app
		// (which GpxPod plugs into) sits at -1000, so this wins the
		// click on a GPX while still listing as a menu entry for it.
		order: -10000,
		default: 'default',
	};

	// @nextcloud/files v4 (Nextcloud 34+)
	const scope = (window._nc_files_scope = window._nc_files_scope || {});
	const v4 = (scope.v4_0 = scope.v4_0 || {});
	v4.fileActions = v4.fileActions || new Map();
	if (!v4.fileActions.has(action.id)) {
		v4.fileActions.set(action.id, action);
		if (v4.registry && typeof v4.registry.dispatchEvent === 'function') {
			v4.registry.dispatchEvent(new CustomEvent('register:action', { detail: action }));
		}
	}

	// @nextcloud/files v3 (Nextcloud 28–33)
	const v3 = (window._nc_fileactions = window._nc_fileactions || []);
	if (!v3.some(function (a) { return a && a.id === action.id; })) {
		v3.push(action);
	}
})();
