from pathlib import Path

from pydoover import config


class TagSource(config.Object):
    """A reference to a tag published by another app on this agent.

    The widget reads the named tag's *history* out of the source app's
    ``tag_values`` channel, so we only capture which app publishes it and the
    tag's name.
    """

    app_name = config.ApplicationInstall(
        "Application",
        description="App on this agent that publishes the tag.",
        name="app_name",
    )
    tag_name = config.String(
        "Tag Name",
        description="Name of the tag within that app.",
        name="tag_name",
    )


class LateralWaterMapConfig(config.Schema):
    # --- GPS source --------------------------------------------------------
    gps_source = config.Enum(
        "GPS Source",
        choices=["Two tags", "Single tag", "Location channel"],
        default="Two tags",
        description="Where the cart's position comes from: two numeric lat/lon "
        "tags, one tag holding {lat, lon}, or the agent's `location` channel.",
        name="gps_source",
    )
    # "Two tags" mode
    lat_tag = TagSource(
        "Latitude Tag",
        description="(Two tags mode) tag carrying the cart latitude.",
        name="lat_tag",
        required=False,
        default=None,
    )
    lon_tag = TagSource(
        "Longitude Tag",
        description="(Two tags mode) tag carrying the cart longitude.",
        name="lon_tag",
        required=False,
        default=None,
    )
    # "Single tag" mode
    gps_tag = TagSource(
        "GPS Tag",
        description="(Single tag mode) tag whose value holds lat & lon.",
        name="gps_tag",
        required=False,
        default=None,
    )
    gps_lat_key = config.String(
        "GPS Lat Key",
        default="lat",
        required=False,
        description="(Single tag / Location channel) key for latitude in the value.",
        name="gps_lat_key",
    )
    gps_lon_key = config.String(
        "GPS Lon Key",
        default="lon",
        required=False,
        description="(Single tag / Location channel) key for longitude in the value.",
        name="gps_lon_key",
    )

    # --- Flow / end-gun ----------------------------------------------------
    flow_tag = TagSource(
        "Water Flow Tag",
        description="Tag carrying the lateral's water flow rate.",
        name="flow_tag",
    )
    end_gun_tag = TagSource(
        "End-gun Tag",
        description="Optional boolean tag indicating the end-gun is on. Leave "
        "blank if the lateral has no end-gun.",
        name="end_gun_tag",
        required=False,
        default=None,
    )
    flow_units = config.Enum(
        "Flow Units",
        choices=["L/s", "L/min", "m3/h", "US gpm"],
        default="L/s",
        description="Units the flow tag is reported in.",
        name="flow_units",
    )

    # --- Path geometry (two endpoints) -------------------------------------
    path_start_lat = config.Number(
        "Path Start Latitude",
        description="Latitude of one end of the travel path.",
        name="path_start_lat",
    )
    path_start_lon = config.Number(
        "Path Start Longitude",
        description="Longitude of one end of the travel path.",
        name="path_start_lon",
    )
    path_end_lat = config.Number(
        "Path End Latitude",
        description="Latitude of the other end of the travel path.",
        name="path_end_lat",
    )
    path_end_lon = config.Number(
        "Path End Longitude",
        description="Longitude of the other end of the travel path.",
        name="path_end_lon",
    )

    # --- Boom swath (extents either side of the path line) ------------------
    left_extent_m = config.Number(
        "Left Extent (m)",
        default=50.0,
        required=False,
        description="Metres the boom waters to the LEFT of the travel direction.",
        name="left_extent_m",
    )
    right_extent_m = config.Number(
        "Right Extent (m)",
        default=50.0,
        required=False,
        description="Metres the boom waters to the RIGHT of the travel direction.",
        name="right_extent_m",
    )
    end_gun_extra_m = config.Number(
        "End-gun Extra Extent (m)",
        default=0.0,
        required=False,
        description="Extra metres added to each side when the end-gun is on.",
        name="end_gun_extra_m",
    )

    # --- Analysis ----------------------------------------------------------
    strip_resolution_m = config.Number(
        "Strip Resolution (m)",
        default=5.0,
        required=False,
        description="Length of each map strip along the travel path, in metres.",
        name="strip_resolution_m",
    )
    track_responsiveness = config.Number(
        "Track Responsiveness",
        default=0.001,
        required=False,
        minimum=0,
        description="How readily the travel-speed estimate follows the GPS. The "
        "GPS publishes on a distance threshold, so a small position error shows "
        "up as one fast strip beside one slow strip -- a stripe the machine "
        "never applied. A Kalman filter over the track removes that. Lower is "
        "smoother; higher follows real stop/start more closely.",
        name="track_responsiveness",
    )
    reversal_threshold_m = config.Number(
        "Direction Reversal Threshold (m)",
        default=20.0,
        required=False,
        minimum=0,
        description="How far the cart must double back before it counts as a "
        "new pass rather than GPS wobble. Each pass is smoothed on its own, so "
        "this must sit above the GPS error (fixes typically report ~4 m) and "
        "below the shortest real pass. Lower it for a short field or a machine "
        "that shuttles over short distances; too low and noise shatters the "
        "track into fragments that barely get smoothed. 0 uses the 20 m default.",
        name="reversal_threshold_m",
    )
    dormancy_days = config.Number(
        "Event Dormancy (days)",
        default=5.0,
        required=False,
        description="A new irrigation event starts when flow resumes after at "
        "least this many days without flow.",
        name="dormancy_days",
    )

    # --- Rendering ---------------------------------------------------------
    google_maps_api_key = config.String(
        "Google Maps API Key",
        default=None,
        required=False,
        description="Google Maps JavaScript API key used to render the map. "
        "Set this per-deployment — it is intentionally not committed to the repo.",
        name="google_maps_api_key",
    )

    position = config.ApplicationPosition(default=150)


def export():
    LateralWaterMapConfig.export(
        Path(__file__).parents[2] / "doover_config.json",
        "lateral_water_map",
    )
