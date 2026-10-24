---
status: accepted
relates-to: ADR-0019, ADR-0051, ADR-0055
---

# Read-only Linux health monitoring without widening personal-network access

A personal runtime's network isolation is intentional. Monitoring a private Linux
host must not grant that runtime SSH credentials, administrative network access,
a Docker socket, or repair authority. Frequent deterministic health checks should
not consume a provider turn when nothing changes.

## Decision

Provide two reusable standalone operator utilities, installed from reviewed source:

- `scripts/linux-host-monitor.py`: bounded read-only collection, strict telemetry
  validation, sustained-condition evaluation and an atomic sanitized report.
- `scripts/host-health-publish.mjs`: a separately sandboxed engineering-identity
  process using its existing, digest-pinned delegated scheduling configuration.
  Only new transitions, report loss/staleness, and recovery create one-time prompt
  definitions. No healthy observation wakes a model.

A dedicated non-login collector identity holds only a pinned SSH key. The remote
key has a forced, root-owned, argument-free read-only collector command, no shell,
forwarding or PTY, and optionally an approved source-address restriction. Narrow
sudo permission permits only that wrapper, not Python, Docker or a general shell.
Privileged collection emits no environments, application configs, log bodies,
credentials or arbitrary command output. The caller uses no SSH agent or ambient
configuration and enforces a fixed host key, output limit and deadline.

The report is readable, not writable, by the personal runtime and publisher. The
collector cannot read scheduling credentials or personal data. The publisher can
reach only filesystem Unix sockets, reads the existing engineering grant, and has
no SSH or personal/provider credentials. It does not own another coordinator or
write another runtime's scheduler files. Private root-owned configuration supplies
all actual hosts, recipients, mount UUIDs, container names, thresholds and paths.

Publication intent is persisted before every mutation. Lost creation responses
are reconciled by inspecting exact job bytes; absence or ambiguity never causes an
automatic repeat. Inert own definitions are revision-safely removed after their
scheduler fired marker, without deleting occurrence/handoff records. Uncertain
removals remain held. Accepted definitions, recipient execution and external
message delivery remain distinct. The native coordinator/recipient owns the latter
boundaries, not this monitor's JSON ledger.

Missing collection preserves previous incidents and reports unavailable, not
healthy. Gaps/reboots reset sustained-sample timers, not established unresolved
incidents. Maintenance windows suppress transitions without stopping observations;
persistent problems surface after the window ends. Reports retain bounded event
history; a detected gap is reported rather than invented. No component performs
cleanup, restarts, downloads, purchases, or repairs.

## Operations and limits

These are separately provisioned systemd utilities, not executable checker files
in mutable coordinator state. They require no personal runtime/network change or
Telegram service restart. Task manifests, credentials, state, units and retirement
records remain private. Adding a host using this protocol requires configuration
and provisioning only, never host-specific release code.

A stopped collector is detected by the publisher's freshness check. A stopped
publisher or coordinator cannot notify through itself: operators must inspect unit
health and unresolved publication intents. Linux observations do not establish
hypervisor pressure, physical-disk health or backup restoreability. See the
[operator workflow](../linux-host-monitoring.md).
