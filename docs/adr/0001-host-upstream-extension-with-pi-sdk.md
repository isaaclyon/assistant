---
status: accepted
---

# Host the upstream Telegram extension with the Pi SDK

## Context

`pi-telegram` already provides a mature Telegram transport and operator UI, but it deliberately does not own Pi process supervision. Vendoring it with git subtree would couple this project to upstream internals and make upgrades harder.

## Decision

Build a small systemd-supervised host around Pi's `AgentSessionRuntime`, load the pinned `@llblab/pi-telegram` package as an extension in RPC mode, and keep upstream source outside this repository. Fork and pin the dependency only if a demonstrated requirement cannot be met through its public extension boundary.

## Consequences

- Upstream Telegram improvements remain straightforward to adopt.
- This repository stays focused on lifetime, persistence, and operations.
- The host inherits the extension's in-memory queue durability limit.
- Upstream extension API changes must be caught by the integration test before dependency upgrades ship.
