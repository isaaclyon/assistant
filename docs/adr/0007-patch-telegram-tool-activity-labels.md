---
status: accepted
---

# Patch Telegram tool activity labels at install time

## Context

`pi-telegram` owns the transient Telegram tool-activity message, but exposes no
public formatter hook. Its generic formatter includes raw tool names and argument
hints, which are difficult to read and can reveal command or query text. Historical
bridge sessions show that a small allowlist covers most activity, including direct
file tools and common shell operations.

## Decision

Keep the full-commit-pinned `@llblab/pi-telegram` dependency and apply a narrow,
idempotent postinstall patch to its tool-activity formatter. The patch must check
both the package version and expected source before modifying it. Friendly labels
come from deterministic allowlisted rules; unknown commands use a generic label
and never expose their contents. Repository tests import the installed formatter
and verify both mappings and privacy-safe fallbacks.

Maintaining this behavior as a local install patch was chosen over adding another
commit to the fork because it is bridge-specific presentation policy. Editing
`node_modules` without a reproducible script and parsing labels with a model were
rejected as respectively non-durable and non-deterministic.

## Consequences

- Fresh installs and immutable deployment releases reproduce the same labels.
- Dependency upgrades fail installation until the expected version and source
  patch are deliberately reviewed and updated.
- The installed package differs narrowly from its pinned tarball, and its own
  upstream label tests are superseded by this repository's behavior tests.
