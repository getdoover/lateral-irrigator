from pydoover.tags import Tag, Tags


class ValleyLateralIrrigatorTags(Tags):
    """Live values published from the Valley lateral panel.

    These are the tags the lateral water-map widget reads (by app + tag name)
    to build the as-applied map, so keep the names stable. Position is the
    cart's GPS, published as two numeric tags (the widget's default "Two tags"
    GPS source mode).
    """

    water_flow = Tag("number", default=0)
    latitude = Tag("number", default=0)
    longitude = Tag("number", default=0)
    end_gun_on = Tag("boolean", default=False)
    system_pressure = Tag("number", default=0)
