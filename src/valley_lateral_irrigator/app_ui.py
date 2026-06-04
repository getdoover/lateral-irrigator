from pathlib import Path

from pydoover import ui

from .app_tags import ValleyLateralIrrigatorTags


class ValleyLateralIrrigatorUI(ui.UI):
    # log_threshold ensures these are written to tag history as they change, so
    # the lateral water-map widget has a time series to build the map from.
    water_flow = ui.NumericVariable(
        "Water Flow",
        value=ValleyLateralIrrigatorTags.water_flow,
        name="water_flow",
        precision=1,
        log_threshold=0.5,
    )
    latitude = ui.NumericVariable(
        "Latitude",
        value=ValleyLateralIrrigatorTags.latitude,
        name="latitude",
        precision=6,
        log_threshold=0.00001,
    )
    longitude = ui.NumericVariable(
        "Longitude",
        value=ValleyLateralIrrigatorTags.longitude,
        name="longitude",
        precision=6,
        log_threshold=0.00001,
    )
    system_pressure = ui.NumericVariable(
        "System Pressure",
        value=ValleyLateralIrrigatorTags.system_pressure,
        name="system_pressure",
        precision=1,
        log_threshold=1.0,
    )
    end_gun_on = ui.BooleanVariable(
        "End-gun On",
        value=ValleyLateralIrrigatorTags.end_gun_on,
        name="end_gun_on",
    )


def export():
    ValleyLateralIrrigatorUI(None, None, None).export(
        Path(__file__).parents[2] / "doover_config.json",
        "valley_lateral_irrigator",
    )
