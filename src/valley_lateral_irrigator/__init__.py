from pydoover.docker import run_app

from .application import ValleyLateralIrrigatorApplication


def main():
    """Run the Valley lateral irrigator device application."""
    run_app(ValleyLateralIrrigatorApplication())
