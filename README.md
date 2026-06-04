
# Lateral Irrigator

<img src="https://doover.com/wp-content/uploads/Doover-Logo-Landscape-Navy-padded-small.png" alt="App Icon" style="max-width: 300px;">

**Doover apps for monitoring and analysing lateral-move (linear) irrigators**

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)

[Overview](#-overview) • [Apps](#apps) • [As-applied map](#how-the-as-applied-map-works) • [Development](DEVELOPMENT.md)

<br/>

## 📖 Overview

A monorepo of Doover apps for lateral-move irrigators, built on
[pydoover](https://github.com/getdoover/pydoover) 1.3+. It mirrors the
`pivot-irrigator` repo, adapted for linear travel.

The first deliverable is the **As-Applied Water Map**: how much water the lateral
applied across the field, derived from recorded water-flow and cart-GPS history.
It is a *processor that hosts a remote component (widget)* — the app does no
periodic server work; the widget reads the recorded history and computes the map
client-side.

<br/>

## Apps

| App | Package | Type | What it does |
|-----|---------|------|--------------|
| **Lateral As-Applied Water Map** | `src/lateral_water_map/` | Processor (Lambda) + widget | Hosts the map widget; carries the tag mappings, GPS source, path geometry, units and maps key in its config. |
| **Valley Lateral Irrigator** | `src/valley_lateral_irrigator/` | Device app (container) | **Skeleton.** Talks to a Valley lateral panel via VCP over RS232 and publishes flow / GPS / end-gun / pressure tags. VCP transport not yet implemented. |

The widget source is in [`widget/`](widget/) (rspack + Module Federation →
`widget/assets/LateralWaterMapWidget.js`). A simulator in
[`simulators/lateral/`](simulators/lateral/) drives a GPS cart back and forth
(backfilling history via `log_history`) so the widget can be exercised before a
real panel exists. Test-data helpers live in [`scripts/`](scripts/).

<br/>

## How the as-applied map works

1. The widget reads the configured **flow**, **cart GPS** and optional
   **end-gun** history. GPS can come from two lat/lon tags, a single {lat,lon}
   tag, or the agent's `location` channel (configurable).
2. History is segmented into **irrigation events** (new event when flow resumes
   after a configurable dormant gap, default 5 days); a brushable flow/speed
   timeline lets you pick any window.
3. Each GPS sample is **projected onto the travel path** (defined by two
   endpoints). The path is binned into **strips**; for each strip it integrates
   `flow·time / (swath × strip_length)` to get the **applied depth (mm)**.
   Forward and reverse passes both accumulate; the end-gun widens the swath.
4. Each watered strip is drawn as a colour-graded **rectangle** on a Google Map.

### Configuration (Lateral As-Applied Water Map)

| Setting | Description |
|---------|-------------|
| **GPS Source** | Two tags / Single tag / Location channel |
| **Latitude/Longitude Tag** *(two-tags)* | App + tag for each coordinate |
| **GPS Tag** + **Lat/Lon Key** *(single)* | One tag holding {lat,lon} |
| **Water Flow Tag** | App + tag name carrying flow |
| **End-gun Tag** | *(optional)* boolean tag |
| **Flow Units** | `L/s` / `L/min` / `m3/h` / `US gpm` |
| **Path Start/End Lat/Lon** | The two ends of the travel path |
| **Left / Right Extent (m)** | Boom swath either side of the path |
| **End-gun Extra Extent (m)** | Added to each side when the end-gun is on |
| **Strip Resolution (m)** | Length of each map strip along travel |
| **Event Dormancy (days)** | Gap that starts a new event |
| **Google Maps API Key** | Required to render; set per-deployment (not committed) |

Regenerate `doover_config.json` after config/UI changes with
`uv run export-config-watermap` / `uv run export-ui-watermap`.

<br/>

## 📄 License

Licensed under the [Apache License 2.0](LICENSE).
