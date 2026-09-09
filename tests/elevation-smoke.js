#!/usr/bin/env node
/**
 * SPDX-FileCopyrightText: 2026 DonkeyCat GmbH <office@donkeycat.com>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Smoke test for js/stats.js — the JavaScript port of the app's
 * shared numerics (NomadTracksShared/ElevationStats.swift and
 * NomadTracks/Models/TrackStats.swift).
 *
 * Run: node tests/elevation-smoke.js
 *
 * The assertions encode the behaviour the Swift original documents,
 * not values scraped from a run of this port:
 *
 *   1. the three stages exist and are wired in the documented order
 *      (gate → cadence-widened time-windowed median → hysteresis with
 *      a noise-scaled deadband);
 *   2. GPS jitter does not inflate gain — including at the slow (6 s)
 *      recording cadence that produced the Zillertal 1692 m-for-700 m
 *      bug the `minimumSamplesPerWindow` constant was added to fix;
 *   3. a real climb is still reported at close to its true size (the
 *      median must not suppress genuine elevation change);
 *   4. the vertical-accuracy gate drops junk fixes, and never fires on
 *      GPX data (which carries no per-point accuracy at all).
 */
'use strict';

const assert = require('assert');
const path = require('path');
const S = require(path.join(__dirname, '..', 'js', 'stats.js'));

let checks = 0;
function ok(label, condition, detail) {
	checks++;
	assert.ok(condition, label + (detail ? ' — ' + detail : ''));
	console.log('  ok  ' + label + (detail ? '  (' + detail + ')' : ''));
}

/** Deterministic pseudo-random noise so the test never flakes. */
function makeJitter(seed) {
	let s = seed >>> 0;
	return function () {
		s = (s * 1664525 + 1013904223) >>> 0;
		return (s / 4294967296) * 2 - 1; // −1 … +1
	};
}

/** The naive metric this filter exists to replace. */
function naiveGain(points) {
	let sum = 0;
	for (let i = 1; i < points.length; i++) {
		const d = points[i].altitude - points[i - 1].altitude;
		if (d > 0) {
			sum += d;
		}
	}
	return sum;
}

function fmt(x) {
	return Math.round(x * 10) / 10;
}

// ---------------------------------------------------------------
console.log('stage helpers');
// ---------------------------------------------------------------

// medianSampleInterval: median of the positive gaps. Gaps are
// 1, 1, 8, 1 → sorted 1,1,1,8 → index 4/2 = 2 → 1.
ok(
	'medianSampleInterval takes the median gap, not the mean',
	S.medianSampleInterval([0, 1, 2, 10, 11]) === 1,
	'got ' + S.medianSampleInterval([0, 1, 2, 10, 11])
);

// medianSmoothed with a window of 2 s covers ±1 s: each point sees
// itself and its immediate neighbours (1 s apart).
{
	const alt = [10, 10, 40, 10, 10];
	const ts = [0, 1, 2, 3, 4];
	const out = S.medianSmoothed(alt, ts, 2);
	ok(
		'time-windowed median rejects a single spike',
		out.every(function (v) { return v === 10; }),
		'[' + out.join(', ') + ']'
	);
}

ok(
	'a non-positive window is a pass-through',
	S.medianSmoothed([1, 2, 3], [0, 1, 2], 0).join(',') === '1,2,3'
);

// medianResidual: |raw − smoothed| = 0,0,30,0,0 → median 0.
ok(
	'medianResidual is the median |raw − smoothed|',
	S.medianResidual([10, 10, 40, 10, 10], [10, 10, 10, 10, 10]) === 0
);

// ---------------------------------------------------------------
console.log('elevation gain / loss');
// ---------------------------------------------------------------

// (a) Flat ground, 1 s cadence, ±2 m GPS jitter. The naive sum of
//     positive deltas commits the noise as climb; the filter must not.
{
	const jitter = makeJitter(20260909);
	const points = [];
	for (let i = 0; i < 1200; i++) {
		points.push({ altitude: 500 + jitter() * 2, timestamp: i, verticalAccuracy: -1 });
	}
	const result = S.elevationStats(points);
	const naive = naiveGain(points);
	ok(
		'flat + jitter: naive sum inflates, the filter does not',
		naive > 500 && result.gain < 20,
		'naive ' + fmt(naive) + ' m vs filtered ' + fmt(result.gain) + ' m'
	);
	ok(
		'flat + jitter: loss stays as small as gain',
		result.loss < 20,
		fmt(result.loss) + ' m'
	);
}

// (b) The Zillertal case from `Defaults.minimumSamplesPerWindow`:
//     the SAME jitter recorded at 6 s per point. A window fixed at
//     18 s would hold three samples and leak the noise straight
//     through; widening it by cadence (6 s × 9 = 54 s) must keep the
//     result in the same place as the fast-cadence recording above.
{
	const jitter = makeJitter(20260909);
	const points = [];
	for (let i = 0; i < 400; i++) {
		points.push({ altitude: 500 + jitter() * 2, timestamp: i * 6, verticalAccuracy: -1 });
	}
	const widened = S.elevationStats(points);
	const fixedWindow = S.elevationStats(points, { timeConstantSeconds: 18 });
	const naive = naiveGain(points);
	ok(
		'slow cadence: jitter is still not committed as climb',
		naive > 150 && widened.gain < 20,
		'naive ' + fmt(naive) + ' m vs filtered ' + fmt(widened.gain) + ' m'
	);
	// The cadence widening is what does the work here: it is applied
	// whatever `timeConstantSeconds` the caller passes, so both calls
	// land on the same 54 s window — the point being that the filter
	// is not sensitive to the seconds knob at this cadence.
	ok(
		'slow cadence: the window is widened by cadence, not by the caller',
		Math.abs(widened.gain - fixedWindow.gain) < 0.001,
		'both ' + fmt(widened.gain) + ' m'
	);
}

// (c) A real climb must survive the median: 300 m of ascent over
//     1 h at 1 s cadence, with the same ±2 m jitter on top.
{
	const jitter = makeJitter(4242);
	const points = [];
	for (let i = 0; i < 3600; i++) {
		points.push({
			altitude: 500 + (300 * i) / 3599 + jitter() * 2,
			timestamp: i,
			verticalAccuracy: -1,
		});
	}
	const result = S.elevationStats(points);
	ok(
		'a real 300 m climb is reported at close to 300 m',
		Math.abs(result.gain - 300) < 15,
		fmt(result.gain) + ' m'
	);
	ok(
		'…and produces almost no loss',
		result.loss < 10,
		fmt(result.loss) + ' m'
	);
}

// (d) Out-and-back: climb 200 m, descend the same way. Gain and loss
//     must both land near 200 m.
{
	const points = [];
	for (let i = 0; i <= 1800; i++) {
		points.push({ altitude: 100 + (200 * i) / 1800, timestamp: i });
	}
	for (let i = 1; i <= 1800; i++) {
		points.push({ altitude: 300 - (200 * i) / 1800, timestamp: 1800 + i });
	}
	const result = S.elevationStats(points);
	ok(
		'out-and-back: gain ≈ loss ≈ 200 m',
		Math.abs(result.gain - 200) < 5 && Math.abs(result.loss - 200) < 5,
		'gain ' + fmt(result.gain) + ' m, loss ' + fmt(result.loss) + ' m'
	);
}

// (e) Hysteresis: a slow, sustained drift below the deadband must
//     still accumulate, because the reference does not advance while
//     a sample sits inside ±threshold. 0.1 m per sample over 100
//     samples is 10 m of real climb in 0.1 m steps.
{
	const points = [];
	for (let i = 0; i < 100; i++) {
		points.push({ altitude: 1000 + i * 0.1, timestamp: i });
	}
	const result = S.elevationStats(points);
	ok(
		'sub-threshold drift still accumulates (reference does not advance)',
		result.gain > 8,
		fmt(result.gain) + ' m of the 9.9 m drift'
	);
}

// (f) Vertical-accuracy gate: junk fixes carrying a real, poor
//     accuracy are dropped before smoothing.
{
	const good = [];
	const withJunk = [];
	for (let i = 0; i < 600; i++) {
		const p = { altitude: 800, timestamp: i, verticalAccuracy: 5 };
		good.push(p);
		withJunk.push(p);
		if (i % 5 === 0) {
			withJunk.push({ altitude: 1400, timestamp: i + 0.5, verticalAccuracy: 40 });
		}
	}
	const gated = S.elevationStats(withJunk);
	ok(
		'poor-accuracy samples are gated out of the elevation totals',
		gated.gain < 1 && gated.loss < 1,
		'gain ' + fmt(gated.gain) + ' m, loss ' + fmt(gated.loss) + ' m'
	);
	ok(
		'gating leaves a clean recording untouched',
		S.elevationStats(good).gain < 1
	);
}

// (g) GPX has no per-point accuracy: the gate must never fire on it.
//     Same altitudes, once with `verticalAccuracy: -1` (what an
//     import carries) and once with the field absent.
{
	const a = [];
	const b = [];
	for (let i = 0; i < 300; i++) {
		const alt = 200 + Math.sin(i / 20) * 30;
		a.push({ altitude: alt, timestamp: i, verticalAccuracy: -1 });
		b.push({ altitude: alt, timestamp: i });
	}
	const ra = S.elevationStats(a);
	const rb = S.elevationStats(b);
	ok(
		'an absent accuracy behaves exactly like GPX\'s −1',
		ra.gain === rb.gain && ra.loss === rb.loss,
		fmt(ra.gain) + ' m'
	);
	ok(
		'a genuine ±30 m rolling profile is measured, not smoothed away',
		ra.gain > 100,
		fmt(ra.gain) + ' m over ~5 cycles'
	);
}

// (h) Degenerate inputs must not throw.
{
	const empty = S.elevationStats([]);
	ok('empty input yields zeroes', empty.gain === 0 && empty.loss === 0);
	const one = S.elevationStats([{ altitude: 12, timestamp: 0 }]);
	ok('single point yields zeroes', one.gain === 0 && one.loss === 0);
}

// ---------------------------------------------------------------
console.log('parity with the Swift original');
// ---------------------------------------------------------------

// The expected values below were NOT produced by this port. They come
// from compiling the app's own
// `NomadTracksShared/ElevationStats.swift` (unmodified, against a
// three-field `RecordedPoint` stand-in — the only members the file
// touches) and running `ElevationStats.compute` over the fixtures
// built here by the same deterministic generator. `swiftc -O`,
// Swift 6.3.3, printed at `%.9f`; every pair matched this port
// exactly at that precision. Re-run that harness if the Swift
// algorithm is ever tuned — a diff here means the two have drifted.
{
	const fixtures = {
		'flat-jitter-1s': function () {
			const j = makeJitter(20260909);
			const p = [];
			for (let i = 0; i < 1200; i++) {
				p.push({ altitude: 500 + j() * 2, timestamp: i, verticalAccuracy: -1 });
			}
			return p;
		},
		'flat-jitter-6s': function () {
			const j = makeJitter(20260909);
			const p = [];
			for (let i = 0; i < 400; i++) {
				p.push({ altitude: 500 + j() * 2, timestamp: i * 6, verticalAccuracy: -1 });
			}
			return p;
		},
		'climb-300m': function () {
			const j = makeJitter(4242);
			const p = [];
			for (let i = 0; i < 3600; i++) {
				p.push({
					altitude: 500 + (300 * i) / 3599 + j() * 2,
					timestamp: i,
					verticalAccuracy: -1,
				});
			}
			return p;
		},
		'out-and-back': function () {
			const p = [];
			for (let i = 0; i <= 1800; i++) {
				p.push({ altitude: 100 + (200 * i) / 1800, timestamp: i, verticalAccuracy: -1 });
			}
			for (let i = 1; i <= 1800; i++) {
				p.push({
					altitude: 300 - (200 * i) / 1800,
					timestamp: 1800 + i,
					verticalAccuracy: -1,
				});
			}
			return p;
		},
		'slow-drift': function () {
			const p = [];
			for (let i = 0; i < 100; i++) {
				p.push({ altitude: 1000 + i * 0.1, timestamp: i, verticalAccuracy: -1 });
			}
			return p;
		},
		'accuracy-gate': function () {
			const p = [];
			for (let i = 0; i < 600; i++) {
				p.push({ altitude: 800, timestamp: i, verticalAccuracy: 5 });
				if (i % 5 === 0) {
					p.push({ altitude: 1400, timestamp: i + 0.5, verticalAccuracy: 40 });
				}
			}
			return p;
		},
		'rolling-sine': function () {
			const p = [];
			for (let i = 0; i < 300; i++) {
				p.push({
					altitude: 200 + Math.sin(i / 20) * 30,
					timestamp: i,
					verticalAccuracy: -1,
				});
			}
			return p;
		},
		// Irregular cadence + a barometric staircase + a recurring
		// poor-accuracy fix: exercises all three stages at once.
		'staircase-irregular': function () {
			const j = makeJitter(777);
			const p = [];
			let t = 0;
			for (let i = 0; i < 900; i++) {
				t += 1 + Math.abs(j()) * 3;
				p.push({
					altitude: 300 + Math.floor(i / 25) * 4 + j() * 1.5,
					timestamp: t,
					verticalAccuracy: i % 7 === 0 ? 20 : 4,
				});
			}
			return p;
		},
	};
	// name: [gain, loss] as printed by the compiled Swift.
	const expected = {
		'flat-jitter-1s': ['0.000000000', '0.000000000'],
		'flat-jitter-6s': ['5.663613865', '5.598450376'],
		'climb-300m': ['298.042853055', '0.000000000'],
		'out-and-back': ['198.833333333', '198.833333333'],
		'slow-drift': ['8.550000000', '0.000000000'],
		'accuracy-gate': ['0.000000000', '0.000000000'],
		'rolling-sine': ['138.795272635', '120.529843066'],
		'staircase-irregular': ['146.860853980', '6.437231701'],
	};
	Object.keys(expected).forEach(function (name) {
		const r = S.elevationStats(fixtures[name]());
		const got = [r.gain.toFixed(9), r.loss.toFixed(9)];
		ok(
			'matches ElevationStats.swift on "' + name + '"',
			got[0] === expected[name][0] && got[1] === expected[name][1],
			'gain ' + got[0] + ', loss ' + got[1]
		);
	});
}

// ---------------------------------------------------------------
console.log('distance / TrackStats / formatting');
// ---------------------------------------------------------------

// One degree of latitude on the 6 371 km sphere is 111 194.9 m.
{
	const d = S.distance({ lat: 0, lon: 0 }, { lat: 1, lon: 0 });
	ok(
		'great-circle distance matches Geo.distance',
		Math.abs(d - 111194.9) < 1,
		fmt(d) + ' m'
	);
}

// Moving time excludes the pause: 100 points 1 s apart moving at
// ~10 m/s, then 100 points standing still.
{
	const points = [];
	for (let i = 0; i <= 100; i++) {
		points.push({ lat: 47 + i * 0.0001, lon: 11, altitude: 600, timestamp: i });
	}
	for (let i = 1; i <= 100; i++) {
		points.push({ lat: 47 + 0.01, lon: 11, altitude: 600, timestamp: 100 + i });
	}
	const dist = S.totalDistance(points);
	const stats = S.trackStats(points, dist, 200);
	ok(
		'moving time excludes the stationary tail',
		Math.abs(stats.movingTimeSeconds - 100) < 2,
		fmt(stats.movingTimeSeconds) + ' s of 200 s'
	);
	ok(
		'avg moving speed is faster than avg speed when the user paused',
		stats.avgMovingSpeedMps > stats.avgSpeedMps * 1.9,
		fmt(stats.avgSpeedMps) + ' vs ' + fmt(stats.avgMovingSpeedMps) + ' m/s'
	);
	ok(
		'altitude extremes are reported',
		stats.minAltitudeMeters === 600 && stats.maxAltitudeMeters === 600
	);
	ok(
		'heart rate is null when no point carries one',
		stats.avgHeartRateBpm === null
	);
}

// Undrivable values come back as null so the UI can omit the row.
{
	const stats = S.trackStats(
		[{ lat: 47, lon: 11, altitude: 600, timestamp: 0 }],
		0,
		0
	);
	ok(
		'a single-point track derives no speeds',
		stats.avgSpeedMps === null && stats.avgMovingSpeedMps === null
			&& stats.movingTimeSeconds === null
	);
	ok('…but still has its altitude', stats.maxAltitudeMeters === 600);
}

ok('formatDuration renders h:mm:ss', S.formatDuration(3725) === '1:02:05');
ok('formatDuration renders m:ss below an hour', S.formatDuration(65) === '1:05');
ok('formatPace renders m:ss /km', S.formatPace(3600, 10000) === '6:00 /km');
ok('formatPace refuses a zero distance', S.formatPace(3600, 0) === null);
ok('formatSpeed refuses a negative speed', S.formatSpeed(-1) === null);
ok('formatElevation refuses a non-number', S.formatElevation(NaN) === null);

console.log('\n' + checks + ' checks passed.');
