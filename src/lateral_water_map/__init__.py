from typing import Any

from pydoover.processor import run_app

from .application import LateralWaterMapApp
from .app_config import LateralWaterMapConfig


def handler(event: dict[str, Any], context):
    """Lambda handler entry point."""
    LateralWaterMapConfig.clear_elements()
    return run_app(
        LateralWaterMapApp(),
        event,
        context,
    )
