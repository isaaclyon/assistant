---
status: accepted
---

# Isolate Telegram Codex settings without splitting the Pi agent directory

## Context

The bridge must share `PI_CODING_AGENT_DIR` with other Pi processes so Telegram configuration, credentials, and singleton ownership locks remain canonical. The Codex conversion extension also derives its settings path from that directory, but the bridge needs Telegram-specific adapter settings.

## Decision

Install pinned `@howaboua/pi-codex-conversion` as a repo dependency, load its entrypoint explicitly only in the bridge host, and apply a version-checked postinstall patch that honors `PI_CODEX_CONVERSION_CONFIG_PATH`. The host sets that variable to a bridge-state file, configurable through `PI_TELEGRAM_CODEX_CONFIG`, while leaving `PI_CODING_AGENT_DIR` unchanged.

## Consequences

- Telegram gets independent Codex settings without duplicating credentials or ownership state.
- Extension upgrades must deliberately update and verify the narrow patch.
- A dedicated agent directory and shared Codex settings remain rejected because they respectively split Telegram ownership state or couple unrelated Pi sessions.
