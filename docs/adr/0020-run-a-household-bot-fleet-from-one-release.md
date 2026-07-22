---
status: accepted
relates-to: ADR-0005, ADR-0009, ADR-0011
---

# Run a household bot fleet from one immutable release

## Context

A husband and wife need private assistants, a shared group assistant, and a
builder that can evolve centrally managed capabilities. Independent checkouts
would make capability versions drift, while one undifferentiated runtime would
mix conversations, memory, credentials, and Telegram authority.

## Decision

Define instances in one private, strict, versioned manifest and run one systemd
unit per instance from the same full-commit immutable release. Separate mutable
workspaces and per-instance state from the release-owned capability root.
Select extensions, skills, and instructions through the tracked, default-deny
capability manifest; do not discover resources from workspaces or global Pi
directories.

Treat principal, Telegram surface, memory view, credential scope, jobs role,
and workspace as one validated instance identity. Personal bots use private
surfaces. The household bot accepts one exact group and two exact actor IDs,
attributes each accepted update, and rejects all other updates before Pi.
Builder has engineering credentials and no memory. At most one instance owns
job triggers; durable handoffs route work to stable target IDs.

Deploy the fleet as one release transaction: preflight every instance and the
jobs graph, install every unit, activate sequentially, and require exact
release/instance/PID readiness. Roll back every changed unit if any instance
fails. Preserve mutable state and worktrees during both deployment and rollback.

## Consequences

- Capability changes are reviewed and deployed centrally while each bot keeps
  independent conversations and mutable work.
- The household boundary is explicit and testable, but it remains semantic
  isolation under one Unix account rather than a hostile multi-tenant sandbox.
- Adding another household member or unrelated user requires revisiting the
  fixed principal, memory-owner, actor, and credential model instead of merely
  adding an ID.
- A private manifest and per-scope credential files become production
  prerequisites; missing or ambiguous configuration fails closed.
