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
