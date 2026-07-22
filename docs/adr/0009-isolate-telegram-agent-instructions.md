---
status: accepted
---

# Isolate Telegram agent instructions

## Context

Pi normally discovers AGENTS files from the working-directory hierarchy. That
made the always-on Telegram assistant inherit both server-level preferences and
repository developer guidance. The dedicated session directory does not isolate
prompt context, and changing the working directory would disturb the bridge's
home-base and same-cwd behavior.

## Decision

Disable automatic context-file and resource discovery in the host. In
compatibility mode, keep the bridge repository as Pi's working directory. In
fleet mode, allow a separate mutable workspace but resolve instructions,
extensions, and skills only from the selected profile in the immutable
release's `.pi/capabilities.json`. The tracked `.pi/telegram/AGENTS.md` owns the Telegram assistant's persona,
operational behavior, and safety rules. Its canonical target must remain inside
the bridge repository; escaping symlinks are rejected. Root `AGENTS.md` remains
developer guidance and is read only when an approved self-change requires it.

## Consequences

- Server and developer instructions cannot silently change the bot's behavior.
- Telegram behavior and capability changes are explicit, reviewable release changes shared by every instance.
- A workspace or builder worktree cannot silently grant its own runtime new capabilities.
- Initial startup fails if the dedicated instruction file is absent. If it
  disappears after a successful load, session replacement keeps the last known
  instructions rather than destroying the active runtime.
- Runtime instructions that should also govern development must be maintained
  deliberately rather than inherited accidentally.
