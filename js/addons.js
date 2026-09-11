/**
 * SPDX-FileCopyrightText: 2026 DonkeyCat GmbH <office@donkeycat.com>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Add-on registry. Special-purpose tools that work on the selected
 * tracks — the kind of feature only some users want — live in
 * js/addons/<id>.js, register here at load time, and appear in the
 * "Add-ons" menu at the end of the selection summary. Nothing else in
 * the app knows about them individually.
 *
 * Adding one: create js/addons/<id>.js that calls
 * `NomadTracks.addons.register({...})`, and load it from
 * PageController after `addons` and before `main`.
 *
 * Contract:
 *
 *   {
 *     id:          string  — unique, stable (used to remember the open panel)
 *     title(ctx):  string  — menu entry / panel heading (translated)
 *     description(ctx): string — optional one-liner under the menu entry
 *     appliesTo(ctx): boolean — optional; false hides the entry for
 *                  this selection (e.g. needs timestamps)
 *     render(container, ctx): void — build the add-on's UI into
 *                  `container`; called each time the panel opens or
 *                  the selection changes while it is open
 *   }
 *
 *   ctx = {
 *     tracks:    loaded, ticked tracks, oldest first; each has
 *                .name .path .gpx .detail .sidecar .color
 *     aggregate: the summary totals (see aggregateTracks in main.js)
 *     ui:        { makeEl(tag, className, text), tr(text), showToast(text) }
 *   }
 *
 * Add-ons must not write to the synced files and should keep any of
 * their own state in localStorage under a 'nomadtracks-<id>-…' key.
 */
(function () {
	'use strict';

	const NT = (window.NomadTracks = window.NomadTracks || {});
	const registry = [];

	function register(addon) {
		if (!addon || typeof addon.id !== 'string' || !addon.id) {
			throw new Error('nomadtracks add-on: id is required');
		}
		if (typeof addon.title !== 'function' || typeof addon.render !== 'function') {
			throw new Error('nomadtracks add-on "' + addon.id + '": title() and render() are required');
		}
		if (registry.some(function (a) { return a.id === addon.id; })) {
			console.warn('nomadtracks add-on "' + addon.id + '" registered twice; ignoring the second');
			return;
		}
		registry.push(addon);
	}

	function all() {
		return registry.slice();
	}

	NT.addons = { register: register, all: all };
})();
