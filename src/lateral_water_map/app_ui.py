from pathlib import Path

from pydoover import ui


class LateralWaterMapUI(ui.UI, default_open=True):
    widget = ui.RemoteComponent(
        name="LateralWaterMap",
        display_name="As-Applied Water Map",
        component_url="$config.app().dv_widget_url",
        scope="LateralWaterMapWidget",
        module="./LateralWaterMapWidget",
        app_key="$config.app().APP_KEY",
    )


def export():
    LateralWaterMapUI(None, None, None).export(
        Path(__file__).parents[2] / "doover_config.json", "lateral_water_map"
    )
