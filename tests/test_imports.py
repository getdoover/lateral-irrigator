"""Smoke tests for the lateral-irrigator apps."""

import json

from pydoover.config import Schema
from pydoover.tags import Tags
from pydoover.ui import UI


# --- lateral_water_map (processor / UI host) -------------------------------


def test_import_watermap_app():
    from lateral_water_map.application import LateralWaterMapApp

    assert LateralWaterMapApp.config_cls is not None
    assert LateralWaterMapApp.ui_cls is not None


def test_watermap_handler_exists():
    from lateral_water_map import handler

    assert callable(handler)


def test_watermap_config_schema():
    from lateral_water_map.app_config import LateralWaterMapConfig

    assert issubclass(LateralWaterMapConfig, Schema)
    schema = LateralWaterMapConfig.to_schema()
    props = schema["properties"]
    assert "flow_tag" in props and "app_name" in props["flow_tag"]["properties"]
    assert "gps_source" in props
    for key in ("path_start_lat", "path_start_lon", "path_end_lat", "path_end_lon"):
        assert key in schema["required"]


def test_watermap_ui_is_remote_component():
    from lateral_water_map.app_ui import LateralWaterMapUI

    assert issubclass(LateralWaterMapUI, UI)


def test_watermap_exports(tmp_path):
    from lateral_water_map.app_config import LateralWaterMapConfig
    from lateral_water_map.app_ui import LateralWaterMapUI

    fp = tmp_path / "doover_config.json"
    LateralWaterMapConfig.export(fp, "lateral_water_map")
    LateralWaterMapUI(None, None, None).export(fp, "lateral_water_map")

    data = json.loads(fp.read_text())
    entry = data["lateral_water_map"]
    assert "properties" in entry["config_schema"]
    assert entry["ui_schema"]["type"] == "uiApplication"
    assert "LateralWaterMap" in entry["ui_schema"]["children"]


# --- valley_lateral_irrigator (device skeleton) ----------------------------


def test_import_valley_app():
    from valley_lateral_irrigator.application import ValleyLateralIrrigatorApplication

    assert ValleyLateralIrrigatorApplication.config_cls is not None
    assert ValleyLateralIrrigatorApplication.tags_cls is not None
    assert ValleyLateralIrrigatorApplication.ui_cls is not None


def test_valley_tags():
    from valley_lateral_irrigator.app_tags import ValleyLateralIrrigatorTags

    assert issubclass(ValleyLateralIrrigatorTags, Tags)
    for name in ("water_flow", "latitude", "longitude", "end_gun_on", "system_pressure"):
        assert hasattr(ValleyLateralIrrigatorTags, name)


def test_valley_exports(tmp_path):
    from valley_lateral_irrigator.app_config import ValleyLateralIrrigatorConfig
    from valley_lateral_irrigator.app_ui import ValleyLateralIrrigatorUI

    fp = tmp_path / "doover_config.json"
    ValleyLateralIrrigatorConfig.export(fp, "valley_lateral_irrigator")
    ValleyLateralIrrigatorUI(None, None, None).export(fp, "valley_lateral_irrigator")

    data = json.loads(fp.read_text())
    entry = data["valley_lateral_irrigator"]
    assert "properties" in entry["config_schema"]
    assert entry["ui_schema"]["type"] == "uiApplication"
