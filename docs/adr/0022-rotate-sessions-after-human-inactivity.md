---
status: accepted
relates-to: ADR-0002, ADR-0003, ADR-0010, ADR-0020
---

# Rotate sessions after human inactivity

## Context

Pi's token-driven compaction intentionally carries a summary forward, while the
bridge needs a separate product boundary for unrelated conversations after a
long period without human input. Scheduled work should remain discussable but
must not keep the human conversation active forever. Creating sessions on a
timer would produce empty history, and inferring human activity from Pi user
entries is unsafe because host-injected jobs use the same entry role.

Telegram owns its queue and durable replay, while the host alone owns
`AgentSessionRuntime.newSession()`. Session replacement and policy persistence
cannot be one filesystem transaction, so the triggering event must remain
retryable across either failure.

## Decision

Support the opt-in per-instance `PI_TELEGRAM_SESSION_IDLE_HOURS` setting. Unset
or `0` disables rotation; positive finite values up to 8,760 hours enable it.
The host tracks the most recently accepted human prompt in
`<stateDir>/conversation-session-state.json`. Jobs never advance that clock.
The first Telegram prompt or scheduled-job prompt at or beyond the boundary
rotates immediately before dispatch, at most once for that human-idle epoch.
Background-subagent completions bypass this policy because they continue the
parent turn.

The state file is host-owned, mode `0600`, and atomically replaced. Before a
replacement, the host persists a pending record containing the old Pi session
ID, trigger class, idle epoch, and request time. After replacement it persists
either the rotated idle epoch (job trigger) or a fresh human baseline (Telegram
trigger). On restart or retry, a matching current session ID means replacement
did not occur and may be retried; a different session ID proves replacement
occurred and completes state without creating another session. A persistence
failure before replacement prevents replacement. A rare failure after manual
replacement is recovered through the same correlation on the next policy
evaluation.

Missing state adopts the current session. Jobs do not establish or guess a
baseline; the first observed human prompt does. Malformed state fails startup
with a bounded error, preserving any durable inbound turn for a later retry.

Extend the pinned fork with one narrow process-local
`registerTelegramHostPromptPreparation` capability. It receives only the
trigger kind and returns whether the host replaced the session. The fork keeps
the complete triggering turn in its queue and durable inbox while preparation
is pending, blocks duplicate dispatchers, leaves failures queued, and prevents
the stale dispatcher from handing off after replacement. The fresh runtime
replays and dispatches the unchanged turn. The capability exposes neither
prompt content nor Pi runtime internals.

Manual `/new`, Telegram preparation, and job preparation share the policy's
serialized replacement path and recheck Pi idleness immediately before
`runtime.newSession()`. The fork publishes its bounded replacement-readiness
guard for each live session; job replacement must pass the same queued-turn,
active/pending-turn, compaction, and Pi pending-message checks as `/new`.
Telegram preparation excludes only its own intentionally queued triggering
turn. A successful manual `/new` starts a fresh human-idle
interval. Rotation emits bounded instance/trigger diagnostics but no Telegram
notification, summary, or handoff content.

## Consequences

- Active conversations retain continuity, while one stale human-idle epoch can
  produce only one replacement even if several jobs fire.
- The triggering event is the first turn in the new session; the old append-only
  session remains resumable and durable memory remains independent.
- A crash before replacement retries it. A crash after replacement but before
  final persistence completes from the changed session ID without another
  replacement or a lost event.
- Disabled deployments keep existing session behavior. Rollback is setting the
  value to `0` or removing it and restarting; retained policy state is inert.
- Token compaction remains independent and unchanged.
