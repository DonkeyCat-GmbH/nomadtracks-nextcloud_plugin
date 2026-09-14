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
 *   1. the four stages exist and are wired in the documented order
 *      (gate → time-and-travel-windowed median → hysteresis with a
 *      noise-scaled deadband → grade plausibility gate);
 *   2. GPS jitter does not inflate gain — including at the slow (6 s)
 *      recording cadence that produced the Zillertal 1692 m-for-700 m
 *      bug the `minimumSamplesPerWindow` constant was added to fix;
 *   3. a real climb is still reported at close to its true size (the
 *      median must not suppress genuine elevation change);
 *   4. the vertical-accuracy gate drops junk fixes, and never fires on
 *      GPX data (which carries no per-point accuracy at all);
 *   5. altitude drift at a rest stop — the 904 m-for-342 m recording
 *      of 2026-09-14 — is not reported as climb.
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

/** A straight walk north at `speed` m/s: sample `index` at cadence `dt`. */
function walk(index, dt, speed) {
	return { lat: 47 + (index * dt * (speed || 1.2)) / 111195, lon: 8 };
}

/** One walking sample; `verticalAccuracy` defaults to GPX's −1. */
function pt(index, dt, altitude, timestamp, verticalAccuracy) {
	const w = walk(index, dt);
	return {
		lat: w.lat,
		lon: w.lon,
		altitude: altitude,
		timestamp: timestamp,
		verticalAccuracy: typeof verticalAccuracy === 'number' ? verticalAccuracy : -1,
	};
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
	// Samples 100 m apart, so the travel floor never widens the window.
	const out = S.medianSmoothed(alt, ts, [0, 100, 200, 300, 400], 2);
	ok(
		'time-windowed median rejects a single spike',
		out.every(function (v) { return v === 10; }),
		'[' + out.join(', ') + ']'
	);
}

ok(
	'a non-positive window is a pass-through',
	S.medianSmoothed([1, 2, 3], [0, 1, 2], [0, 100, 200], 0).join(',') === '1,2,3'
);

// medianResidual: |raw − smoothed| = 0,0,30,0,0 → median 0.
ok(
	'medianResidual is the median |raw − smoothed|',
	S.medianResidual([10, 10, 40, 10, 10], [10, 10, 10, 10, 10]) === 0
);

// ---------------------------------------------------------------
console.log('elevation gain / loss');
// ---------------------------------------------------------------

// The fixtures below are shared with the parity block at the end of
// this section, and (generator for generator, including the order of
// jitter draws) with the Swift harness that produced its expected
// values. Every synthetic track WALKS: the filter measures each
// altitude step against the ground covered, so samples at one fixed
// coordinate are a phone on a table, and any altitude change on
// those is correctly reported as zero.
const fixtures = {
	// Flat ground, 1 s cadence, ±2 m GPS jitter.
	'flat-jitter-1s': function () {
		const j = makeJitter(20260909);
		const p = [];
		for (let i = 0; i < 1200; i++) {
			p.push(pt(i, 1, 500 + j() * 2, i));
		}
		return p;
	},
	// The Zillertal case from `Defaults.minimumSamplesPerWindow`: the
	// SAME jitter recorded at 6 s per point.
	'flat-jitter-6s': function () {
		const j = makeJitter(20260909);
		const p = [];
		for (let i = 0; i < 400; i++) {
			p.push(pt(i, 6, 500 + j() * 2, i * 6));
		}
		return p;
	},
	// 300 m of ascent over 1 h at 1 s cadence, ±2 m jitter on top.
	'climb-300m': function () {
		const j = makeJitter(4242);
		const p = [];
		for (let i = 0; i < 3600; i++) {
			p.push(pt(i, 1, 500 + (300 * i) / 3599 + j() * 2, i));
		}
		return p;
	},
	// Climb 200 m, descend the same way.
	'out-and-back': function () {
		const p = [];
		for (let i = 0; i <= 1800; i++) {
			p.push(pt(i, 1, 100 + (200 * i) / 1800, i));
		}
		for (let i = 1; i <= 1800; i++) {
			p.push(pt(1800 + i, 1, 300 - (200 * i) / 1800, 1800 + i));
		}
		return p;
	},
	// 0.1 m per sample over 100 samples: 9.9 m of real climb in
	// sub-deadband steps.
	'slow-drift': function () {
		const p = [];
		for (let i = 0; i < 100; i++) {
			p.push(pt(i, 1, 1000 + i * 0.1, i));
		}
		return p;
	},
	// Junk fixes carrying a real, poor accuracy.
	'accuracy-gate': function () {
		const p = [];
		for (let i = 0; i < 600; i++) {
			p.push(pt(i, 1, 800, i, 5));
			if (i % 5 === 0) {
				p.push(pt(i, 1, 1400, i + 0.5, 40));
			}
		}
		return p;
	},
	// ±30 m rolling hills: period 377 s at 1.2 m/s is 452 m per cycle,
	// a 42 % grade at the steepest — a real hill shape.
	'rolling-sine': function () {
		const p = [];
		for (let i = 0; i < 900; i++) {
			p.push(pt(i, 1, 200 + Math.sin(i / 60) * 30, i));
		}
		return p;
	},
	// Irregular cadence + a barometric staircase + a recurring
	// poor-accuracy fix: exercises every stage at once. Walks 3 m per
	// SAMPLE (the cadence is irregular).
	'staircase-irregular': function () {
		const j = makeJitter(777);
		const p = [];
		let t = 0;
		for (let i = 0; i < 900; i++) {
			t += 1 + Math.abs(j()) * 3;
			const w = walk(i, 1, 3);
			p.push({
				lat: w.lat,
				lon: w.lon,
				altitude: 300 + Math.floor(i / 25) * 4 + j() * 1.5,
				timestamp: t,
				verticalAccuracy: i % 7 === 0 ? 20 : 4,
			});
		}
		return p;
	},
	// A rest stop in the shape the recorder produces: the movement
	// gate drops stationary fixes and emits a keep-alive every ~60 s,
	// a metre or two apart, while the GPS-only altitude fix drifts
	// ±6 m in slow waves. Nothing was climbed.
	'stationary-wander': function () {
		const j = makeJitter(99);
		const p = [];
		for (let i = 0; i < 40; i++) {
			const lat = 47 + (j() * 1.5) / 111195;
			const lon = 8 + (j() * 1.5) / 111195;
			p.push({
				lat: lat,
				lon: lon,
				altitude: 700 + Math.sin(i / 3) * 6 + j() * 0.5,
				timestamp: i * 60,
			});
		}
		return p;
	},
};

// (a) Flat ground, 1 s cadence, ±2 m GPS jitter. The naive sum of
//     positive deltas commits the noise as climb; the filter must not.
{
	const points = fixtures['flat-jitter-1s']();
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

// (b) The Zillertal case: the SAME jitter recorded at 6 s per point.
//     A window fixed at 18 s would hold three samples and leak the
//     noise straight through; widening it by cadence (6 s × 9 = 54 s)
//     must keep the result in the same place as the fast-cadence
//     recording above.
{
	const points = fixtures['flat-jitter-6s']();
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
	const result = S.elevationStats(fixtures['climb-300m']());
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
	const result = S.elevationStats(fixtures['out-and-back']());
	ok(
		'out-and-back: gain ≈ loss ≈ 200 m',
		Math.abs(result.gain - 200) < 5 && Math.abs(result.loss - 200) < 5,
		'gain ' + fmt(result.gain) + ' m, loss ' + fmt(result.loss) + ' m'
	);
}

// (e) Hysteresis: a slow, sustained drift below the deadband must
//     still accumulate, because the reference does not advance while
//     a sample sits inside ±threshold. 0.1 m per sample over 100
//     samples is 10 m of real climb in 0.1 m steps; the median's
//     one-sided windows at either end of such a short series cost a
//     couple of metres.
{
	const result = S.elevationStats(fixtures['slow-drift']());
	ok(
		'sub-threshold drift still accumulates (reference does not advance)',
		result.gain > 6,
		fmt(result.gain) + ' m of the 9.9 m drift'
	);
}

// (f) Vertical-accuracy gate: junk fixes carrying a real, poor
//     accuracy are dropped before smoothing.
{
	const withJunk = fixtures['accuracy-gate']();
	const good = withJunk.filter(function (p) { return p.verticalAccuracy === 5; });
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
	const b = fixtures['rolling-sine']();
	const a = b.map(function (p) {
		return { lat: p.lat, lon: p.lon, altitude: p.altitude, timestamp: p.timestamp, verticalAccuracy: -1 };
	});
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
		fmt(ra.gain) + ' m over ~2.4 cycles'
	);
}

// (h) Degenerate inputs must not throw.
{
	const empty = S.elevationStats([]);
	ok('empty input yields zeroes', empty.gain === 0 && empty.loss === 0);
	const one = S.elevationStats([{ lat: 47, lon: 8, altitude: 12, timestamp: 0 }]);
	ok('single point yields zeroes', one.gain === 0 && one.loss === 0);
}

// (i) The GPS-wander case (2026-09-14): a 3.8 h Android hike reported
//     904 m of gain against CalTopo's 342 m, most of it altitude
//     drift at rest stops. The travel-widened median and the grade
//     gate exist for this shape; the naive sum shows what the drift
//     alone is worth.
{
	const points = fixtures['stationary-wander']();
	const result = S.elevationStats(points);
	const naive = naiveGain(points);
	ok(
		'altitude drift at a rest stop is not climb',
		naive > 20 && result.gain < 5 && result.loss < 10,
		'naive ' + fmt(naive) + ' m vs filtered ' + fmt(result.gain) + ' / ' + fmt(result.loss) + ' m'
	);
}

// (j) The grade gate, isolated: a 4 m jump in the altitude fix while
//     standing still (keep-alives a metre apart) is not ground anyone
//     covered and is dropped; the same 4 m rise across twenty minutes
//     of walking is real and kept.
{
	const j = makeJitter(5);
	const standing = [];
	const walking = [];
	for (let i = 0; i < 40; i++) {
		const altitude = i < 20 ? 700 : 704;
		standing.push({
			lat: 47 + (j() * 1) / 111195,
			lon: 8 + (j() * 1) / 111195,
			altitude: altitude,
			timestamp: i * 60,
		});
		walking.push(pt(i, 60, altitude, i * 60));
	}
	const still = S.elevationStats(standing);
	const moved = S.elevationStats(walking);
	ok(
		'a 4 m jump at a standstill is dropped by the grade gate',
		still.gain === 0 && still.loss === 0,
		'gain ' + fmt(still.gain) + ' m'
	);
	ok(
		'…while the same rise across 1.4 km of walking is kept',
		moved.gain > 3.5,
		fmt(moved.gain) + ' m'
	);
}

// ---------------------------------------------------------------
console.log('parity with the Swift original');
// ---------------------------------------------------------------

// The expected values below were NOT produced by this port. They come
// from compiling the app's own
// `NomadTracksShared/ElevationStats.swift` (unmodified, against a
// `RecordedPoint` stand-in carrying the members the file touches) and
// running `ElevationStats.compute` over the fixtures above, rebuilt
// in Swift by the same deterministic generators. `swiftc -O`, Swift
// 6.3.3, printed at `%.9f`; every pair matched this port exactly at
// that precision. Re-run that harness if the Swift algorithm is ever
// tuned — a diff here means the two have drifted.
{
	// name: [gain, loss] as printed by the compiled Swift.
	const expected = {
		'flat-jitter-1s': ['0.000000000', '0.000000000'],
		'flat-jitter-6s': ['0.000000000', '0.000000000'],
		'climb-300m': ['297.112650572', '0.000000000'],
		'out-and-back': ['197.111111111', '197.055555556'],
		'slow-drift': ['7.000000000', '0.000000000'],
		'accuracy-gate': ['0.000000000', '0.000000000'],
		'rolling-sine': ['139.097390209', '121.006000062'],
		'staircase-irregular': ['140.432554627', '0.000000000'],
		'stationary-wander': ['2.686889562', '0.000000000'],
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
