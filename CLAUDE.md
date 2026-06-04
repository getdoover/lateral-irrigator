# Lateral Irrigator

A monorepo of Doover apps for lateral-move (linear) irrigators, built on
pydoover 1.3+. It mirrors `~/doover-apps/pivot-irrigator`, adapted for linear
travel (GPS cart along a path → rectangular strips, not a rotating pivot). See
`README.md` for the product overview.

## Apps in this repo

- **`src/lateral_water_map/`** — a *processor* (Lambda) that hosts the as-applied
  water-map **widget** (`widget/`). No server-side work; all map computation is
  client-side. Subclasses `pydoover.processor.Application`.
- **`src/valley_lateral_irrigator/`** — a *device app* skeleton (VCP/RS232 TODO)
  that publishes flow / GPS lat+lon / end-gun / pressure tags.
- **`simulators/lateral/`** — drives a GPS cart back and forth, backfills via
  `log_history`.
- **`scripts/`** — `seed_lateral_data.py` / `clear_lateral_data.py` for pushing /
  wiping back-dated test data on an agent (pass `--agent`/`--org`).

## Commands

```bash
uv run pytest tests -v             # Run tests
uv run export-config-watermap      # Write lateral_water_map config_schema
uv run export-ui-watermap          # Write lateral_water_map ui_schema (hosts the widget)
uv run export-config-valley        # Write valley_lateral_irrigator config_schema
uv run export-ui-valley            # Write valley_lateral_irrigator ui_schema
npm --prefix widget run build      # Build the widget bundle (needs the doover-js tarball)
npm --prefix widget test           # Widget computation unit tests
doover app run                     # Run simulator + valley device app via docker-compose
```

## Project Structure

```
src/lateral_water_map/   # Processor / UI host for the map widget
src/valley_lateral_irrigator/  # Device app skeleton (VCP/RS232 — TODO)
widget/                  # RemoteComponent (rspack + Module Federation, Google Maps)
  src/LateralWaterMapWidget.tsx  # React widget
  src/lib/lateral.ts             # Pure computation: events, GPS→path projection, strip depth, GeoJSON
simulators/lateral/      # Simulator producing test GPS+flow data
scripts/                 # seed/clear test-data helpers
tests/                   # pytest suite
```

## pydoover Patterns

The device app + simulator use the pydoover declarative API. Key patterns:

### Application class (application.py)
- Set `config_cls`, `tags_cls`, `ui_cls` as class attributes — framework wires them up automatically
- Override `async def setup()` for init and `async def main_loop()` for the periodic loop
- Use `@ui.handler("element_name")` for UI interaction callbacks (signature: `self, ctx, value`)
- Access config via `self.config.<field>.value`, tags via `self.tags.<name>.set(val)` / `.get()`
- Cross-app tags: `self.get_tag("tag_name", app_key)`
- Messaging: `await self.create_message(channel, {data})`

### Config (app_config.py)
- Subclass `config.Schema` with class-level `config.Boolean`, `config.String`, `config.Application`, etc.
- `export()` is a classmethod: `SampleConfig.export(path, name)`

### Tags (app_tags.py)
- Subclass `Tags` with class-level `Tag("type", default=...)` declarations
- Types: "boolean", "number", "integer", "string", "array", "object"

### UI (app_ui.py)
- Subclass `ui.UI` with class-level element declarations
- Bind variables to tags: `ui.NumericVariable("Label", value=MyTags.field, name="id")`
- Element types: `BooleanVariable`, `NumericVariable`, `TextVariable`, `Button`, `TextInput`, `FloatInput`, `Select`, `Submodule`
- Use explicit `name=` kwarg on interactive elements to match handler names

### State Machine (app_state.py)
- Uses `pydoover.state.StateMachine` (wraps the `transitions` library)
- Define `states` and `transitions` as class attributes, `on_enter_<state>()` callbacks

## Doover Skills

If you have the doover-skills plugin installed, use `/doover` to see all available skills.
Key skills: `/doover-device-apps` for device app development, `/pydoover` for API reference.
