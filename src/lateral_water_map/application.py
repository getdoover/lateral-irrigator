import logging

from pydoover.processor import Application
from pydoover.models import DeploymentEvent

from .app_config import LateralWaterMapConfig
from .app_ui import LateralWaterMapUI

log = logging.getLogger(__name__)


class LateralWaterMapApp(Application):
    """Host for the lateral-move "as-applied water map" widget.

    This processor does **no** server-side work. The entire as-applied map —
    irrigation-event segmentation, projecting the cart's GPS onto the travel
    path, the per-strip applied-depth maths and the GeoJSON rendering — is
    computed client side in the ``LateralWaterMapWidget`` remote component,
    which reads the configured flow / GPS / end-gun history straight out of the
    source app's ``tag_values`` (or the agent's ``location``) channel.

    The processor exists only to carry the configuration through to the widget
    and to host that widget via the static UI schema.
    """

    config_cls = LateralWaterMapConfig
    ui_cls = LateralWaterMapUI

    async def on_deployment(self, event: DeploymentEvent):
        log.info("Lateral Water Map deployed for agent %s", self.agent_id)
