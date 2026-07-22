#!/usr/bin/env python
"""Seed an agent with simulated lateral-move data for testing the As-Applied
Water Map widget, mirroring the real deployed setup:

- **Flow** (m3/h) and **raw signal** (mA) are written to ``tag_values`` under
  the flow-meter app key, scaled like the Arad Octave DN150 (4-20 mA,
  20 mA = full scale).
- **GPS** is written to the agent's ``location`` channel exactly as the
  location-manager app publishes it: ``{lat, long, alt, accuracy}`` messages,
  emitted only after the cart has moved at least the distance threshold and no
  more often than the update interval.
- History is seeded as several **irrigation events** spread over the last N
  days, alternating pass direction, with the final pass stopping at the
  cart's real parked position.

Uses the pydoover cloud DataClient with your existing `doover login`.

SAFE BY DEFAULT: prints a plan and does nothing. Add --yes to actually publish.

Examples
--------
    uv run python scripts/seed_lateral_data.py --agent <id> --org <id>
    uv run python scripts/seed_lateral_data.py --agent <id> --org <id> --yes
"""

from __future__ import annotations

import argparse
import math
import random
import sys
from datetime import datetime, timedelta, timezone

DEFAULT_APP_KEY = "analog_flow_meter_1"
DEFAULT_PROFILE = "default"
EARTH_RADIUS_M = 6378137.0

# Deployed lateral travel path (trolley track) and parked position.
DEFAULT_START = (-27.57185286175327, 152.35760921445012)
DEFAULT_END = (-27.57614993439552, 152.36358754384838)
DEFAULT_PARK_M = 584.0  # along-path metres of the real parked trolley


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


def bearing_to(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def distance_to(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(min(1, math.sqrt(a)))


def build_events(args, path_len: float) -> list[dict]:
    """Evenly spaced events over the last --days, alternating direction.

    The final event stops at --park-at-m so the seeded history ends where the
    lateral is really parked.
    """
    now = datetime.now(timezone.utc)
    spacing = timedelta(days=args.days / args.events)
    events = []
    for i in range(args.events):
        forward = i % 2 == 0
        d0 = 0.0 if forward else path_len
        d1 = path_len if forward else 0.0
        if i == args.events - 1 and args.park_at_m is not None:
            d1 = min(max(args.park_at_m, 0.0), path_len)
        run = abs(d1 - d0)
        events.append(
            {
                "start": now - timedelta(days=args.days) + i * spacing,
                "d0": d0,
                "d1": d1,
                "duration": timedelta(minutes=run / args.speed),
                "direction": "start->end" if d1 >= d0 else "end->start",
            }
        )
    return events


def build_messages(args) -> tuple[list, list, list[dict]]:
    """Returns (tag_msgs, loc_msgs, events); each msg is (timestamp, payload)."""
    rng = random.Random(42)
    path_len = distance_to(args.start_lat, args.start_lon, args.end_lat, args.end_lon)
    bearing = bearing_to(args.start_lat, args.start_lon, args.end_lat, args.end_lon)
    events = build_events(args, path_len)

    step = timedelta(minutes=args.step_min)
    tag_msgs: list[tuple[datetime, dict]] = []
    loc_msgs: list[tuple[datetime, dict]] = []

    def loc_payload(d: float) -> dict:
        lat, lon = destination(args.start_lat, args.start_lon, bearing, d)
        # ~1 m of GPS jitter so the trace looks like a real fix
        lat += rng.uniform(-1.0, 1.0) / 111_320.0
        lon += rng.uniform(-1.0, 1.0) / (111_320.0 * math.cos(math.radians(lat)))
        return {
            "lat": round(lat, 7),
            "long": round(lon, 7),
            "alt": round(args.alt + rng.uniform(-1.0, 1.0), 1),
            "accuracy": round(rng.uniform(2.0, 6.0), 1),
        }

    for ev in events:
        sign = 1.0 if ev["d1"] >= ev["d0"] else -1.0
        run = abs(ev["d1"] - ev["d0"])

        # Flow tags on their own sampling clock.
        t = ev["start"]
        minutes = 0.0
        while True:
            travelled = min(minutes * args.speed, run)
            flow = max(0.0, args.flow + 0.06 * args.flow * math.sin(travelled / 40.0))
            tags: dict[str, object] = {args.flow_tag: round(flow, 1)}
            if args.raw_signal_tag:
                tags[args.raw_signal_tag] = round(4.0 + 16.0 * flow / args.full_scale, 3)
            tag_msgs.append((t, {args.app_key: tags}))
            if travelled >= run:
                break
            t += step
            minutes += args.step_min

        # Location on its own clock, as location-manager runs: evaluate every
        # --loc-min-secs, publish only after >= --loc-min-move of movement.
        # Offset a few seconds from the flow clock so timestamps never collide.
        t_loc = ev["start"] + timedelta(seconds=7)
        end_t = ev["start"] + ev["duration"]
        last_loc_d: float | None = None
        while t_loc <= end_t:
            mins = (t_loc - ev["start"]).total_seconds() / 60.0
            d = ev["d0"] + sign * min(mins * args.speed, run)
            if last_loc_d is None or abs(d - last_loc_d) >= args.loc_min_move:
                loc_msgs.append((t_loc, loc_payload(d)))
                last_loc_d = d
            t_loc += timedelta(seconds=args.loc_min_secs)
        # final fix exactly at the stopping point
        loc_msgs.append((end_t + timedelta(seconds=7), loc_payload(ev["d1"])))

        # a couple of zero-flow samples to close the event crisply
        for j in (1, 2):
            tags = {args.flow_tag: 0.0}
            if args.raw_signal_tag:
                tags[args.raw_signal_tag] = 4.0
            tag_msgs.append((t + j * step, {args.app_key: tags}))

    return tag_msgs, loc_msgs, events


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--agent", required=True, help="target agent id")
    p.add_argument("--app-key", default=DEFAULT_APP_KEY, help="app key the flow tags live under")
    p.add_argument("--profile", default=DEFAULT_PROFILE, help="doover auth profile (~/.doover)")
    p.add_argument("--org", type=int, default=None, help="organisation id (if the profile needs it)")
    p.add_argument("--flow-tag", default="flow")
    p.add_argument("--raw-signal-tag", default="raw_signal", help="mA signal tag (blank to skip)")
    # path geometry (defaults match the deployed travel path)
    p.add_argument("--start-lat", type=float, default=DEFAULT_START[0])
    p.add_argument("--start-lon", type=float, default=DEFAULT_START[1])
    p.add_argument("--end-lat", type=float, default=DEFAULT_END[0])
    p.add_argument("--end-lon", type=float, default=DEFAULT_END[1])
    p.add_argument("--park-at-m", type=float, default=DEFAULT_PARK_M,
                   help="final event stops at this along-path distance (real parked spot)")
    # events
    p.add_argument("--days", type=float, default=30.0, help="window to spread events over")
    p.add_argument("--events", type=int, default=4, help="number of irrigation runs")
    p.add_argument("--speed", type=float, default=2.0, help="travel speed, m/min")
    p.add_argument("--flow", type=float, default=200.0, help="nominal flow, m3/h")
    p.add_argument("--full-scale", type=float, default=250.0, help="flow at 20 mA, m3/h")
    p.add_argument("--step-min", type=float, default=2.0, help="minutes between flow samples")
    # location-manager mimicry (defaults match the installed config)
    p.add_argument("--loc-min-move", type=float, default=0.5, help="metres moved before a location publish")
    p.add_argument("--loc-min-secs", type=float, default=15.0, help="min seconds between location publishes")
    p.add_argument("--alt", type=float, default=90.0, help="nominal altitude, m")
    p.add_argument("--yes", action="store_true", help="actually publish (otherwise dry run)")
    args = p.parse_args()

    tag_msgs, loc_msgs, events = build_messages(args)
    path_len = distance_to(args.start_lat, args.start_lon, args.end_lat, args.end_lon)
    bearing = bearing_to(args.start_lat, args.start_lon, args.end_lat, args.end_lon)

    print("Lateral data seeder")
    print(f"  agent    : {args.agent}")
    print(f"  path     : {path_len:.0f} m @ bearing {bearing:.0f} deg")
    print(f"  events   : {args.events} over last {args.days:.0f} days")
    for i, ev in enumerate(events, 1):
        end = ev["start"] + ev["duration"]
        print(f"    {i}: {ev['start']:%Y-%m-%d %H:%M} -> {end:%Y-%m-%d %H:%M} UTC  "
              f"{ev['direction']}  ({abs(ev['d1'] - ev['d0']):.0f} m)")
    print(f"  tag_values ({args.app_key}): {len(tag_msgs)} messages  e.g. {tag_msgs[len(tag_msgs) // 2][1]}")
    print(f"  location: {len(loc_msgs)} messages  e.g. {loc_msgs[len(loc_msgs) // 2][1]}")

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

    for channel, msgs in (("tag_values", tag_msgs), ("location", loc_msgs)):
        print(f"\nPublishing {len(msgs)} messages to {channel}…")
        for i, (ts, data) in enumerate(msgs, 1):
            client.create_message(agent_id, channel, data, timestamp=ts)
            if i % 50 == 0 or i == len(msgs):
                print(f"  {i}/{len(msgs)}")
    print("Done. Open the agent in customer-site and view the As-Applied Water Map.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
