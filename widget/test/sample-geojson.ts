// Render synthetic lateral-move data to a GeoJSON you can preview (e.g. paste
// into geojson.io) to sanity-check the as-applied strips before deploying.
// Run: npm run sample-geojson
import { writeFileSync } from "node:fs";

import {
  buildSamples,
  computeEvents,
  computeStripDepths,
  buildGeoJSON,
  destinationPoint,
  type LateralConfig,
} from "../src/lib/lateral.ts";

// A lateral on the Darling Downs running ~600 m, boom 200 m centred on the path.
const startLat = -27.55;
const startLon = 151.95;
const TRAVEL_BEARING = 90; // east
const RUN_M = 600;
const [endLon, endLat] = destinationPoint(startLat, startLon, TRAVEL_BEARING, RUN_M);

const cfg: LateralConfig = {
  flowUnits: "L/s",
  pathStartLat: startLat,
  pathStartLon: startLon,
  pathEndLat: endLat,
  pathEndLon: endLon,
  leftExtentM: 100,
  rightExtentM: 100,
  endGunExtraM: 25,
  stripResolutionM: 5,
  dormancyDays: 5,
  mapsApiKey: "",
};

const FLOW_LPS = 80;
const STEP_M = 2;
const DT_MS = 60_000; // 1 step/min -> 2 m/min
const t0 = Date.UTC(2026, 4, 20, 6, 0, 0);

const rows: Array<{ t: number; flow: number; lat: number; lon: number; endGun: boolean }> = [];
let i = 0;
for (let d = 0; d <= RUN_M; d += STEP_M) {
  const [lon, lat] = destinationPoint(startLat, startLon, TRAVEL_BEARING, d);
  const flow = FLOW_LPS + 8 * Math.sin((d / RUN_M) * Math.PI * 4);
  rows.push({ t: t0 + i * DT_MS, flow: Math.max(0, flow), lat, lon, endGun: d > 400 && d < 480 });
  i++;
}

const samples = buildSamples(rows);
const events = computeEvents(samples, cfg.dormancyDays);
const event = events[events.length - 1] ?? { samples };
const result = computeStripDepths(event.samples, cfg);
const fc = buildGeoJSON(result);

const out = new URL("../as-applied.sample.geojson", import.meta.url);
writeFileSync(out, JSON.stringify(fc, null, 2));

console.log(`events detected: ${events.length}`);
console.log(`strips watered: ${fc.features.length}/${result.nStrips}`);
console.log(`path length: ${result.pathLengthM.toFixed(0)} m, bearing ${result.travelBearingDeg.toFixed(0)}°`);
console.log(`max depth:  ${result.maxDepthMm.toFixed(1)} mm`);
console.log(`mean depth: ${result.meanDepthMm.toFixed(1)} mm`);
console.log(`total applied: ${(result.totalVolumeM3 / 1000).toFixed(2)} ML`);
console.log(`wrote ${out.pathname}`);
