#!/usr/bin/env python
"""Seed an agent's `tag_values` channel with simulated lateral-move data for
testing the As-Applied Water Map widget.

Drives a GPS cart back and forth along a straight path and writes back-dated
history (one logged message per step, dated in the past) so the widget renders a
full event immediately. Uses the pydoover cloud DataClient with your existing
`doover login` (a named profile from ~/.doover).

SAFE BY DEFAULT: prints a plan and does nothing. Add --yes to actually publish.

Examples
--------
    uv run python scripts/seed_lateral_data.py --agent <id> --org <id>
    uv run python scripts/seed_lateral_data.py --agent <id> --org <id> --yes
"""

from __future__ import annotations

import argparse
import math
import sys
from datetime import datetime, timedelta, timezone

DEFAULT_APP_KEY = "lateral_sim"
DEFAULT_PROFILE = "default"
EARTH_RADIUS_M = 6378137.0


def destination(lat: float, lon: float, bearing_deg: float, dist_m: float) -> tuple[float, float]:
    d = dist_m / EARTH_RADIUS_M
    th = math.radians(bearing_deg)
    p1 = math.radians(lat)
    l1 = math.radians(lon)
    p2 = math.asin(math.sin(p1) * math.cos(d) + math.cos(p1) * math.sin(d) * math.cos(th))
    l2 = l1 + math.atan2(
        math.sin(th) * math.sin(d) * math.cos(p1),
        math.cos(d) - math.sin(p1) * math.sin(p2),
    )
    return math.degrees(p2), math.degrees(l2)


def build_points(args) -> list[tuple[datetime, dict]]:
    now = datetime.now(timezone.utc)
    start = now - timedelta(hours=args.hours)
    step = timedelta(minutes=args.step_min)

    points: list[tuple[datetime, dict]] = []
    t = start
    minutes = 0.0
    while t <= now:
        travelled = minutes * args.speed
        phase = travelled % (2 * args.run_m)
        d = phase if phase <= args.run_m else (2 * args.run_m - phase)
        lat, lon = destination(args.start_lat, args.start_lon, args.bearing, d)
        flow = max(0.0, args.flow + 0.08 * args.flow * math.sin(travelled / 40.0))
        tags: dict[str, object] = {
            args.flow_tag: round(flow, 2),
            args.lat_tag: round(lat, 7),
            args.lon_tag: round(lon, 7),
        }
        if args.end_gun_tag:
            tags[args.end_gun_tag] = bool(args.end_gun_from <= d <= args.end_gun_to)
        points.append((t, {args.app_key: tags}))
        t += step
        minutes += args.step_min
    return points


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--agent", required=True, help="target agent id")
    p.add_argument("--app-key", default=DEFAULT_APP_KEY, help="source app key the tags live under")
    p.add_argument("--profile", default=DEFAULT_PROFILE, help="doover auth profile (~/.doover)")
    p.add_argument("--org", type=int, default=None, help="organisation id (if the profile needs it)")
    p.add_argument("--channel", default="tag_values")
    p.add_argument("--flow-tag", default="water_flow")
    p.add_argument("--lat-tag", default="latitude")
    p.add_argument("--lon-tag", default="longitude")
    p.add_argument("--end-gun-tag", default="end_gun_on", help="boolean end-gun tag name (blank to skip)")
    # path geometry (defaults match the simulator + sample config)
    p.add_argument("--start-lat", type=float, default=-27.55)
    p.add_argument("--start-lon", type=float, default=151.95)
    p.add_argument("--bearing", type=float, default=90.0, help="travel bearing, deg from N")
    p.add_argument("--run-m", type=float, default=600.0, help="path length in metres")
    p.add_argument("--speed", type=float, default=2.0, help="travel speed, m/min")
    p.add_argument("--flow", type=float, default=80.0, help="nominal flow (in configured units)")
    p.add_argument("--end-gun-from", type=float, default=400.0)
    p.add_argument("--end-gun-to", type=float, default=480.0)
    p.add_argument("--hours", type=float, default=14.0, help="how far back to backfill")
    p.add_argument("--step-min", type=float, default=2.0, help="minutes between samples")
    p.add_argument("--yes", action="store_true", help="actually publish (otherwise dry run)")
    args = p.parse_args()

    points = build_points(args)
    span_h = (points[-1][0] - points[0][0]).total_seconds() / 3600 if points else 0
    sample = points[len(points) // 2][1] if points else {}

    print("Lateral data seeder")
    print(f"  agent    : {args.agent}")
    print(f"  app key  : {args.app_key}")
    print(f"  tags     : {args.flow_tag}, {args.lat_tag}, {args.lon_tag}"
          + (f", {args.end_gun_tag}" if args.end_gun_tag else ""))
    print(f"  path     : {args.run_m:.0f} m @ bearing {args.bearing:.0f}° from {args.start_lat},{args.start_lon}")
    print(f"  points   : {len(points)} over {span_h:.1f} h (every {args.step_min} min)")
    print(f"  sample   : {sample}")

    if not args.yes:
        print("\nDRY RUN — nothing published. Re-run with --yes to publish.")
        return 0

    try:
        from pydoover.api import DataClient
    except Exception as e:  # pragma: no cover
        print(f"Failed to import pydoover.api: {e}", file=sys.stderr)
        return 1

    client = DataClient(profile=args.profile, organisation_id=args.org) if args.org else DataClient(profile=args.profile)
    agent_id = int(args.agent)

    print(f"\nPublishing {len(points)} messages…")
    for i, (ts, data) in enumerate(points, 1):
        client.create_message(agent_id, args.channel, data, timestamp=ts)
        if i % 25 == 0 or i == len(points):
            print(f"  {i}/{len(points)}")
    print("Done. Open the agent in customer-site and view the As-Applied Water Map.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
