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

## Telegram fast-mode control

The repo-local `/fast on|off|status` command calls a narrow, process-local host
capability. The host resolves the current session's registered Codex command
and creates a fresh official command context for each call, returning command
notifications directly to Telegram. The capability accepts only these three
actions and is removed during host disposal. It exposes no runtime object.
Telegram's prompt queue decorates text for model delivery, so it cannot carry
this control command. A source-checked
addition to the same install patch handles these arguments only when the
bridge config path is set. It uses Codex conversion's own settings writer and
deferred application lifecycle, preserving active responses and applying the
change once the run settles. Every capability profile includes this command.

The preference is stored as `openai.fast` in the instance's Codex settings.
Status reports the active and saved values, pending application, and conflicting
project/environment overrides. Invalid config files are preserved and reported.
Fast mode requests priority processing where supported and may consume more
quota or cost more; adding the command does not enable it by default.
