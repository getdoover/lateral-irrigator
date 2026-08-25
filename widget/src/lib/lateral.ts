// Pure computation for the lateral-move "as-applied water map".
//
// Framework-free so it can be unit-tested in isolation:
//   raw tag history -> samples -> irrigation events -> project cart GPS onto
//   the travel path -> per-strip applied depth (mm) -> GeoJSON rectangles.

export interface TagRef {
  app_name?: string;
  tag_name?: string;
}

export interface LateralConfig {
  flowUnits: string; // "L/s" | "L/min" | "m3/h" | "US gpm"
  pathStartLat: number;
  pathStartLon: number;
  pathEndLat: number;
  pathEndLon: number;
  leftExtentM: number; // metres watered left of travel
  rightExtentM: number; // metres watered right of travel
  endGunExtraM: number; // extra each side when end-gun on
  stripResolutionM: number;
  /** Kalman velocity random-walk intensity for the track estimate. 0 = off. */
  trackResponsiveness: number;
  /** How far the cart must double back before it counts as a new pass, in metres. */
  reversalThresholdM: number;
  dormancyDays: number;
  mapsApiKey: string;
}

/** A single point in time with whatever values were logged for it. */
export interface Sample {
  t: number; // epoch ms
  flow: number | null;
  lat: number | null;
  lon: number | null;
  endGun: boolean | null;
}

export interface IrrigationEvent {
  startMs: number;
  endMs: number;
  samples: Sample[];
}

export interface StripResult {
  depthMm: Float64Array; // per strip along the path
  leftM: Float64Array; // effective left extent per strip (incl. end-gun)
  rightM: Float64Array; // effective right extent per strip
  nStrips: number;
  stripResM: number;
  pathLengthM: number;
  travelBearingDeg: number;
  startLat: number;
  startLon: number;
  centreLat: number;
  centreLon: number;
  fitMetres: number;
  maxDepthMm: number;
  colourMaxMm: number;
  meanDepthMm: number;
  totalVolumeM3: number;
}

const FLOW_EPS = 0.01;
const EARTH_RADIUS_M = 6378137;
const D2R = Math.PI / 180;

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

// --- units ------------------------------------------------------------------

export function flowToM3s(value: number, units: string): number {
  switch (units) {
    case "L/s":
      return value / 1000;
    case "L/min":
      return value / 1000 / 60;
    case "m3/h":
      return value / 3600;
    case "US gpm":
      return (value * 0.003785411784) / 60;
    default:
      return value / 1000;
  }
}

// --- geodesy ----------------------------------------------------------------

/** Forward geodesic: from (lat,lon) travel `distM` along `bearingDeg` (0=N, CW). */
export function destinationPoint(
  lat: number,
  lon: number,
  bearingDeg: number,
  distM: number,
): [number, number] {
  const d = distM / EARTH_RADIUS_M;
  const th = bearingDeg * D2R;
  const p1 = lat * D2R;
  const l1 = lon * D2R;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(th));
  const l2 =
    l1 + Math.atan2(Math.sin(th) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [(l2 * 180) / Math.PI, (p2 * 180) / Math.PI]; // [lon, lat]
}

/** Initial bearing (deg, 0=N, CW) from point 1 to point 2. */
export function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const p1 = lat1 * D2R;
  const p2 = lat2 * D2R;
  const dl = (lon2 - lon1) * D2R;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Great-circle distance in metres. */
export function distanceM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const p1 = lat1 * D2R;
  const p2 = lat2 * D2R;
  const dp = (lat2 - lat1) * D2R;
  const dl = (lon2 - lon1) * D2R;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Distance of (lat,lon) projected onto the path that starts at (lat0,lon0) and
 * heads along `bearingDeg`, in metres (may be negative / beyond the path). */
export function projectAlong(
  lat: number,
  lon: number,
  lat0: number,
  lon0: number,
  bearingDeg_: number,
): number {
  const east = (lon - lon0) * Math.cos(lat0 * D2R) * D2R * EARTH_RADIUS_M;
  const north = (lat - lat0) * D2R * EARTH_RADIUS_M;
  const th = bearingDeg_ * D2R;
  return east * Math.sin(th) + north * Math.cos(th);
}

// --- samples & events -------------------------------------------------------

export function buildSamples(
  rows: Array<{
    t: number;
    flow?: number | null;
    lat?: number | null;
    lon?: number | null;
    endGun?: boolean | null;
  }>,
): Sample[] {
  const sorted = [...rows].sort((a, b) => a.t - b.t);
  const out: Sample[] = [];
  let lastFlow: number | null = null;
  let lastLat: number | null = null;
  let lastLon: number | null = null;
  let lastEndGun: boolean | null = null;
  for (const r of sorted) {
    if (r.flow != null && Number.isFinite(r.flow)) lastFlow = r.flow;
    if (r.lat != null && Number.isFinite(r.lat)) lastLat = r.lat;
    if (r.lon != null && Number.isFinite(r.lon)) lastLon = r.lon;
    if (r.endGun != null) lastEndGun = Boolean(r.endGun);
    out.push({ t: r.t, flow: lastFlow, lat: lastLat, lon: lastLon, endGun: lastEndGun });
  }
  return out;
}

export function computeEvents(samples: Sample[], dormancyDays: number): IrrigationEvent[] {
  const dormancyMs = dormancyDays * 24 * 3600 * 1000;
  const boundaries: Array<{ startMs: number; endMs: number }> = [];
  let curStart: number | null = null;
  let lastFlowT: number | null = null;
  for (const s of samples) {
    const flowing = s.flow !== null && s.flow > FLOW_EPS;
    if (!flowing) continue;
    if (curStart === null || (lastFlowT !== null && s.t - lastFlowT > dormancyMs)) {
      if (curStart !== null && lastFlowT !== null) boundaries.push({ startMs: curStart, endMs: lastFlowT });
      curStart = s.t;
    }
    lastFlowT = s.t;
  }
  if (curStart !== null && lastFlowT !== null) boundaries.push({ startMs: curStart, endMs: lastFlowT });
  return boundaries.map((b) => ({
    startMs: b.startMs,
    endMs: b.endMs,
    samples: samples.filter((s) => s.t >= b.startMs && s.t <= b.endMs),
  }));
}

// --- travel track -----------------------------------------------------------

export interface TrackFix {
  t: number; // epoch ms
  d: number; // metres along the path
  /** Estimated travel speed, m/min. Present once the track has been filtered;
   *  the speed chart reads this rather than differencing `d`. */
  v?: number;
}

/** Default reversal threshold. A turn has to exceed plausible GPS error before
 * we believe it: field fixes report ~4 m accuracy, so 20 m is comfortably clear
 * of that while staying far shorter than any real pass. Short fields, or machines
 * that legitimately shuttle over short distances, want this lowered. */
export const DEFAULT_REVERSAL_M = 20;

/** Default position measurement variance, m^2. Field fixes report ~4 m accuracy
 * and 4^2 = 16. The location channel carries a per-fix `accuracy`, so this can
 * be replaced with a per-measurement value once that is plumbed through. */
export const DEFAULT_POSITION_VARIANCE_M2 = 16;

/** Guard the configured value: 0 or nonsense would make every GPS wobble a
 * turn, shattering the track into unsmoothable fragments. */
function reversalMetres(value: number | undefined): number {
  return Number.isFinite(value) && (value as number) > 0 ? (value as number) : DEFAULT_REVERSAL_M;
}

/** Split a track into monotonic runs.
 *
 * A lateral shuttles back and forth: it reaches the end of the field, reverses,
 * and waters the same strips on the way home. Each leg has to be smoothed on its
 * own -- fitting a line through a turnaround averages the outward and return
 * legs into roughly zero slope, which collapses a whole pass onto one point.
 *
 * A run ends where the cart retreats `reversalM` past that run's extreme, and the
 * next run starts at the extreme itself, so no travel is dropped or duplicated.
 */
export function splitRuns(fixes: TrackFix[], reversalM: number = DEFAULT_REVERSAL_M): TrackFix[][] {
  const minTurn = reversalMetres(reversalM);
  if (fixes.length < 2) return fixes.length ? [fixes.slice()] : [];
  const runs: TrackFix[][] = [];
  let startIdx = 0;
  let extremeIdx = 0;
  let dir = 0; // 0 = not yet established, +1 = forward, -1 = returning

  for (let i = 1; i < fixes.length; i++) {
    const d = fixes[i].d;
    if (dir === 0) {
      if (Math.abs(d - fixes[startIdx].d) >= minTurn) dir = Math.sign(d - fixes[startIdx].d);
      if (dir === 0 || (dir > 0 ? d > fixes[extremeIdx].d : d < fixes[extremeIdx].d)) extremeIdx = i;
      continue;
    }
    const advanced = dir > 0 ? d > fixes[extremeIdx].d : d < fixes[extremeIdx].d;
    if (advanced) {
      extremeIdx = i;
      continue;
    }
    const retreat = dir > 0 ? fixes[extremeIdx].d - d : d - fixes[extremeIdx].d;
    if (retreat >= minTurn) {
      runs.push(fixes.slice(startIdx, extremeIdx + 1));
      startIdx = extremeIdx; // the turn belongs to both legs
      extremeIdx = i;
      dir = -dir;
    }
  }
  runs.push(fixes.slice(startIdx));
  return runs.filter((r) => r.length > 0);
}

/** Constant-velocity Kalman filter with an RTS backward smoother, over one
 * monotonic run.
 *
 * Chosen over a local-linear (LOESS) fit for two reasons that matter here:
 *
 *  - Velocity is part of the STATE, not a derivative of a smoothed position.
 *    Differencing a smoothed track forces you to over-smooth position just to
 *    get a presentable speed trace, and that is what turned every genuine
 *    stop/start into an hour-long ramp. Reading `v` straight out of the filter
 *    keeps the map and the speed chart on one track without that cost.
 *  - The effective bandwidth adapts through the covariance as fix spacing
 *    varies, rather than being pinned to a fixed time window.
 *
 * Measured on a real 14 h event, against a LOESS fit tuned to the same map
 * quality and the same chart smoothness: roughly twice the dwell fidelity
 * (a 45 min stop 96% intact vs 64%, a 20 min stop 57% vs 31%).
 *
 * State is [distance (m), velocity (m/min)]; time is carried in minutes since
 * the run's first fix so the covariance arithmetic stays well conditioned.
 */
function kalmanRun(run: TrackFix[], q: number, r: number): TrackFix[] {
  const n = run.length;
  if (n < 2) return run.map((p) => ({ ...p, v: 0 }));
  const tm = run.map((p) => p.t / 60_000);

  const xf: number[][] = [];
  const Pf: number[][][] = [];
  const xp: number[][] = [];
  const Pp: number[][][] = [];

  // Seed velocity from the WHOLE run's average under a diffuse prior.
  //
  // This is a retrospective smoother -- the whole pass is already in hand -- so
  // the run average is a better prior than the first gap, which is the single
  // noisiest estimate available (one ~3 m step against ~4 m of GPS error).
  // In practice the diffuse covariance below means the seed barely matters and
  // the RTS backward pass overwrites it; starting at v=0 was the real problem,
  // because a tight prior there makes the filter believe the machine is parked.
  const span = Math.max(1e-6, tm[n - 1] - tm[0]);
  let x = [run[0].d, (run[n - 1].d - run[0].d) / span];
  let P = [
    [r, 0],
    [0, 1e4],
  ];
  const snap = () => [
    [P[0][0], P[0][1]],
    [P[1][0], P[1][1]],
  ];
  xf.push([...x]);
  Pf.push(snap());
  xp.push([...x]);
  Pp.push(snap());

  for (let k = 1; k < n; k++) {
    const dt = Math.max(1e-6, tm[k] - tm[k - 1]);
    // predict: velocity is a random walk of intensity q
    const xpk = [x[0] + x[1] * dt, x[1]];
    const Ppk = [
      [
        P[0][0] + dt * (P[1][0] + P[0][1]) + dt * dt * P[1][1] + (q * dt * dt * dt) / 3,
        P[0][1] + dt * P[1][1] + (q * dt * dt) / 2,
      ],
      [P[1][0] + dt * P[1][1] + (q * dt * dt) / 2, P[1][1] + q * dt],
    ];
    xp.push([...xpk]);
    Pp.push([
      [Ppk[0][0], Ppk[0][1]],
      [Ppk[1][0], Ppk[1][1]],
    ]);
    // update against the measured position
    const y = run[k].d - xpk[0];
    const S = Ppk[0][0] + r;
    const K = [Ppk[0][0] / S, Ppk[1][0] / S];
    x = [xpk[0] + K[0] * y, xpk[1] + K[1] * y];
    P = [
      [(1 - K[0]) * Ppk[0][0], (1 - K[0]) * Ppk[0][1]],
      [Ppk[1][0] - K[1] * Ppk[0][0], Ppk[1][1] - K[1] * Ppk[0][1]],
    ];
    xf.push([...x]);
    Pf.push(snap());
  }

  // RTS backward pass: the map is retrospective, so use every later fix too.
  const xs = xf.map((v) => [...v]);
  for (let k = n - 2; k >= 0; k--) {
    const dt = Math.max(1e-6, tm[k + 1] - tm[k]);
    const Ppk = Pp[k + 1];
    const Pfk = Pf[k];
    const det = Ppk[0][0] * Ppk[1][1] - Ppk[0][1] * Ppk[1][0];
    if (!Number.isFinite(det) || Math.abs(det) < 1e-18) continue;
    const inv = [
      [Ppk[1][1] / det, -Ppk[0][1] / det],
      [-Ppk[1][0] / det, Ppk[0][0] / det],
    ];
    const FP = [
      [Pfk[0][0] + dt * Pfk[0][1], Pfk[0][1]],
      [Pfk[1][0] + dt * Pfk[1][1], Pfk[1][1]],
    ];
    const A = [
      [FP[0][0] * inv[0][0] + FP[0][1] * inv[1][0], FP[0][0] * inv[0][1] + FP[0][1] * inv[1][1]],
      [FP[1][0] * inv[0][0] + FP[1][1] * inv[1][0], FP[1][0] * inv[0][1] + FP[1][1] * inv[1][1]],
    ];
    const dx = [xs[k + 1][0] - xp[k + 1][0], xs[k + 1][1] - xp[k + 1][1]];
    xs[k] = [
      xf[k][0] + A[0][0] * dx[0] + A[0][1] * dx[1],
      xf[k][1] + A[1][0] * dx[0] + A[1][1] * dx[1],
    ];
  }
  return run.map((p, k) => ({ t: p.t, d: xs[k][0], v: xs[k][1] }));
}

/** Estimate the travel track per direction of travel.
 *
 * `responsiveness` is the filter's velocity random-walk intensity (q). Lower is
 * smoother, higher tracks stop/start faster. Measured on a real 14 h event:
 *
 *   q       map CV   speed spread   20 min dwell   45 min dwell
 *   1e-4      23%           1.3x            35%            67%
 *   1e-3      26%           1.5x            57%            96%
 *   3e-3      31%           1.6x            70%           104%
 *   1e-2      39%           2.1x            86%           107%
 *
 * 0 disables estimation entirely and returns the raw fixes.
 *
 * A bare Kalman rounds off a direction reversal by tens of metres, so the track
 * is split into monotonic runs first and each run is filtered on its own.
 */
export function smoothTrack(
  fixes: TrackFix[],
  responsiveness: number,
  reversalM: number = DEFAULT_REVERSAL_M,
  positionVarianceM2: number = DEFAULT_POSITION_VARIANCE_M2,
): TrackFix[] {
  if (!(responsiveness > 0) || fixes.length < 3) return fixes;
  const out: TrackFix[] = [];
  for (const run of splitRuns(fixes, reversalM)) {
    for (const p of kalmanRun(run, responsiveness, positionVarianceM2)) {
      // the turn fix is shared between adjacent runs; keep it once
      if (out.length && p.t === out[out.length - 1].t) continue;
      out.push(p);
    }
  }
  return out;
}

/** Distinct GPS fixes projected onto the travel path, smoothed per config.
 *
 * Shared by the depth computation and the speed chart so the two cannot disagree.
 */
export function buildTrack(samples: Sample[], cfg: LateralConfig): TrackFix[] {
  const travelBearing = bearingDeg(cfg.pathStartLat, cfg.pathStartLon, cfg.pathEndLat, cfg.pathEndLon);
  const along = (lat: number, lon: number) =>
    projectAlong(lat, lon, cfg.pathStartLat, cfg.pathStartLon, travelBearing);

  // GPS arrives as discrete fixes (sample-and-hold between them). Integrating
  // against the held positions aliases into per-strip banding whenever the fix
  // spacing rivals the strip size, so recover the distinct fixes and linearly
  // interpolate the along-path position in time between them.
  const fixes: Array<TrackFix & { lat: number; lon: number }> = [];
  for (const s of samples) {
    if (s.lat == null || s.lon == null) continue;
    const prev = fixes[fixes.length - 1];
    if (prev && s.lat === prev.lat && s.lon === prev.lon) continue;
    if (prev && s.t === prev.t) {
      prev.d = along(s.lat, s.lon);
      prev.lat = s.lat;
      prev.lon = s.lon;
      continue;
    }
    fixes.push({ t: s.t, d: along(s.lat, s.lon), lat: s.lat, lon: s.lon });
  }
  return smoothTrack(
    fixes.map(({ t, d }) => ({ t, d })),
    cfg.trackResponsiveness ?? 0,
    cfg.reversalThresholdM,
  );
}

// --- depth ------------------------------------------------------------------

/** Distribute applied volume across the strips spanned by [dA, dB] metres.
 * Fractions are relative to the FULL interval, so any portion that falls
 * outside the configured path [0, length] is simply not painted (rather than
 * piling onto the end strips). */
function distributeRun(
  dA: number,
  dB: number,
  res: number,
  nStrips: number,
  cb: (strip: number, fraction: number) => void,
): void {
  const a = Math.min(dA, dB);
  const b = Math.max(dA, dB);
  const length = nStrips * res;
  const full = b - a;
  if (full <= 1e-9) {
    // stationary: paint one strip only if the point is on the path
    if (a >= 0 && a <= length) cb(Math.min(nStrips - 1, Math.floor(a / res)), 1);
    return;
  }
  const lo = Math.max(0, a);
  const hi = Math.min(length, b);
  if (hi <= lo) return; // interval entirely off the path
  let cursor = lo;
  let guard = 0;
  while (cursor < hi - 1e-9 && guard < nStrips + 2) {
    guard++;
    const s = Math.min(nStrips - 1, Math.floor(cursor / res));
    const next = Math.min(hi, (s + 1) * res);
    cb(s, (next - cursor) / full); // fraction of the FULL interval
    cursor = next;
  }
}

export function computeStripDepths(samples: Sample[], cfg: LateralConfig): StripResult {
  const travelBearing = bearingDeg(cfg.pathStartLat, cfg.pathStartLon, cfg.pathEndLat, cfg.pathEndLon);
  const pathLength = distanceM(cfg.pathStartLat, cfg.pathStartLon, cfg.pathEndLat, cfg.pathEndLon);
  const res = cfg.stripResolutionM > 0 ? cfg.stripResolutionM : 5;
  const nStrips = Math.max(1, Math.ceil(pathLength / res));
  const effRes = pathLength / nStrips;
  const volume = new Float64Array(nStrips);
  const endGunUsed = new Array<boolean>(nStrips).fill(false);

  const fixes = buildTrack(samples, cfg);

  const posAt = (t: number): number | null => {
    if (fixes.length === 0) return null;
    if (t <= fixes[0].t) return fixes[0].d;
    const last = fixes[fixes.length - 1];
    if (t >= last.t) return last.d;
    let lo = 0;
    let hi = fixes.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (fixes[mid].t <= t) lo = mid;
      else hi = mid;
    }
    const fa = fixes[lo];
    const fb = fixes[hi];
    return fa.d + ((t - fa.t) / (fb.t - fa.t)) * (fb.d - fa.d);
  };

  for (let i = 0; i < samples.length - 1; i++) {
    const a = samples[i];
    const b = samples[i + 1];
    const dtSec = (b.t - a.t) / 1000;
    if (dtSec <= 0) continue;
    const flowAvg = ((a.flow ?? 0) + (b.flow ?? 0)) / 2;
    if (flowAvg <= FLOW_EPS) continue;
    const dA = posAt(a.t);
    const dB = posAt(b.t);
    if (dA == null || dB == null) continue;
    const vol = flowToM3s(flowAvg, cfg.flowUnits) * dtSec;
    const endGun = Boolean(a.endGun || b.endGun);
    distributeRun(dA, dB, effRes, nStrips, (strip, frac) => {
      volume[strip] += vol * frac;
      if (endGun) endGunUsed[strip] = true;
    });
  }

  const depthMm = new Float64Array(nStrips);
  const leftM = new Float64Array(nStrips);
  const rightM = new Float64Array(nStrips);
  let maxDepth = 0;
  let sumDepth = 0;
  let counted = 0;
  let totalVol = 0;
  const nonZero: number[] = [];
  for (let s = 0; s < nStrips; s++) {
    const extra = endGunUsed[s] ? cfg.endGunExtraM : 0;
    const left = cfg.leftExtentM + extra;
    const right = cfg.rightExtentM + extra;
    leftM[s] = left;
    rightM[s] = right;
    const swath = left + right;
    const area = swath * effRes;
    const d = area > 0 ? (volume[s] / area) * 1000 : 0;
    depthMm[s] = d;
    totalVol += volume[s];
    if (d > 0) {
      maxDepth = Math.max(maxDepth, d);
      sumDepth += d;
      counted++;
      nonZero.push(d);
    }
  }

  const colourMax = percentile(nonZero, 0.95) || maxDepth;
  const [midLon, midLat] = destinationPoint(cfg.pathStartLat, cfg.pathStartLon, travelBearing, pathLength / 2);
  // shift centre toward the watered side so the strips sit in view
  const [cLon, cLat] = destinationPoint(
    midLat,
    midLon,
    travelBearing + 90,
    (cfg.rightExtentM - cfg.leftExtentM) / 2,
  );

  return {
    depthMm,
    leftM,
    rightM,
    nStrips,
    stripResM: effRes,
    pathLengthM: pathLength,
    travelBearingDeg: travelBearing,
    startLat: cfg.pathStartLat,
    startLon: cfg.pathStartLon,
    centreLat: cLat,
    centreLon: cLon,
    fitMetres: Math.max(pathLength, cfg.leftExtentM + cfg.rightExtentM + 2 * cfg.endGunExtraM),
    maxDepthMm: maxDepth,
    colourMaxMm: colourMax,
    meanDepthMm: counted > 0 ? sumDepth / counted : 0,
    totalVolumeM3: totalVol,
  };
}

// --- GeoJSON ----------------------------------------------------------------

export type GeoJSONFeatureCollection = {
  type: "FeatureCollection";
  metadata?: Record<string, unknown>;
  features: Array<{
    type: "Feature";
    geometry: { type: "Polygon"; coordinates: number[][][] };
    properties: {
      strip: number;
      depthMm: number;
      alongFromM: number;
      alongToM: number;
      swathM: number;
      fill: string;
    };
  }>;
};

/** Build GeoJSON rectangles (strips perpendicular to travel) for watered strips. */
export function buildGeoJSON(
  result: StripResult,
  metadata?: Record<string, unknown>,
): GeoJSONFeatureCollection {
  const features: GeoJSONFeatureCollection["features"] = [];
  const bear = result.travelBearingDeg;
  const leftBear = bear - 90;
  const rightBear = bear + 90;
  for (let s = 0; s < result.nStrips; s++) {
    const depth = result.depthMm[s];
    if (depth <= 0) continue;
    const a0 = s * result.stripResM;
    const a1 = (s + 1) * result.stripResM;
    const [sLon, sLat] = destinationPoint(result.startLat, result.startLon, bear, a0);
    const [eLon, eLat] = destinationPoint(result.startLat, result.startLon, bear, a1);
    const c1 = destinationPoint(sLat, sLon, leftBear, result.leftM[s]);
    const c2 = destinationPoint(eLat, eLon, leftBear, result.leftM[s]);
    const c3 = destinationPoint(eLat, eLon, rightBear, result.rightM[s]);
    const c4 = destinationPoint(sLat, sLon, rightBear, result.rightM[s]);
    features.push({
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [[c1, c2, c3, c4, c1]] },
      properties: {
        strip: s,
        depthMm: Number(depth.toFixed(3)),
        alongFromM: Number(a0.toFixed(1)),
        alongToM: Number(a1.toFixed(1)),
        swathM: Number((result.leftM[s] + result.rightM[s]).toFixed(1)),
        fill: depthColour(depth, result.colourMaxMm),
      },
    });
  }
  const fc: GeoJSONFeatureCollection = { type: "FeatureCollection", features };
  if (metadata) fc.metadata = metadata;
  return fc;
}

export function toCSV(result: StripResult): string {
  const lines = ["strip,along_from_m,along_to_m,swath_m,depth_mm"];
  for (let s = 0; s < result.nStrips; s++) {
    if (result.depthMm[s] <= 0) continue;
    lines.push(
      `${s},${(s * result.stripResM).toFixed(1)},${((s + 1) * result.stripResM).toFixed(1)},` +
        `${(result.leftM[s] + result.rightM[s]).toFixed(1)},${result.depthMm[s].toFixed(2)}`,
    );
  }
  return lines.join("\n");
}

export function downsample<T>(arr: T[], max: number): T[] {
  if (arr.length <= max) return arr;
  const stride = Math.ceil(arr.length / max);
  const out: T[] = [];
  for (let i = 0; i < arr.length; i += stride) out.push(arr[i]);
  const last = arr[arr.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

// --- colour scale -----------------------------------------------------------

const SCALE: Array<[number, number, number]> = [
  [255, 255, 204],
  [161, 218, 180],
  [65, 182, 196],
  [44, 127, 184],
  [37, 52, 148],
];

export function depthColour(depthMm: number, maxDepthMm: number): string {
  if (maxDepthMm <= 0) return "rgb(44,127,184)";
  const t = Math.max(0, Math.min(1, depthMm / maxDepthMm));
  const seg = t * (SCALE.length - 1);
  const i = Math.min(SCALE.length - 2, Math.floor(seg));
  const f = seg - i;
  const [r1, g1, b1] = SCALE[i];
  const [r2, g2, b2] = SCALE[i + 1];
  return `rgb(${Math.round(r1 + (r2 - r1) * f)},${Math.round(g1 + (g2 - g1) * f)},${Math.round(b1 + (b2 - b1) * f)})`;
}

export function legendStops(maxDepthMm: number, n = 5): Array<{ depth: number; colour: string }> {
  const stops: Array<{ depth: number; colour: string }> = [];
  for (let i = 0; i < n; i++) {
    const depth = (maxDepthMm * i) / (n - 1);
    stops.push({ depth, colour: depthColour(depth, maxDepthMm) });
  }
  return stops;
}

/** Google Maps zoom so a field of `spanM` across roughly fills the view. */
export function zoomForSpan(lat: number, spanM: number, viewportPx = 480): number {
  const mpp = (spanM * 1.25) / viewportPx;
  const z = Math.log2((156543.03392 * Math.cos(lat * D2R)) / mpp);
  return Math.max(5, Math.min(20, Math.round(z)));
}
