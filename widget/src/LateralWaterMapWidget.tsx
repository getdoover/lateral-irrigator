import "./styles.css";

import { useEffect, useMemo, useRef, useState } from "react";

import RemoteComponentWrapper from "customer_site/RemoteComponentWrapper";
import { useRemoteParams } from "customer_site/useRemoteParams";

import { useAgentChannel, useDooverClient } from "doover-js/react";
import { extractSnowflakeId, generateSnowflakeIdAtTime } from "doover-js";
import { useQuery } from "@tanstack/react-query";
import dayjs from "dayjs";

import GoogleMap from "google-maps-react-markers";
import {
  Area,
  Brush,
  ComposedChart,
  Line,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import {
  buildGeoJSON,
  buildSamples,
  buildTrack,
  computeEvents,
  computeStripDepths,
  distanceM,
  legendStops,
  toCSV,
  zoomForSpan,
  type IrrigationEvent,
  type LateralConfig,
  type Sample,
} from "./lib/lateral";

const HISTORY_LIMIT = 1500;
const MAX_PAGES = 40;
const CHART_BUCKETS = 600;

const BRUSH_TRACK = "oklch(0.929 0.013 255.508)";
const BRUSH_TRAVELLER = "oklch(0.208 0.042 265.755)";
const FLOW_COLOUR = "#2c7fb8";
const SPEED_COLOUR = "#dc2626";
const SPEED_MAX_GAP_MIN = 60;
// The analog flow meter reads ~0.09 (not 0) when idle, so an absolute epsilon
// near zero counts sensor noise as irrigating. Gate on a fraction of the
// window's peak flow instead, which is unit-independent.
const CHART_FLOW_FRACTION = 0.05;
// A pass shorter than this cannot support a speed estimate: the cart covers a
// few metres against ~4 m of GPS error, so the ratio is meaningless.
const MIN_PASS_MINUTES = 30;
const FLOW_FILL_MAX_GAP_MIN = 60;

const WINDOW_OPTIONS = [2, 7, 30, 90];
const DEFAULT_WINDOW_DAYS = 2;

type GpsMode = "two" | "single" | "location";
interface TagRefRaw {
  app_name?: string;
  tag_name?: string;
}
interface RawConfig {
  gps_source?: string;
  lat_tag?: TagRefRaw;
  lon_tag?: TagRefRaw;
  gps_tag?: TagRefRaw;
  gps_lat_key?: string;
  gps_lon_key?: string;
  flow_tag?: TagRefRaw;
  end_gun_tag?: TagRefRaw;
  flow_units?: string;
  path_start_lat?: number;
  path_start_lon?: number;
  path_end_lat?: number;
  path_end_lon?: number;
  left_extent_m?: number;
  right_extent_m?: number;
  end_gun_extra_m?: number;
  strip_resolution_m?: number;
  track_responsiveness?: number;
  reversal_threshold_m?: number;
  dormancy_days?: number;
  google_maps_api_key?: string;
}

// component config = lib LateralConfig + the fetch/parse fields
interface Cfg extends LateralConfig {
  gpsMode: GpsMode;
  flow: Required<TagRefRaw>;
  endGun?: Required<TagRefRaw>;
  lat?: Required<TagRefRaw>;
  lon?: Required<TagRefRaw>;
  gps?: Required<TagRefRaw>;
  latKey: string;
  lonKey: string;
}

interface ChartPoint {
  t: number;
  flow: number;
  speed: number | null; // m/hr
}

function tagOk(t?: TagRefRaw): t is Required<TagRefRaw> {
  return Boolean(t?.app_name && t?.tag_name);
}

function gpsModeOf(s?: string): GpsMode {
  const v = (s ?? "").toLowerCase();
  if (v.includes("location")) return "location";
  if (v.includes("single")) return "single";
  return "two";
}

function toCfg(raw: RawConfig): Cfg | null {
  if (
    raw.path_start_lat == null ||
    raw.path_start_lon == null ||
    raw.path_end_lat == null ||
    raw.path_end_lon == null ||
    !tagOk(raw.flow_tag)
  ) {
    return null;
  }
  return {
    gpsMode: gpsModeOf(raw.gps_source),
    flow: raw.flow_tag,
    endGun: tagOk(raw.end_gun_tag) ? raw.end_gun_tag : undefined,
    lat: tagOk(raw.lat_tag) ? raw.lat_tag : undefined,
    lon: tagOk(raw.lon_tag) ? raw.lon_tag : undefined,
    gps: tagOk(raw.gps_tag) ? raw.gps_tag : undefined,
    latKey: raw.gps_lat_key ?? "lat",
    lonKey: raw.gps_lon_key ?? "lon",
    flowUnits: raw.flow_units ?? "L/s",
    pathStartLat: raw.path_start_lat,
    pathStartLon: raw.path_start_lon,
    pathEndLat: raw.path_end_lat,
    pathEndLon: raw.path_end_lon,
    leftExtentM: raw.left_extent_m ?? 50,
    rightExtentM: raw.right_extent_m ?? 50,
    endGunExtraM: raw.end_gun_extra_m ?? 0,
    stripResolutionM: raw.strip_resolution_m ?? 5,
    trackResponsiveness: raw.track_responsiveness ?? 0.001,
    reversalThresholdM: raw.reversal_threshold_m ?? 20,
    dormancyDays: raw.dormancy_days ?? 5,
    mapsApiKey: raw.google_maps_api_key ?? "",
  };
}

const num = (x: unknown) => (typeof x === "number" ? x : typeof x === "string" ? Number(x) : null);
const truthy = (x: unknown) => x === true || x === 1 || x === "true" || x === "True" || x === "1";

function parseLatLon(val: unknown, latKey: string, lonKey: string): { lat: number; lon: number } | null {
  if (val == null) return null;
  if (Array.isArray(val) && val.length >= 2) {
    const lat = Number(val[0]);
    const lon = Number(val[1]);
    return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
  }
  if (typeof val === "object") {
    const o = val as Record<string, unknown>;
    const lat = Number(o[latKey]);
    const lon = Number(o[lonKey]);
    return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
  }
  return null;
}

function fmtRange(startMs: number, endMs: number): string {
  return `${dayjs(startMs).format("D MMM HH:mm")} – ${dayjs(endMs).format("D MMM HH:mm")}`;
}

function nearestIndex(data: ChartPoint[], t: number): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < data.length; i++) {
    const d = Math.abs(data[i].t - t);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

function download(filename: string, text: string, mime: string) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function DownloadIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

// --- flow + speed timeline with brush --------------------------------------

function brushTraveller({ x, y, width, height }: { x: number; y: number; width: number; height: number }) {
  return (
    <>
      <rect x={x} y={y} width={width} height={height} rx={width / 2} fill={BRUSH_TRAVELLER} stroke="none" />
      <rect
        x={x + 4}
        y={y + 4}
        width={width - 8}
        height={height - 8}
        rx={Math.max(0, width / 2 - 4)}
        fill="white"
        stroke="none"
      />
    </>
  );
}

function FlowTimeline({
  data,
  events,
  units,
  startIndex,
  endIndex,
  onBrush,
  showFlow,
  showSpeed,
  onToggle,
}: {
  data: ChartPoint[];
  events: IrrigationEvent[];
  units: string;
  startIndex: number;
  endIndex: number;
  onBrush: (s: number, e: number) => void;
  showFlow: boolean;
  showSpeed: boolean;
  onToggle: (key: "flow" | "speed") => void;
}) {
  return (
    <div className="lwm-timeline">
      <div className="lwm-chartlegend">
        <button className={showFlow ? "lwm-legitem" : "lwm-legitem off"} onClick={() => onToggle("flow")}>
          <i style={{ background: FLOW_COLOUR }} /> Flow ({units})
        </button>
        <button className={showSpeed ? "lwm-legitem" : "lwm-legitem off"} onClick={() => onToggle("speed")}>
          <i style={{ background: SPEED_COLOUR }} /> Speed (m/hr)
        </button>
      </div>
      <ResponsiveContainer width="100%" height={180}>
        <ComposedChart data={data} margin={{ top: 6, right: 8, bottom: 0, left: 8 }}>
          <defs>
            <linearGradient id="lwmFlow" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={FLOW_COLOUR} stopOpacity={0.5} />
              <stop offset="100%" stopColor={FLOW_COLOUR} stopOpacity={0.05} />
            </linearGradient>
          </defs>
          <XAxis
            dataKey="t"
            type="number"
            scale="time"
            domain={["dataMin", "dataMax"]}
            tickFormatter={(t) => dayjs(t).format("D MMM HH:mm")}
            tick={{ fontSize: 11, fill: "#64748b" }}
            minTickGap={50}
          />
          <YAxis yAxisId="flow" hide domain={[0, "dataMax"]} />
          <YAxis yAxisId="speed" orientation="right" hide domain={[0, "dataMax"]} />
          <Tooltip
            labelFormatter={(t) => dayjs(Number(t)).format("D MMM YYYY HH:mm")}
            formatter={(v: number, name: string) =>
              name === "speed"
                ? [`${Number(v).toFixed(1)} m/hr`, "speed"]
                : [`${Number(v).toFixed(1)} ${units}`, "flow"]
            }
          />
          {events.map((ev, i) => (
            <ReferenceArea
              key={i}
              yAxisId="flow"
              x1={ev.startMs}
              x2={ev.endMs}
              fill={FLOW_COLOUR}
              fillOpacity={0.12}
            />
          ))}
          {showFlow && (
            <Area
              yAxisId="flow"
              type="monotone"
              dataKey="flow"
              stroke={FLOW_COLOUR}
              fill="url(#lwmFlow)"
              strokeWidth={1.4}
              isAnimationActive={false}
            />
          )}
          {showSpeed && (
            <Line
              yAxisId="speed"
              type="monotone"
              dataKey="speed"
              stroke={SPEED_COLOUR}
              strokeWidth={1.2}
              dot={false}
              connectNulls={false}
              isAnimationActive={false}
            />
          )}
          <Brush
            dataKey="t"
            height={50}
            travellerWidth={12}
            gap={1}
            stroke={BRUSH_TRACK}
            fill="#f8fafc"
            startIndex={startIndex}
            endIndex={endIndex}
            tickFormatter={(t) => dayjs(Number(t)).format("D/M HH:mm")}
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            traveller={brushTraveller as any}
            onChange={(r: { startIndex?: number; endIndex?: number }) => {
              if (r.startIndex != null && r.endIndex != null) onBrush(r.startIndex, r.endIndex);
            }}
          >
            <ComposedChart>
              <YAxis yAxisId="bf" hide domain={[0, "dataMax"]} />
              <YAxis yAxisId="bs" hide domain={[0, "dataMax"]} />
              {showFlow && (
                <Line yAxisId="bf" type="monotone" dataKey="flow" stroke={FLOW_COLOUR} strokeWidth={1} dot={false} isAnimationActive={false} />
              )}
              {showSpeed && (
                <Line yAxisId="bs" type="monotone" dataKey="speed" stroke={SPEED_COLOUR} strokeWidth={1} dot={false} connectNulls={false} isAnimationActive={false} />
              )}
            </ComposedChart>
          </Brush>
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

function LateralWaterMapInner({ uiElement }: { uiElement?: { app_key?: string } }) {
  const params = useRemoteParams();
  const agentId = params.agentId;
  const appKey = uiElement?.app_key;
  const client = useDooverClient();

  const { data: depCfg, isLoading: cfgLoading } = useAgentChannel<{
    applications?: Record<string, RawConfig>;
  }>(agentId, "deployment_config");

  const raw = (appKey ? depCfg?.applications?.[appKey] : undefined) ?? {};
  const cfg = useMemo(() => toCfg(raw), [JSON.stringify(raw)]);

  const [windowDays, setWindowDays] = useState(DEFAULT_WINDOW_DAYS);
  const [brush, setBrush] = useState<{ start: number; end: number } | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [seriesShown, setSeriesShown] = useState({ flow: true, speed: false });

  const tagApps = useMemo(() => {
    if (!cfg) return [] as string[];
    const apps = [cfg.flow.app_name];
    if (cfg.endGun) apps.push(cfg.endGun.app_name);
    if (cfg.gpsMode === "two") {
      if (cfg.lat) apps.push(cfg.lat.app_name);
      if (cfg.lon) apps.push(cfg.lon.app_name);
    } else if (cfg.gpsMode === "single" && cfg.gps) {
      apps.push(cfg.gps.app_name);
    }
    return Array.from(new Set(apps));
  }, [cfg]);

  const tsQuery = useQuery({
    queryKey: ["lateral", agentId, tagApps, cfg?.gpsMode, windowDays] as const,
    enabled: !!agentId && !!cfg,
    queryFn: async () => {
      const now = dayjs();
      const after = generateSnowflakeIdAtTime(now.subtract(windowDays, "day"));
      const startBefore = generateSnowflakeIdAtTime(now.add(2, "minute"));
      const page = async (channel: string, fields?: string[]) => {
        let before = startBefore;
        const out: Array<{ value: Record<string, unknown>; message_id: string }> = [];
        let cap = false;
        for (let p = 0; p < MAX_PAGES; p++) {
          const res = await client.messages.getTimeseries(agentId!, channel, {
            before,
            after,
            ...(fields && fields.length ? { field_name: fields } : {}),
            limit: HISTORY_LIMIT,
            paginate: true,
          });
          out.push(...((res.results ?? []) as typeof out));
          if (!res.next) break;
          before = res.next;
          if (p === MAX_PAGES - 1) cap = true;
        }
        return { out, cap };
      };
      const tag = tagApps.length ? await page("tag_values", tagApps) : { out: [], cap: false };
      const loc = cfg!.gpsMode === "location" ? await page("location") : { out: [], cap: false };
      return { tagResults: tag.out, locResults: loc.out, hitCap: tag.cap || loc.cap };
    },
  });

  const samples: Sample[] = useMemo(() => {
    if (!cfg) return [];
    const flowKey = `${cfg.flow.app_name}.${cfg.flow.tag_name}`;
    const gunKey = cfg.endGun ? `${cfg.endGun.app_name}.${cfg.endGun.tag_name}` : null;
    const latKey = cfg.lat ? `${cfg.lat.app_name}.${cfg.lat.tag_name}` : null;
    const lonKey = cfg.lon ? `${cfg.lon.app_name}.${cfg.lon.tag_name}` : null;
    const gpsKey = cfg.gps ? `${cfg.gps.app_name}.${cfg.gps.tag_name}` : null;

    const rows: Array<{ t: number; flow?: number | null; lat?: number | null; lon?: number | null; endGun?: boolean | null }> = [];
    for (const p of tsQuery.data?.tagResults ?? []) {
      const v = p.value ?? {};
      const t = extractSnowflakeId(p.message_id).timestamp;
      const row: (typeof rows)[number] = { t, flow: num(v[flowKey]) };
      if (gunKey) row.endGun = truthy(v[gunKey]);
      if (cfg.gpsMode === "two" && latKey && lonKey) {
        row.lat = num(v[latKey]);
        row.lon = num(v[lonKey]);
      } else if (cfg.gpsMode === "single" && gpsKey) {
        const g = parseLatLon(v[gpsKey], cfg.latKey, cfg.lonKey);
        if (g) {
          row.lat = g.lat;
          row.lon = g.lon;
        }
      }
      rows.push(row);
    }
    if (cfg.gpsMode === "location") {
      for (const p of tsQuery.data?.locResults ?? []) {
        const g = parseLatLon(p.value, cfg.latKey, cfg.lonKey);
        rows.push({ t: extractSnowflakeId(p.message_id).timestamp, lat: g?.lat ?? null, lon: g?.lon ?? null });
      }
    }
    return buildSamples(rows);
  }, [tsQuery.data, cfg]);

  const events = useMemo(() => (cfg ? computeEvents(samples, cfg.dormancyDays) : []), [samples, cfg]);

  const chartData = useMemo<ChartPoint[]>(() => {
    const end = Date.now();
    const start = end - windowDays * 86_400_000;
    const n = CHART_BUCKETS;
    const bucketMs = (end - start) / n;
    const sum = new Float64Array(n);
    const cnt = new Int32Array(n);
    for (const s of samples) {
      const i = Math.floor((s.t - start) / bucketMs);
      if (i < 0 || i >= n) continue;
      if (s.flow != null) {
        sum[i] += s.flow;
        cnt[i] += 1;
      }
    }
    // Travel speed (m/hr) from the SAME smoothed along-path track the depth map
    // uses, so the trace always explains the map.
    //
    // Three things were making this unreadable:
    //  - a gap's speed was written to a single bucket, so a 10-minute average
    //    rendered as a one-bucket needle with nulls either side (~90% of the
    //    line was null at the 1-day window). It now spans the buckets it covers.
    //  - dt came from bucket *indices*, so it was quantised to the bucket width
    //    and the SPEED_MAX_GAP_MIN guard rejected every pair once a bucket grew
    //    past 60 min -- the trace vanished entirely at the 30-day window. Both
    //    now use real fix timestamps.
    //  - great-circle distance is unsigned, so a backward position error read as
    //    forward travel. The along-path projection is signed.
    //
    // Accumulate metres and milliseconds per bucket and divide at the end, so a
    // bucket reports the time-weighted average speed over it. A gap wider than a
    // bucket spreads across all the buckets it covers; several gaps inside one
    // bucket (long windows, where a bucket is over an hour) combine instead of
    // the last one silently overwriting the rest.
    const distM = new Float64Array(n);
    const timeMs = new Float64Array(n);
    if (cfg) {
      const track = buildTrack(samples, cfg);
      for (let k = 0; k < track.length - 1; k++) {
        const a = track[k];
        const b = track[k + 1];
        const spanMs = b.t - a.t;
        if (spanMs <= 0 || spanMs / 60_000 > SPEED_MAX_GAP_MIN) continue;
        // Speed comes from the filter's own velocity state where available.
        // Differencing the track is what forced position to be over-smoothed
        // before, which turned real stop/start into ramps.
        // Magnitude, not signed velocity: a lateral waters on the return pass
        // too, and clamping backwards travel to zero drew those passes as a flat
        // zero line -- hiding real travel and adding apparent variability.
        const vAvg = a.v != null && b.v != null ? (a.v + b.v) / 2 : null;
        const forward =
          vAvg != null ? Math.abs(vAvg) * (spanMs / 60_000) : Math.abs(b.d - a.d);
        const i0 = Math.max(0, Math.floor((a.t - start) / bucketMs));
        const i1 = Math.min(n - 1, Math.floor((b.t - start) / bucketMs));
        for (let i = i0; i <= i1; i++) {
          const lo = Math.max(a.t, start + i * bucketMs);
          const hi = Math.min(b.t, start + (i + 1) * bucketMs);
          const overlap = hi - lo;
          if (overlap <= 0) continue;
          timeMs[i] += overlap;
          distM[i] += forward * (overlap / spanMs);
        }
      }
    }
    // Flow per bucket, sample-and-hold across short gaps.
    const fillMaxMs = FLOW_FILL_MAX_GAP_MIN * 60_000;
    const flowB = new Float64Array(n);
    {
      let lastFlow = 0;
      let lastFlowT = -Infinity;
      for (let i = 0; i < n; i++) {
        const t = start + i * bucketMs;
        if (cnt[i]) {
          flowB[i] = sum[i] / cnt[i];
          lastFlow = flowB[i];
          lastFlowT = t;
        } else if (t - lastFlowT <= fillMaxMs) {
          flowB[i] = lastFlow;
        }
      }
    }

    // One speed per pass, not per bucket.
    //
    // A lateral holds a fixed percent-timer setting for a pass, and the measured
    // within-pass spread bears that out (1.0-1.2x on the passes where speed is
    // well determined). Meanwhile a single hour of a slow pass can be 80%+
    // uncertain: the cart covers ~7 m against ~4 m of GPS error, so a per-bucket
    // trace mostly renders that uncertainty as a slow ramp toward the true
    // speed. Averaging over the whole pass uses the full distance and is roughly
    // an order of magnitude better determined.
    //
    // This deliberately hides genuine mid-pass slowdowns. Those are real, but at
    // this fix density they are not separable from noise anyway -- denser
    // position data (periodic publishing) is what would make them recoverable.
    let peakFlow = 0;
    for (let i = 0; i < n; i++) if (flowB[i] > peakFlow) peakFlow = flowB[i];
    const flowOn = peakFlow * CHART_FLOW_FRACTION;

    const speed = new Float64Array(n).fill(NaN);
    for (let i = 0; i < n; i++) {
      if (!(flowB[i] > flowOn)) continue;
      let j = i;
      let dist = 0;
      let time = 0;
      while (j < n && flowB[j] > flowOn) {
        dist += distM[j];
        time += timeMs[j];
        j++;
      }
      if (time >= MIN_PASS_MINUTES * 60_000) {
        const v = dist / (time / 3_600_000); // metres per hour
        for (let k = i; k < j; k++) if (timeMs[k] > 0) speed[k] = v;
      }
      i = j;
    }
    // Tags are sample-and-hold, so a bucket with no messages means "unchanged",
    // not "zero" — carry the last value forward, but only across gaps short
    // enough to plausibly be the publish interval.
    const data: ChartPoint[] = [];
    for (let i = 0; i < n; i++) {
      data.push({
        t: Math.round(start + i * bucketMs),
        flow: flowB[i],
        speed: Number.isNaN(speed[i]) ? null : speed[i],
      });
    }
    return data;
  }, [samples, windowDays, cfg]);

  useEffect(() => {
    if (chartData.length < 2) {
      setBrush(null);
      return;
    }
    const last = events[events.length - 1];
    if (last) {
      setBrush({ start: nearestIndex(chartData, last.startMs), end: nearestIndex(chartData, last.endMs) });
    } else {
      setBrush({ start: 0, end: chartData.length - 1 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowDays, events.length]);

  const selRange = useMemo(() => {
    if (!brush || chartData.length === 0) return null;
    const a = chartData[Math.min(brush.start, chartData.length - 1)]?.t;
    const b = chartData[Math.min(brush.end, chartData.length - 1)]?.t;
    if (a == null || b == null) return null;
    return { startMs: Math.min(a, b), endMs: Math.max(a, b) };
  }, [brush, chartData]);

  const selectedSamples: Sample[] = useMemo(() => {
    if (!selRange) return [];
    return samples.filter((s) => s.t >= selRange.startMs && s.t <= selRange.endMs);
  }, [samples, selRange]);

  const result = useMemo(
    () => (cfg && selectedSamples.length > 1 ? computeStripDepths(selectedSamples, cfg) : null),
    [cfg, selectedSamples],
  );

  const metadata = useMemo(
    () =>
      cfg && selRange && result
        ? {
            generatedAt: new Date().toISOString(),
            periodStart: new Date(selRange.startMs).toISOString(),
            periodEnd: new Date(selRange.endMs).toISOString(),
            path: {
              start: { lat: cfg.pathStartLat, lon: cfg.pathStartLon },
              end: { lat: cfg.pathEndLat, lon: cfg.pathEndLon },
            },
            leftExtentM: cfg.leftExtentM,
            rightExtentM: cfg.rightExtentM,
            endGunExtraM: cfg.endGunExtraM,
            flowUnits: cfg.flowUnits,
            maxDepthMm: result.maxDepthMm,
            meanDepthMm: result.meanDepthMm,
            totalVolumeM3: result.totalVolumeM3,
          }
        : undefined,
    [cfg, selRange, result],
  );

  const geojson = useMemo(() => (result ? buildGeoJSON(result, metadata) : null), [result, metadata]);

  // --- map plumbing ---------------------------------------------------------
  const mapRef = useRef<any>(null);
  const mapsRef = useRef<any>(null);
  const infoRef = useRef<any>(null);
  const [mapReady, setMapReady] = useState(false);

  const onGoogleApiLoaded = ({ map, maps }: { map: any; maps: any }) => {
    mapRef.current = map;
    mapsRef.current = maps;
    infoRef.current = new maps.InfoWindow();
    map.data.addListener("click", (e: any) => {
      const depth = e.feature.getProperty("depthMm");
      if (depth == null) return;
      infoRef.current.setContent(`<b>${depth.toFixed(1)} mm</b> applied`);
      infoRef.current.setPosition(e.latLng);
      infoRef.current.open(map);
    });
    map.data.setStyle((feature: any) => ({
      fillColor: feature.getProperty("fill"),
      fillOpacity: 0.75,
      strokeColor: "#222",
      strokeWeight: 0.4,
    }));
    setMapReady(true);
  };

  useEffect(() => {
    const map = mapRef.current;
    const maps = mapsRef.current;
    if (!map || !maps || !cfg) return;
    map.data.forEach((f: any) => map.data.remove(f));
    if (geojson && geojson.features.length > 0) map.data.addGeoJson(geojson);
    if (result) {
      map.setCenter({ lat: result.centreLat, lng: result.centreLon });
      map.setZoom(zoomForSpan(result.centreLat, result.fitMetres));
    }
  }, [geojson, cfg, result, mapReady]);

  // --- render ---------------------------------------------------------------
  if (cfgLoading) return <div className="lwm-msg">Loading configuration…</div>;
  if (!appKey) return <div className="lwm-msg">Widget is missing its app key.</div>;
  if (!cfg)
    return (
      <div className="lwm-msg">
        Configure the lateral water map: set the flow tag, the GPS source, and the travel-path
        start/end points in this app's config.
      </div>
    );
  if (!cfg.mapsApiKey)
    return <div className="lwm-msg">Set the Google Maps API key in this app's config to render the map.</div>;

  const truncated = Boolean(tsQuery.data?.hitCap);
  const mapsAlreadyLoaded =
    typeof window !== "undefined" && Boolean((window as { google?: { maps?: unknown } }).google?.maps);

  const defCentre = {
    lat: (cfg.pathStartLat + cfg.pathEndLat) / 2,
    lng: (cfg.pathStartLon + cfg.pathEndLon) / 2,
  };
  const hasGps = selectedSamples.some((s) => s.lat != null && s.lon != null);
  const defSpan = Math.max(
    distanceM(cfg.pathStartLat, cfg.pathStartLon, cfg.pathEndLat, cfg.pathEndLon),
    cfg.leftExtentM + cfg.rightExtentM,
  );

  const stamp = selRange ? dayjs(selRange.startMs).format("YYYYMMDD-HHmm") : "export";
  const onExportGeoJSON = () => {
    if (geojson) download(`lateral-as-applied_${stamp}.geojson`, JSON.stringify(geojson, null, 2), "application/geo+json");
  };
  const onExportCSV = () => {
    if (result) download(`lateral-as-applied_${stamp}.csv`, toCSV(result), "text/csv");
  };

  const snapTo = (startMs: number, endMs: number) => {
    if (chartData.length < 2) return;
    setBrush({ start: nearestIndex(chartData, startMs), end: nearestIndex(chartData, endMs) });
  };

  return (
    <div className="lwm">
      <div className="lwm-controls">
        <div className="lwm-pills">
          {WINDOW_OPTIONS.map((d) => (
            <button
              key={d}
              className={d === windowDays ? "lwm-pill active" : "lwm-pill"}
              onClick={() => setWindowDays(d)}
            >
              {d}d
            </button>
          ))}
        </div>

        {events.length > 0 && (
          <div className="lwm-pills">
            {events.map((ev, i) => (
              <button key={i} className="lwm-pill" onClick={() => snapTo(ev.startMs, ev.endMs)}>
                Event {i + 1}
              </button>
            ))}
            {chartData.length >= 2 && (
              <button className="lwm-pill" onClick={() => setBrush({ start: 0, end: chartData.length - 1 })}>
                All
              </button>
            )}
          </div>
        )}

        <div className="lwm-spacer" />

        <div className="lwm-export">
          <button
            className="lwm-iconbtn"
            title="Download"
            aria-label="Download"
            onClick={() => setExportOpen((o) => !o)}
            disabled={!result}
          >
            <DownloadIcon />
          </button>
          {exportOpen && (
            <>
              <div className="lwm-backdrop" onClick={() => setExportOpen(false)} />
              <div className="lwm-menu" role="menu">
                <div className="lwm-menu-title">Download as</div>
                <button className="lwm-menu-item" onClick={() => { onExportGeoJSON(); setExportOpen(false); }}>
                  GeoJSON
                </button>
                <button className="lwm-menu-item" onClick={() => { onExportCSV(); setExportOpen(false); }}>
                  CSV
                </button>
              </div>
            </>
          )}
        </div>
        {tsQuery.isFetching && <span className="lwm-note">loading…</span>}
      </div>

      {chartData.length >= 2 && (
        <>
          <FlowTimeline
            data={chartData}
            events={events}
            units={cfg.flowUnits}
            startIndex={brush ? Math.min(brush.start, chartData.length - 1) : 0}
            endIndex={brush ? Math.min(brush.end, chartData.length - 1) : chartData.length - 1}
            onBrush={(s, e) => setBrush({ start: s, end: e })}
            showFlow={seriesShown.flow}
            showSpeed={seriesShown.speed}
            onToggle={(key) => setSeriesShown((s) => ({ ...s, [key]: !s[key] }))}
          />
          {selRange && <div className="lwm-selrange">Showing {fmtRange(selRange.startMs, selRange.endMs)}</div>}
        </>
      )}

      <div className="lwm-mapwrap">
        <GoogleMap
          apiKey={cfg.mapsApiKey}
          defaultCenter={defCentre}
          defaultZoom={zoomForSpan(defCentre.lat, defSpan)}
          mapMinHeight="55vh"
          loadScriptExternally={mapsAlreadyLoaded}
          status={mapsAlreadyLoaded ? "ready" : undefined}
          options={{ mapTypeId: "hybrid", tilt: 0, streetViewControl: false }}
          onGoogleApiLoaded={onGoogleApiLoaded}
        />

        {result && (
          <div className="lwm-legend">
            <div className="lwm-legend-title">Applied depth (mm)</div>
            {legendStops(result.colourMaxMm)
              .slice()
              .reverse()
              .map((s, i) => {
                const clampedTop = i === 0 && result.colourMaxMm < result.maxDepthMm;
                return (
                  <div key={i} className="lwm-legend-row">
                    <span className="lwm-swatch" style={{ background: s.colour }} />
                    {clampedTop ? `≥ ${s.depth.toFixed(1)}` : s.depth.toFixed(1)}
                  </div>
                );
              })}
          </div>
        )}
      </div>

      <div className="lwm-stats">
        {result ? (
          <>
            <span>max {result.maxDepthMm.toFixed(1)} mm</span>
            <span>mean {result.meanDepthMm.toFixed(1)} mm</span>
            <span>{(result.totalVolumeM3 / 1000).toFixed(1)} ML applied</span>
            <span>{selectedSamples.length} samples</span>
          </>
        ) : (
          <span>Select a period with flow to see the applied map.</span>
        )}
        {selectedSamples.length > 1 && !hasGps && (
          <span className="lwm-warn">no GPS positions in this period — check the GPS source config</span>
        )}
        {truncated && <span className="lwm-warn">history truncated to {HISTORY_LIMIT} points</span>}
      </div>
    </div>
  );
}

export default function LateralWaterMapWidget(props: { uiElement?: { app_key?: string } }) {
  return (
    <RemoteComponentWrapper>
      <LateralWaterMapInner {...props} />
    </RemoteComponentWrapper>
  );
}
