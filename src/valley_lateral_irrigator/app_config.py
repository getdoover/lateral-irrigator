from pathlib import Path

from pydoover import config


class ValleyLateralIrrigatorConfig(config.Schema):
    serial_port = config.String(
        "Serial Port",
        default="/dev/ttyS0",
        required=False,
        description="RS232 serial device the Valley panel is wired to.",
        name="serial_port",
    )
    baud_rate = config.Integer(
        "Baud Rate",
        default=9600,
        required=False,
        description="RS232 baud rate for the VCP link.",
        name="baud_rate",
    )
    poll_interval_s = config.Number(
        "Poll Interval (s)",
        default=10.0,
        required=False,
        description="How often to poll the panel over VCP.",
        name="poll_interval_s",
    )

    position = config.ApplicationPosition(default=100)


def export():
    ValleyLateralIrrigatorConfig.export(
        Path(__file__).parents[2] / "doover_config.json",
        "valley_lateral_irrigator",
    )
