---
status: accepted
relates-to: ADR-0020, ADR-0030
supersedes-in-part: ADR-0017, ADR-0018, ADR-0030
---

# Remove the compatibility singleton

## Context

ADR-0020 introduced the manifest-defined fleet and kept the original singleton
(one unit, the canonical checkout as working directory, no manifest) as a
compatibility mode. Production now runs only fleet instances, and no
`pi-telegram-bridge.service` unit exists on the server. The singleton kept a
second shape for configuration, host startup, resource discovery, job handoff
(`local` target), restart markers, service units, deployment, and recovery. It
also used three different default instance names across extensions and CLIs.

## Decision

Run the bridge only as a fleet. Configuration always loads the private manifest
and requires `PI_TELEGRAM_BRIDGE_INSTANCE_ID`. The host always resolves
resources through the instance's capability profile and publishes its instance
context to extensions. Deployment refuses to run without the manifest.

Remove the singleton config loader, service unit, installer path, directory
discovery, `local` job-handoff target, empty restart markers, the singleton
deployment and recovery branches, and the one-time singleton-to-fleet state
migration tool.

Keep the safeguards that protect a fleet from singleton leftovers: recovery
still discovers and disables any `pi-telegram-bridge*.service` unit, and still
refuses stray singleton job state at the state root. Jobs file-format
compatibility (versions 1 and 2) is a separate concern and is unchanged.

## Consequences

- Every runtime path has one configuration shape, and extensions no longer need
  fallback instance names.
- Local development runs the host through a manifest, like production.
- Migrating an old singleton state tree now requires an earlier release.
- ADR-0017's singleton session-root fallback, ADR-0018's
  `~/.config/pi-telegram-bridge/environment` file (now
  `<configRoot>/instances/<id>.env`), and ADR-0030's singleton recipient
  protocol no longer apply.
