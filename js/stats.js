/**
 * SPDX-FileCopyrightText: 2026 DonkeyCat GmbH <office@donkeycat.com>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Track metrics for the web viewer — a faithful JavaScript port of the
 * mobile app's shared numerics so the numbers on this page match the
 * numbers in the app for the same file:
 *
 *   - `elevationStats(points)`  ← NomadTracksShared/ElevationStats.swift
 *     (`ElevationStats.computeWithReference`): vertical-accuracy gate →
 *     time-and-travel-windowed median → threshold hysteresis with a
 *     noise-scaled deadband → grade plausibility gate.
 *   - `trackStats(...)`         ← NomadTracks/Models/TrackStats.swift
 *     (`TrackStats.compute`): max / average / average-moving speed,
 *     moving time, altitude extremes, heart-rate aggregates.
 *   - `totalDistance(points)`   ← Geo.distance summed over the polyline
 *     (WGS84 sphere, R = 6 371 000 m).
 *   - the `format*` helpers     ← NomadTracksShared/LiveStatFormatting.swift,
 *     metric branch only (this page has no unit-system setting).
 *
 * Pure functions, no DOM: the file loads both as a browser script
 * (`window.NomadTracks.stats`) and as a CommonJS module, which is how
 * `tests/elevation-smoke.js` exercises the elevation port under Node.
 */
(function (root, factory) {
	'use strict';
	const api = factory();
	if (typeof module === 'object' && module && module.exports) {
		module.exports = api;
	} else {
		const NT = (root.NomadTracks = root.NomadTracks || {});
		NT.stats = api;
	}
})(typeof self !== 'undefined' ? self : this, function () {
	'use strict';

	// ---- ElevationStats.Defaults (verbatim mirror) -----------------

	const ELEVATION_DEFAULTS = {
		/** Hysteresis deadband in metres. */
		thresholdMeters: 0.5,
		/** Median window width in seconds. */
		timeConstantSeconds: 18,
		/** Minimum samples the median window must span. */
		minimumSamplesPerWindow: 9,
		/** Deadband stand-off factor over the measured noise. */
		noiseDeadbandFactor: 2,
		/** Samples with a real accuracy worse than this are dropped. */
		maxVerticalAccuracyMeters: 15,
		/**
		 * Each side of the median window must also span this much
		 * horizontal travel, so at a rest stop the median spans the
		 * stop instead of following the slow wander of a GPS-only
		 * altitude fix (the 904 m-for-342 m recording of 2026-09-14).
		 */
		medianTravelFloorMeters: 30,
		/** …but the travel floor never widens a side beyond this. */
		maximumTravelWindowSeconds: 300,
		/**
		 * Steepest step the hysteresis commits: |Δaltitude| beyond the
		 * deadband per metre of travel since the altitude left the
		 * reference level. Steeper is the fix moving on its own;
		 * dropped, reference advanced anyway.
		 */
		maximumPlausibleGrade: 0.5,
		/**
		 * The grade baseline starts at the last sample still within
		 * this fraction of the deadband of the reference — where the
		 * altitude had not yet started moving.
		 */
		anchorBandFraction: 0.25,
	};

	function ascending(a, b) {
		return a - b;
	}

	/**
	 * Median gap between consecutive samples — the recording's real
	 * cadence. Median, not mean, so one pause can't drag it away from
	 * what the sampler is actually doing.
	 */
	function medianSampleInterval(timestamps) {
		if (timestamps.length <= 1) {
			return 0;
		}
		const gaps = [];
		for (let i = 1; i < timestamps.length; i++) {
			const dt = timestamps[i] - timestamps[i - 1];
			if (dt > 0) {
				gaps.push(dt);
			}
		}
		if (gaps.length === 0) {
			return 0;
		}
		gaps.sort(ascending);
		return gaps[Math.floor(gaps.length / 2)];
	}

	/** Median |raw − smoothed|: a robust estimate of altitude noise. */
	function medianResidual(raw, smoothed) {
		if (raw.length !== smoothed.length || raw.length === 0) {
			return 0;
		}
		const residuals = new Array(raw.length);
		for (let i = 0; i < raw.length; i++) {
			residuals[i] = Math.abs(raw[i] - smoothed[i]);
		}
		residuals.sort(ascending);
		return residuals[Math.floor(residuals.length / 2)];
	}

	/**
	 * Replaces each altitude with the median of every sample whose
	 * timestamp falls within ±windowSeconds/2 of it, the window then
	 * widened outward until each side also spans
	 * `medianTravelFloorMeters` of `travel` (cumulative horizontal
	 * distance, non-decreasing) — or hits the end of the series, or
	 * `maximumTravelWindowSeconds`. Two-pointer sweep for the time
	 * bounds, exactly as in the Swift original; with `windowSeconds <= 0`
	 * (no time base) the window is the travel floor alone.
	 */
	function medianSmoothed(altitudes, timestamps, travel, windowSeconds) {
		const n = altitudes.length;
		if (n === 0) {
			return altitudes.slice();
		}
		const half = windowSeconds / 2;
		const travelFloor = ELEVATION_DEFAULTS.medianTravelFloorMeters;
		const cap = ELEVATION_DEFAULTS.maximumTravelWindowSeconds;
		const out = new Array(n);
		let lo = 0;
		let hi = 0;
		for (let i = 0; i < n; i++) {
			if (windowSeconds > 0) {
				const lower = timestamps[i] - half;
				const upper = timestamps[i] + half;
				while (lo < n && timestamps[lo] < lower) {
					lo++;
				}
				if (hi < lo) {
					hi = lo;
				}
				while (hi < n && timestamps[hi] <= upper) {
					hi++;
				}
			} else {
				// No time base: the sample alone, widened by travel.
				lo = i;
				hi = i + 1;
			}
			if (hi <= lo) {
				out[i] = altitudes[i];
				continue;
			}
			// Travel floor: widen each side until it covers enough
			// ground, stopping at the cap.
			let wlo = lo;
			while (wlo > 0
				&& travel[i] - travel[wlo] < travelFloor
				&& timestamps[i] - timestamps[wlo - 1] <= cap) {
				wlo--;
			}
			let whi = hi;
			while (whi < n
				&& travel[whi - 1] - travel[i] < travelFloor
				&& timestamps[whi] - timestamps[i] <= cap) {
				whi++;
			}
			const window = altitudes.slice(wlo, whi).sort(ascending);
			const m = window.length;
			out[i] = m % 2 === 1
				? window[(m - 1) / 2]
				: (window[m / 2 - 1] + window[m / 2]) / 2;
		}
		return out;
	}

	/**
	 * Stage 4 — how much of a hysteresis step `delta` (already past the
	 * deadband) to commit, given the horizontal distance `travelled`
	 * since the last sample still at the reference level: all of it when the ground can
	 * explain it, none of it otherwise. The deadband-sized part of the
	 * step is exempt from the grade test (the smoothed signal still
	 * carries that much noise, and a genuinely steep trail commits a
	 * step every few metres); stationary wander is several deadbands
	 * tall over a metre or two of scatter and stays out.
	 */
	function plausibleStep(delta, travelled, deadband) {
		const step = Math.abs(delta);
		return step - deadband <= ELEVATION_DEFAULTS.maximumPlausibleGrade * travelled
			? step
			: 0;
	}

	/**
	 * Stages 1–3a of the filter, shared by `elevationStats` and (in
	 * the app) the cumulative walk: the kept samples' timestamps and
	 * cumulative horizontal travel, the smoothed altitude series and
	 * the deadband stood off the measured noise.
	 */
	function prepareElevation(points, threshold, timeConstantSeconds) {
		// Stage 1 — vertical-accuracy gate. An accuracy is only
		// "known" when strictly positive (CoreLocation reports a
		// negative value with no altitude fix; GPX has none at all),
		// so the gate never rejects imported data.
		const kept = [];
		for (let i = 0; i < points.length; i++) {
			const acc = typeof points[i].verticalAccuracy === 'number'
				? points[i].verticalAccuracy
				: -1;
			if (acc > 0 && acc > ELEVATION_DEFAULTS.maxVerticalAccuracyMeters) {
				continue;
			}
			kept.push(i);
		}
		// Fewer than two usable samples is NO elevation data — not a
		// licence to use the rejected ones (F4, review of 2026-09-14).
		if (kept.length < 2) {
			return {
				timestamps: [],
				travel: [],
				smoothed: [],
				keptIndices: [],
				effectiveThreshold: threshold,
			};
		}
		const altitudes = kept.map(function (i) { return points[i].altitude; });
		const timestamps = kept.map(function (i) { return points[i].timestamp; });

		// Horizontal travel along the KEPT samples only, so a point the
		// gate dropped is invisible to every later stage. A point
		// without coordinates contributes no travel.
		const travel = new Array(kept.length);
		travel[0] = 0;
		for (let i = 1; i < kept.length; i++) {
			const a = points[kept[i - 1]];
			const b = points[kept[i]];
			const d = Number.isFinite(a.lat) && Number.isFinite(a.lon)
				&& Number.isFinite(b.lat) && Number.isFinite(b.lon)
				? distance(a, b)
				: 0;
			travel[i] = travel[i - 1] + d;
		}

		// Stage 2 — time-and-travel-windowed median, the time window
		// widened so it always holds `minimumSamplesPerWindow` samples
		// whatever the cadence; the travel floor is applied per sample
		// inside medianSmoothed.
		// A cadence of 0 means no usable time base (an import without
		// `<time>`, stamped with one and the same instant): the median
		// then spans ground only — the travel floor is the whole window
		// (F1, review of 2026-09-14).
		const cadence = medianSampleInterval(timestamps);
		const windowSeconds = cadence > 0
			? Math.max(
				Math.max(0, timeConstantSeconds),
				cadence * ELEVATION_DEFAULTS.minimumSamplesPerWindow
			)
			: 0;
		const smoothed = medianSmoothed(altitudes, timestamps, travel, windowSeconds);

		// Stage 3a — stand the deadband off the noise the smoothing
		// could not explain. Zero on a clean recording, so the 0.5 m
		// floor applies unchanged there.
		const effectiveThreshold = Math.max(
			threshold,
			ELEVATION_DEFAULTS.noiseDeadbandFactor * medianResidual(altitudes, smoothed)
		);
		return {
			timestamps: timestamps,
			travel: travel,
			smoothed: smoothed,
			keptIndices: kept,
			effectiveThreshold: effectiveThreshold,
		};
	}

	/**
	 * Elevation gain / loss through the app's four-stage filter
	 * (vertical-accuracy gate → time-and-travel-windowed median →
	 * noise-scaled threshold hysteresis → grade plausibility gate).
	 *
	 * `points` is an array of `{ lat, lon, altitude, timestamp,
	 * verticalAccuracy }` (seconds for the timestamp; `verticalAccuracy`
	 * may be omitted — GPX carries none, and the gate only ever fires
	 * on a real, positive accuracy estimate, exactly like the app).
	 *
	 * Returns `{ gain, loss, reference, smoothed, lastTimestamp }` in
	 * metres, mirroring `ElevationStats.computeWithReference`.
	 */
	function elevationStats(points, options) {
		const opts = options || {};
		const threshold = typeof opts.threshold === 'number'
			? opts.threshold
			: ELEVATION_DEFAULTS.thresholdMeters;
		const timeConstantSeconds = typeof opts.timeConstantSeconds === 'number'
			? opts.timeConstantSeconds
			: ELEVATION_DEFAULTS.timeConstantSeconds;

		if (!points || points.length === 0) {
			return { gain: 0, loss: 0, reference: null, smoothed: null, lastTimestamp: null };
		}
		const prepared = prepareElevation(points, threshold, timeConstantSeconds);
		// Fewer than two usable samples: no elevation data, no state.
		if (prepared.smoothed.length === 0) {
			return { gain: 0, loss: 0, reference: null, smoothed: null, lastTimestamp: null };
		}

		// Stages 3 + 4 — hysteresis with the grade gate on the smoothed
		// signal. Inside ±threshold the sample is noise: do not commit
		// and do NOT advance the reference, so a sustained drift keeps
		// building toward the threshold across samples.
		let reference = prepared.smoothed[0];
		let anchorTravel = prepared.travel[0];
		let smoothed = prepared.smoothed[0];
		let lastTimestamp = prepared.timestamps[0];
		let gain = 0;
		let loss = 0;
		for (let i = 1; i < prepared.smoothed.length; i++) {
			smoothed = prepared.smoothed[i];
			lastTimestamp = prepared.timestamps[i];
			const delta = smoothed - reference;
			if (Math.abs(delta) < prepared.effectiveThreshold) {
				// The anchor follows while the sample is still AT the
				// reference level, so the ground covered since it is
				// the ground over which the altitude actually changed.
				if (Math.abs(delta) < ELEVATION_DEFAULTS.anchorBandFraction * prepared.effectiveThreshold) {
					anchorTravel = prepared.travel[i];
				}
				continue;
			}
			const step = plausibleStep(
				delta,
				prepared.travel[i] - anchorTravel,
				prepared.effectiveThreshold
			);
			if (delta > 0) {
				gain += step;
			} else {
				loss += step;
			}
			reference = smoothed;
			anchorTravel = prepared.travel[i];
		}
		return {
			gain: gain,
			loss: loss,
			reference: reference,
			smoothed: smoothed,
			lastTimestamp: lastTimestamp,
		};
	}

	// ---- Geo.distance ---------------------------------------------

	const EARTH_RADIUS_METERS = 6371000;

	/** Great-circle distance in metres between two {lat, lon} points. */
	function distance(a, b) {
		const rad = Math.PI / 180;
		const lat1 = a.lat * rad;
		const lat2 = b.lat * rad;
		const dLat = (b.lat - a.lat) * rad;
		const dLon = (b.lon - a.lon) * rad;
		const h = Math.sin(dLat / 2) * Math.sin(dLat / 2)
			+ Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
		const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
		return EARTH_RADIUS_METERS * c;
	}

	/** Sum of great-circle distances between consecutive points. */
	function totalDistance(points) {
		let sum = 0;
		for (let i = 1; i < points.length; i++) {
			sum += distance(points[i - 1], points[i]);
		}
		return sum;
	}

	/** Cumulative distance in metres at each point (first is 0). */
	function cumulativeDistance(points) {
		const out = new Array(points.length);
		let sum = 0;
		for (let i = 0; i < points.length; i++) {
			if (i > 0) {
				sum += distance(points[i - 1], points[i]);
			}
			out[i] = sum;
		}
		return out;
	}

	// ---- TrackStats.compute ---------------------------------------

	/** Below this segment speed (m/s) a segment counts as a pause. */
	const MOVING_SPEED_THRESHOLD_MPS = 0.5;

	/**
	 * Port of `TrackStats.compute`. `points` are
	 * `{ lat, lon, altitude?, timestamp?, speed?, hr? }`; `distanceMeters`
	 * and `durationSeconds` are the track summary values (see
	 * `totalDistance` / first-to-last timestamp).
	 *
	 * Every field is `null` when it cannot be derived — the caller omits
	 * the row rather than printing a placeholder.
	 */
	function trackStats(points, distanceMeters, durationSeconds) {
		const empty = {
			maxSpeedMps: null,
			avgSpeedMps: null,
			avgMovingSpeedMps: null,
			movingTimeSeconds: null,
			maxAltitudeMeters: null,
			minAltitudeMeters: null,
			avgHeartRateBpm: null,
			maxHeartRateBpm: null,
			minHeartRateBpm: null,
		};
		if (!points || points.length === 0) {
			return empty;
		}
		const hr = heartRateStats(points);

		const first = points[0];
		let maxSpeed = -1;
		let minAlt = Number.isFinite(first.altitude) ? first.altitude : null;
		let maxAlt = minAlt;
		if (typeof first.speed === 'number' && first.speed >= 0) {
			maxSpeed = first.speed;
		}
		let movingTime = 0;
		let haveTiming = false;

		for (let i = 1; i < points.length; i++) {
			const prev = points[i - 1];
			const cur = points[i];

			// Altitude extremes — every sample participates, so an
			// outlier at either end is preserved (smoothing here would
			// hide the actual peak / trough the user reached).
			if (Number.isFinite(cur.altitude)) {
				if (minAlt === null || cur.altitude < minAlt) {
					minAlt = cur.altitude;
				}
				if (maxAlt === null || cur.altitude > maxAlt) {
					maxAlt = cur.altitude;
				}
			}

			// Effective segment speed: the GPS-reported value when
			// valid, otherwise inferred from the position / time delta.
			if (!Number.isFinite(prev.timestamp) || !Number.isFinite(cur.timestamp)) {
				continue;
			}
			haveTiming = true;
			const dt = cur.timestamp - prev.timestamp;
			const segmentDistance = distance(prev, cur);
			const inferred = dt > 0.001 ? segmentDistance / dt : 0;
			const reported = typeof cur.speed === 'number' ? cur.speed : -1;
			const effective = reported >= 0 ? reported : inferred;
			if (effective > maxSpeed) {
				maxSpeed = effective;
			}
			if (dt > 0 && effective >= MOVING_SPEED_THRESHOLD_MPS) {
				movingTime += dt;
			}
		}

		const avgSpeed = durationSeconds > 0 ? distanceMeters / durationSeconds : null;
		const avgMovingSpeed = movingTime > 0 ? distanceMeters / movingTime : null;

		return {
			maxSpeedMps: maxSpeed >= 0 ? maxSpeed : null,
			avgSpeedMps: avgSpeed,
			avgMovingSpeedMps: avgMovingSpeed,
			movingTimeSeconds: haveTiming && movingTime > 0 ? movingTime : null,
			maxAltitudeMeters: maxAlt,
			minAltitudeMeters: minAlt,
			avgHeartRateBpm: hr.avg,
			maxHeartRateBpm: hr.max,
			minHeartRateBpm: hr.min,
		};
	}

	/**
	 * Mean / max / min heart rate over the points that carry an `hr`
	 * value. Non-positive readings are the codec's "no reading"
	 * sentinel and are ignored, as in `TrackStats.heartRateStats`.
	 */
	function heartRateStats(points) {
		const bpms = [];
		for (let i = 0; i < points.length; i++) {
			const bpm = points[i].hr;
			if (typeof bpm === 'number' && bpm > 0) {
				bpms.push(bpm);
			}
		}
		if (bpms.length === 0) {
			return { avg: null, max: null, min: null };
		}
		let total = 0;
		let max = bpms[0];
		let min = bpms[0];
		for (let i = 0; i < bpms.length; i++) {
			total += bpms[i];
			if (bpms[i] > max) { max = bpms[i]; }
			if (bpms[i] < min) { min = bpms[i]; }
		}
		return { avg: total / bpms.length, max: max, min: min };
	}

	// ---- formatting (metric branch of LiveStatFormatting) ----------

	function decimals(value, max) {
		return value.toLocaleString(undefined, { maximumFractionDigits: max });
	}

	/** Metres below 1 km, kilometres above (up to two decimals). */
	function formatDistance(meters) {
		if (!Number.isFinite(meters)) {
			return null;
		}
		if (meters >= 1000) {
			return decimals(meters / 1000, 2) + ' km';
		}
		return decimals(meters, 0) + ' m';
	}

	/** Whole metres — elevation is noisy at the metre level. */
	function formatElevation(meters) {
		if (!Number.isFinite(meters)) {
			return null;
		}
		return decimals(meters, 0) + ' m';
	}

	/** km/h, one decimal (the app's Track Detail precision). */
	function formatSpeed(mps) {
		if (!Number.isFinite(mps) || mps < 0) {
			return null;
		}
		return (mps * 3.6).toLocaleString(undefined, {
			minimumFractionDigits: 1,
			maximumFractionDigits: 1,
		}) + ' km/h';
	}

	/** `h:mm:ss` / `m:ss`. */
	function formatDuration(seconds) {
		if (!Number.isFinite(seconds)) {
			return null;
		}
		const total = Math.round(seconds);
		const h = Math.floor(total / 3600);
		const m = Math.floor((total % 3600) / 60);
		const s = total % 60;
		const pad = function (n) { return n < 10 ? '0' + n : String(n); };
		if (h > 0) {
			return h + ':' + pad(m) + ':' + pad(s);
		}
		return m + ':' + pad(s);
	}

	/** `m:ss /km`, or null for a non-positive distance / duration. */
	function formatPace(seconds, distanceMeters) {
		if (!Number.isFinite(seconds) || !Number.isFinite(distanceMeters)
			|| seconds <= 0 || distanceMeters <= 0) {
			return null;
		}
		const secondsPerKm = seconds * (1000 / distanceMeters);
		const total = Math.round(secondsPerKm);
		const minutes = Math.floor(total / 60);
		const secs = total % 60;
		return minutes + ':' + (secs < 10 ? '0' + secs : String(secs)) + ' /km';
	}

	return {
		ELEVATION_DEFAULTS: ELEVATION_DEFAULTS,
		MOVING_SPEED_THRESHOLD_MPS: MOVING_SPEED_THRESHOLD_MPS,
		elevationStats: elevationStats,
		medianSmoothed: medianSmoothed,
		medianSampleInterval: medianSampleInterval,
		medianResidual: medianResidual,
		prepareElevation: prepareElevation,
		distance: distance,
		totalDistance: totalDistance,
		cumulativeDistance: cumulativeDistance,
		trackStats: trackStats,
		formatDistance: formatDistance,
		formatElevation: formatElevation,
		formatSpeed: formatSpeed,
		formatDuration: formatDuration,
		formatPace: formatPace,
	};
});
