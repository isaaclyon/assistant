---
name: manage-hue
description: "Controls Philips Hue lights, rooms, and scenes through the locally installed OpenHue CLI. Use for requests about household lights, Hue rooms, brightness, colors, color temperature, scenes, or light status."
compatibility: "Requires the OpenHue CLI (`openhue`) and a paired Hue Bridge reachable from the assistant host's local network."
---

# Manage Philips Hue

Use the community-maintained [OpenHue CLI](https://github.com/openhue/openhue-cli)
as the thin local adapter to the Philips Hue Bridge. Keep all control traffic on
the private home network; never expose the Bridge or its credentials to the
public internet.

## Before using it

Check that the executable is installed without reading or printing its private
configuration:

```bash
command -v openhue
openhue --version
```

If it is missing, say that Hue is not configured yet and give the user the
setup steps below. Do not silently install software during a light-control
request.

The OpenHue configuration and Hue application key live under `~/.openhue`.
Treat that directory as private: never print it, copy it, or include its
contents in a response.

## First-time setup

Setup must be performed while the assistant host can reach the Bridge and the
user can press the Bridge's physical link button. Prefer the documented
OpenHue installation method for the host OS. With Homebrew:

```bash
brew tap openhue/cli
brew install openhue-cli
```

Then, at home, pair and inspect the installation:

```bash
openhue setup
openhue get room --json
openhue get light --json
openhue get scene --json
```

`openhue setup` discovers the Bridge, waits for the link button, and stores the
local configuration. If discovery fails, find the Bridge address through the
Hue app/router or `openhue discover`, then rerun setup with the documented
`--bridge` option. Never ask the user to paste the Hue application key into
Telegram.

After pairing, use the returned room, light, and scene names as the source of
truth. Do not invent aliases or assume a room exists. Friendly aliases may be
used only after the user explicitly establishes them.

## Read-only operations

Use JSON output for machine-readable results and summarize the relevant state;
do not dump the complete payload:

```bash
openhue get room --json
openhue get light --json
openhue get light --room "Living Room" --json
openhue get scene --json
openhue get scene --room "Living Room" --json
```

Resolve names from the current listing before a write. If a name matches more
than one light, require a room or ask which light the user means. If the Bridge
is unreachable, report that plainly and do not claim the state or action was
successful.

## Supported controls

Use the narrowest target the user named. OpenHue accepts a room or light name
or ID, and supports these operations:

```bash
# Room controls
openhue set room "Living Room" --on
openhue set room "Living Room" --off
openhue set room "Living Room" --on --brightness 40
openhue set room "Living Room" --on --color orange
openhue set room "Living Room" --on --rgb '#FF8800'
openhue set room "Living Room" --on --temperature 350

# Light controls
openhue set light "Desk Lamp" --on
openhue set light "Desk Lamp" --off
openhue set light "Desk Lamp" --on --brightness 60
openhue set light "Desk Lamp" --on --color blue
openhue set light "Desk Lamp" --on --rgb '#3399FF'
openhue set light "Desk Lamp" --on --temperature 350

# Scenes
openhue set scene "Relax"
openhue set scene "Relax" --action dynamic
```

Brightness is 0–100. Hue color temperature uses Mirek values (153–500), where
larger values are warmer. Use a named color or RGB when the user asks for a
plain color; use a temperature only when they ask for warmer/cooler or a
specific color temperature.

## Safety and confirmation

- Read-only status requests may run immediately.
- Clear requests targeting one named room, light, or scene may run immediately.
- Resolve ambiguity before writing; never guess among similarly named targets.
- For “everything,” “all lights,” or a whole-home shutdown, list the scope and
  ask for confirmation before executing unless the user has explicitly defined
  that exact routine as trusted.
- Do not create schedules, routines, or aliases unless the user asks for them.
- After a write, verify the CLI succeeded and report a concise result. On
  failure, report the actionable error without exposing credentials or raw
  configuration.

## Remote availability

Telegram is only the conversational interface. The command runs on the
assistant host, so Hue control works only when that host has a private-network
path to the Bridge (for example, while at home or through an existing trusted
VPN). Do not suggest port-forwarding the Bridge.
