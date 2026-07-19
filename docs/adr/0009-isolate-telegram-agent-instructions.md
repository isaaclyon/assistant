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

Keep the bridge repository as Pi's working directory, disable automatic context
file discovery in the host, and supply exactly `.pi/telegram/AGENTS.md` through
the resource loader. That tracked file owns the Telegram assistant's persona,
operational behavior, and safety rules. Its canonical target must remain inside
the bridge repository; escaping symlinks are rejected. Root `AGENTS.md` remains
developer guidance and is read only when an approved self-change requires it.

## Consequences

- Server and developer instructions cannot silently change the bot's behavior.
- Telegram behavior changes are explicit, reviewable repository changes.
- Initial startup fails if the dedicated instruction file is absent. If it
  disappears after a successful load, session replacement keeps the last known
  instructions rather than destroying the active runtime.
- Runtime instructions that should also govern development must be maintained
  deliberately rather than inherited accidentally.
