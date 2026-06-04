"""Lateral-move irrigator simulator.

Drives a GPS cart back and forth along a straight path so the lateral water-map
widget has something to render before a real Valley panel exists. Publishes the
same tag names the Valley lateral device app does:

    water_flow       (L/s)
    latitude         (deg)
    longitude        (deg)
    end_gun_on       (bool)
    system_pressure  (kPa)

On startup it backfills ~14 h of history (a few passes) via ``log_history`` so
the map is populated immediately, then keeps moving live.
"""

import logging
import math
import random
from datetime import datetime, timedelta, timezone

from pydoover.docker import Application, run_app
from pydoover.tags import Tag, Tags

log = logging.getLogger(__name__)

# --- path & behaviour -------------------------------------------------------
START_LAT = -27.55
START_LON = 151.95
TRAVEL_BEARING = 90.0  # east
RUN_LENGTH_M = 600.0
SPEED_M_PER_MIN = 2.0  # full pass ~5 h
NOMINAL_FLOW_L_S = 80.0
NOMINAL_PRESSURE_KPA = 250.0
END_GUN_FROM_M = 400.0
END_GUN_TO_M = 480.0

BACKFILL_HOURS = 14
BACKFILL_STEP_MIN = 2
LIVE_LOOP_PERIOD_S = 60

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


def distance_along(total_min: float) -> float:
    """Triangle wave: drive 0 -> L -> 0 -> ..."""
    travelled = total_min * SPEED_M_PER_MIN
    phase = travelled % (2 * RUN_LENGTH_M)
    return phase if phase <= RUN_LENGTH_M else (2 * RUN_LENGTH_M - phase)


def _flow() -> float:
    return round(NOMINAL_FLOW_L_S + random.uniform(-4, 4), 2)


def _pressure() -> float:
    return round(NOMINAL_PRESSURE_KPA + random.uniform(-8, 8), 1)


class SimulatorTags(Tags):
    water_flow = Tag("number", default=0)
    latitude = Tag("number", default=0)
    longitude = Tag("number", default=0)
    end_gun_on = Tag("boolean", default=False)
    system_pressure = Tag("number", default=0)


class LateralSimulator(Application):
    tags_cls = SimulatorTags

    async def setup(self):
        self.loop_target_period = LIVE_LOOP_PERIOD_S

        now = datetime.now(timezone.utc)
        start = now - timedelta(hours=BACKFILL_HOURS)
        step = timedelta(minutes=BACKFILL_STEP_MIN)
        total_min = BACKFILL_HOURS * 60

        points: list[tuple[datetime, dict]] = []
        t = start
        m = 0.0
        while t <= now:
            # minutes counted from the *start* of the backfill window
            d = distance_along(m)
            lat, lon = destination(START_LAT, START_LON, TRAVEL_BEARING, d)
            points.append(
                (
                    t,
                    {
                        "water_flow": _flow(),
                        "latitude": round(lat, 7),
                        "longitude": round(lon, 7),
                        "end_gun_on": END_GUN_FROM_M <= d <= END_GUN_TO_M,
                        "system_pressure": _pressure(),
                    },
                )
            )
            t += step
            m += BACKFILL_STEP_MIN

        written = await self.tag_manager.log_history(points)
        log.info("Backfilled %s historical lateral points", written)
        self._minutes = total_min

    async def main_loop(self):
        self._minutes += LIVE_LOOP_PERIOD_S / 60
        d = distance_along(self._minutes)
        lat, lon = destination(START_LAT, START_LON, TRAVEL_BEARING, d)
        await self.tags.water_flow.set(_flow(), log=True)
        await self.tags.latitude.set(round(lat, 7), log=True)
        await self.tags.longitude.set(round(lon, 7), log=True)
        await self.tags.end_gun_on.set(END_GUN_FROM_M <= d <= END_GUN_TO_M, log=True)
        await self.tags.system_pressure.set(_pressure(), log=True)
        log.debug("Lateral at %.0f m", d)


def main():
    """Run the lateral simulator application."""
    run_app(LateralSimulator())


if __name__ == "__main__":
    main()
