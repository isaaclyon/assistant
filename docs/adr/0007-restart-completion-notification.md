---
status: accepted
relates-to: ADR-0006
---

# Confirm successful Telegram bridge restarts

## Context

`/restart` sends an acknowledgment before the old process exits, but that
does not tell the operator whether systemd successfully brought the bridge
back. The command handler cannot retain its Telegram reply context across a
process boundary.

## Decision

When the host accepts a restart, it writes a small pending marker under the
dedicated bridge state directory. On startup, after `startBridgeHost` reports
ready, the daemon sends a fixed confirmation through the Telegram Bot API to
the paired user and removes the marker only after Telegram accepts the
message. A failed send leaves the marker for a later startup retry. The
notification uses the configured default bot token and `allowedUserId`; it is
an operational acknowledgment, not a general outbound delivery queue.

## Consequences

- Operators receive confirmation only after the new process has initialized
  and Telegram polling ownership has been checked.
- A Telegram API failure does not make an otherwise healthy service fail; it
  is logged and retried on a later restart.
- The acknowledgment targets the paired user, so it does not preserve a
  group/topic command target.
- The marker contains no credentials or message content beyond a timestamp.
