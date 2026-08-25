import { test } from "node:test";
import assert from "node:assert/strict";

import {
  flowToM3s,
  bearingDeg,
  distanceM,
  projectAlong,
  destinationPoint,
  buildSamples,
  computeEvents,
  computeStripDepths,
  smoothTrack,
  splitRuns,
  buildTrack,
  buildGeoJSON,
  toCSV,
  downsample,
  depthColour,
  zoomForSpan,
  type LateralConfig,
  type Sample,
} from "../src/lib/lateral.ts";

const DAY = 24 * 3600 * 1000;

// path: 100 m due east from (0,0); boom 50 m each side; 10 m strips
function baseCfg(overrides: Partial<LateralConfig> = {}): LateralConfig {
  const [endLon, endLat] = destinationPoint(0, 0, 90, 100);
  return {
    flowUnits: "L/s",
    pathStartLat: 0,
    pathStartLon: 0,
    pathEndLat: endLat,
    pathEndLon: endLon,
    leftExtentM: 50,
    rightExtentM: 50,
    endGunExtraM: 0,
    stripResolutionM: 10,
    trackSmoothingMinutes: 0,
    dormancyDays: 5,
    mapsApiKey: "",
    ...overrides,
  };
}

/** Cart samples driving from d=0 to d=L (metres east) at constant flow. */
function runSamples(t0: number, lengthM: number, flow: number, dtMs: number, dir = 1): Sample[] {
  const out: Sample[] = [];
  for (let k = 0; k <= lengthM; k++) {
    const d = dir > 0 ? k : lengthM - k;
    const [lon, lat] = destinationPoint(0, 0, 90, d);
    out.push({ t: t0 + k * dtMs, flow, lat, lon, endGun: null });
  }
  return out;
}

test("flowToM3s converts each unit", () => {
  assert.equal(flowToM3s(1000, "L/s"), 1);
  assert.equal(flowToM3s(60000, "L/min"), 1);
  assert.equal(flowToM3s(3600, "m3/h"), 1);
  assert.ok(Math.abs(flowToM3s(60, "US gpm") - 0.003785411784) < 1e-12);
});

test("bearingDeg & distanceM are sane", () => {
  const [lon, lat] = destinationPoint(0, 0, 90, 100);
  assert.ok(Math.abs(bearingDeg(0, 0, lat, lon) - 90) < 0.5);
  assert.ok(Math.abs(distanceM(0, 0, lat, lon) - 100) < 0.5);
});

test("projectAlong gives distance along the path", () => {
  const [lon, lat] = destinationPoint(0, 0, 90, 60);
  assert.ok(Math.abs(projectAlong(lat, lon, 0, 0, 90) - 60) < 0.5);
  // a point offset perpendicular still projects to ~60 m along
  const [olon, olat] = destinationPoint(lat, lon, 0, 30); // 30 m north
  assert.ok(Math.abs(projectAlong(olat, olon, 0, 0, 90) - 60) < 0.5);
});

test("buildSamples carries flow/lat/lon/endGun forward and sorts", () => {
  const s = buildSamples([
    { t: 30, endGun: true },
    { t: 10, flow: 10, lat: -27, lon: 151 },
    { t: 20, flow: 12 },
  ]);
  assert.deepEqual(s.map((x) => x.t), [10, 20, 30]);
  assert.equal(s[1].lat, -27); // carried
  assert.equal(s[1].flow, 12);
  assert.equal(s[2].endGun, true);
  assert.equal(s[2].lat, -27);
});

test("computeEvents splits on a dormant gap", () => {
  const t0 = 1_000_000_000_000;
  const samples: Sample[] = [
    { t: t0, flow: 10, lat: 0, lon: 0, endGun: null },
    { t: t0 + 6 * DAY, flow: 10, lat: 0, lon: 0, endGun: null },
  ];
  assert.equal(computeEvents(samples, 5).length, 2);
  assert.equal(computeEvents(samples, 7).length, 1);
});

test("a straight run at constant flow gives uniform depth = V/(swath*length)", () => {
  const cfg = baseCfg();
  const samples = runSamples(1_000_000_000_000, 100, 25, 60_000); // 25 L/s, 1 m/min
  const res = computeStripDepths(samples, cfg);
  const totalSec = 100 * 60;
  const expVol = (25 / 1000) * totalSec; // 150 m3
  const expDepth = (expVol / (100 * 100)) * 1000; // swath 100 m, length 100 m -> 15 mm
  assert.ok(Math.abs(res.totalVolumeM3 - expVol) < 1.0, `vol ${res.totalVolumeM3}`);
  assert.ok(Math.abs(res.meanDepthMm - expDepth) < 0.5, `mean ${res.meanDepthMm}`);
  for (let s = 0; s < res.nStrips; s++) {
    if (res.depthMm[s] > 0) assert.ok(Math.abs(res.depthMm[s] - expDepth) < 3, `strip ${s}=${res.depthMm[s]}`);
  }
});

test("sparse GPS fixes interpolate instead of striping (held positions)", () => {
  const cfg = baseCfg({ stripResolutionM: 5 }); // 5 m strips on the 100 m path
  const t0 = 1_000_000_000_000;
  // Flow logged every 2 min; a GPS fix only every 8 m (every 4 min), with the
  // fix row sharing its timestamp with a flow row — the seeded-data shape that
  // produced banding. Position is held between fixes by buildSamples.
  const rows: Array<{ t: number; flow?: number; lat?: number; lon?: number }> = [];
  const stepMs = 2 * 60_000;
  for (let k = 0; k * 2 <= 100 / 2; k++) {
    // 2 m/min -> 4 m per 2-min step
    const t = t0 + k * stepMs;
    rows.push({ t, flow: 25 });
    const d = k * 4;
    if (d % 8 === 0) {
      const [lon, lat] = destinationPoint(0, 0, 90, d);
      rows.push({ t, lat, lon });
    }
  }
  const res = computeStripDepths(buildSamples(rows), cfg);
  // every strip the cart crossed must be watered, at near-uniform depth
  const covered = Array.from(res.depthMm.slice(0, 20));
  const mean = covered.reduce((a, b) => a + b, 0) / covered.length;
  for (const [s, d] of covered.entries()) {
    assert.ok(d > 0, `strip ${s} is unwatered (striation)`);
    assert.ok(Math.abs(d - mean) / mean < 0.35, `strip ${s}=${d} deviates from mean ${mean}`);
  }
});

test("both travel directions accumulate (there-and-back doubles depth)", () => {
  const cfg = baseCfg();
  const t0 = 1_000_000_000_000;
  const out = runSamples(t0, 100, 25, 60_000, 1);
  // back run continues immediately (no stationary turnaround gap)
  const back = runSamples(t0 + 101 * 60_000, 100, 25, 60_000, -1);
  const res = computeStripDepths([...out, ...back], cfg);
  assert.ok(Math.abs(res.meanDepthMm - 30) < 1.5, `mean ${res.meanDepthMm}`); // ~2x 15 mm
});

test("travel beyond the configured path is dropped, not piled onto the end strip", () => {
  const cfg = baseCfg(); // path 100 m
  // cart runs 0 -> 150 m (50 m past the configured path end)
  const res = computeStripDepths(runSamples(1_000_000_000_000, 150, 25, 60_000), cfg);
  const expDepth = 15; // same uniform depth as the in-path run
  // only the 0..100 portion is painted -> ~150 m3, not ~225
  assert.ok(res.totalVolumeM3 < 175, `vol ${res.totalVolumeM3}`);
  const last = res.depthMm[res.nStrips - 1];
  assert.ok(Math.abs(last - expDepth) < 4, `last strip ${last} should not be piled`);
});

test("end-gun widens the swath on the strips where it was on", () => {
  const cfg = baseCfg({ endGunExtraM: 20 });
  const t0 = 1_000_000_000_000;
  const samples = runSamples(t0, 100, 25, 60_000).map((s, i) => ({ ...s, endGun: i < 11 })); // first ~10 m
  const res = computeStripDepths(samples, cfg);
  assert.equal(res.leftM[0], 70); // 50 + 20
  assert.equal(res.rightM[0], 70);
  assert.equal(res.leftM[res.nStrips - 1], 50);
});

test("buildGeoJSON yields closed rectangles + metadata", () => {
  const cfg = baseCfg();
  const res = computeStripDepths(runSamples(1_000_000_000_000, 100, 25, 60_000), cfg);
  const fc = buildGeoJSON(res, { foo: "bar" });
  assert.equal(fc.metadata?.foo, "bar");
  for (const f of fc.features) {
    const ring = f.geometry.coordinates[0];
    assert.equal(ring.length, 5); // 4 corners + close
    assert.deepEqual(ring[0], ring[4]);
    assert.ok(f.properties.depthMm > 0);
    assert.ok(f.properties.swathM >= 100);
    assert.match(f.properties.fill, /^rgb\(/);
  }
});

test("toCSV header + one row per watered strip", () => {
  const cfg = baseCfg();
  const res = computeStripDepths(runSamples(1_000_000_000_000, 100, 25, 60_000), cfg);
  const lines = toCSV(res).split("\n");
  assert.equal(lines[0], "strip,along_from_m,along_to_m,swath_m,depth_mm");
  const watered = Array.from(res.depthMm).filter((d) => d > 0).length;
  assert.equal(lines.length - 1, watered);
});

test("downsample keeps first & last, caps length; colour & zoom sane", () => {
  const arr = Array.from({ length: 1000 }, (_, i) => i);
  const out = downsample(arr, 100);
  assert.ok(out.length <= 101 && out[0] === 0 && out[out.length - 1] === 999);
  assert.match(depthColour(5, 10), /^rgb\(/);
  assert.equal(depthColour(5, 0), "rgb(44,127,184)");
  const z = zoomForSpan(-27.5, 400);
  assert.ok(z >= 5 && z <= 20);
});


// --- track smoothing --------------------------------------------------------

const MIN = 60_000;

test("smoothTrack is a no-op when disabled or too short to fit", () => {
  const fx = [{ t: 0, d: 0 }, { t: MIN, d: 5 }, { t: 2 * MIN, d: 10 }];
  assert.equal(smoothTrack(fx, 0), fx, "window 0 returns the input array itself");
  assert.equal(smoothTrack(fx, -1), fx, "negative window returns the input array itself");
  const two = [{ t: 0, d: 0 }, { t: MIN, d: 5 }];
  assert.equal(smoothTrack(two, 60), two, "fewer than 3 fixes cannot be fitted");
});

test("smoothTrack suppresses a jump-then-catch-up pair", () => {
  // steady 1 m/min creep, but fix 5 lands 4 m ahead of the truth. The raw track
  // then shows one very fast gap followed by a stalled one -- the artefact that
  // paints a stripe. Smoothing should pull both back toward the true rate.
  const raw = Array.from({ length: 21 }, (_, i) => ({ t: i * MIN, d: i * 1.0 }));
  raw[5].d += 4;
  const speeds = (fx: { t: number; d: number }[]) =>
    fx.slice(1).map((p, i) => (p.d - fx[i].d) / ((p.t - fx[i].t) / MIN));

  const rawSpeeds = speeds(raw);
  const smoothed = speeds(smoothTrack(raw, 8));
  const spread = (v: number[]) => Math.max(...v) - Math.min(...v);

  assert.ok(spread(rawSpeeds) > 4, `raw spread should be large, got ${spread(rawSpeeds)}`);
  assert.ok(
    spread(smoothed) < spread(rawSpeeds) / 4,
    `smoothing should collapse the spread: raw ${spread(rawSpeeds).toFixed(2)} -> ${spread(smoothed).toFixed(2)}`,
  );
});

test("smoothTrack keeps a genuine long dwell", () => {
  // 30 min of creep, 60 min parked, 30 min of creep
  const fx: Array<{ t: number; d: number }> = [];
  for (let i = 0; i <= 30; i++) fx.push({ t: i * MIN, d: i });
  for (let i = 1; i <= 60; i++) fx.push({ t: (30 + i) * MIN, d: 30 });
  for (let i = 1; i <= 30; i++) fx.push({ t: (90 + i) * MIN, d: 30 + i });

  const sm = smoothTrack(fx, 30);
  const mid = sm.find((p) => p.t === 60 * MIN)!;
  // the parked stretch must still read as parked, not smeared into travel
  assert.ok(
    Math.abs(mid.d - 30) < 6,
    `dwell position should survive smoothing, drifted to ${mid.d.toFixed(1)} m`,
  );
});

test("smoothTrack does not reverse within a single run", () => {
  // small wobbles (< REVERSAL_M) are noise, not turns: one forward run
  const fx = Array.from({ length: 20 }, (_, i) => ({
    t: i * MIN,
    d: i * 5 + (i % 2 ? 3 : -3),
  }));
  assert.equal(splitRuns(fx).length, 1, "noise must not be split into runs");
  const sm = smoothTrack(fx, 5);
  for (let i = 1; i < sm.length; i++) assert.ok(sm[i].d >= sm[i - 1].d, `dipped at ${i}`);
});

test("splitRuns finds each leg of a there-and-back pass", () => {
  const fx: Array<{ t: number; d: number }> = [];
  for (let i = 0; i <= 40; i++) fx.push({ t: i * MIN, d: i * 5 });          // out
  for (let i = 1; i <= 40; i++) fx.push({ t: (40 + i) * MIN, d: 200 - i * 5 }); // back
  const runs = splitRuns(fx);
  assert.equal(runs.length, 2);
  assert.equal(runs[0][0].d, 0);
  assert.equal(runs[0][runs[0].length - 1].d, 200, "first leg must run to the turn");
  assert.equal(runs[1][runs[1].length - 1].d, 0, "second leg must return to the start");
});

test("smoothing preserves a there-and-back track instead of collapsing it", () => {
  // Regression: a global monotone clamp pinned the return leg at the turnaround,
  // painting 7 of 21 strips at 3x depth.
  const cfg = baseCfg({ stripResolutionM: 10, trackSmoothingMinutes: 60 });
  const rows: Array<{ t: number; flow: number; lat: number; lon: number }> = [];
  const at = (m: number) => {
    const [lon, lat] = destinationPoint(0, 0, 90, m);
    return { lat, lon };
  };
  for (let i = 0; i <= 40; i++) rows.push({ t: i * MIN, flow: 100, ...at(i * 2.5) });
  for (let i = 1; i <= 40; i++) rows.push({ t: (40 + i) * MIN, flow: 100, ...at(100 - i * 2.5) });

  const r = computeStripDepths(buildSamples(rows), cfg);
  const painted = Array.from(r.depthMm).filter((d) => d > 0).length;
  assert.equal(painted, r.nStrips, `every strip should be watered, got ${painted}/${r.nStrips}`);
});

test("smoothTrack stays linear in the number of fixes", () => {
  const make = (n: number) => Array.from({ length: n }, (_, i) => ({ t: i * 120_000, d: i * 0.7 }));
  const time = (n: number) => {
    const fx = make(n);
    const t0 = process.hrtime.bigint();
    smoothTrack(fx, 60);
    return Number(process.hrtime.bigint() - t0) / 1e6;
  };
  time(2000); // warm up
  const small = Math.max(time(4000), 0.5);
  const large = time(32000); // 8x the fixes
  assert.ok(large < small * 40, `8x fixes took ${(large / small).toFixed(1)}x the time (expected ~8x, quadratic would be ~64x)`);
});

test("buildTrack projects, de-duplicates and honours the config window", () => {
  const cfg = baseCfg({ trackSmoothingMinutes: 0 });
  const [lon50, lat50] = destinationPoint(0, 0, 90, 50);
  const rows = [
    { t: 0, flow: 10, lat: 0, lon: 0 },
    { t: MIN, flow: 10, lat: 0, lon: 0 },          // duplicate position, dropped
    { t: 2 * MIN, flow: 10, lat: lat50, lon: lon50 },
  ];
  const track = buildTrack(buildSamples(rows), cfg);
  assert.equal(track.length, 2);
  assert.ok(Math.abs(track[0].d - 0) < 0.5);
  assert.ok(Math.abs(track[1].d - 50) < 0.5, `expected ~50 m, got ${track[1].d}`);
});
