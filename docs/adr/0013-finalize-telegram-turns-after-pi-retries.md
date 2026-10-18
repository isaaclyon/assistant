---
status: accepted
relates-to: ADR-0002, ADR-0007
---

# Finalize Telegram turns after Pi retries settle

## Context

Pi emits `agent_end` after every low-level run, before deciding whether to retry,
and emits `agent_settled` only when no retry, compaction, or follow-up remains.
`pi-telegram` finalized and cleared the active Telegram turn on `agent_end`, so a
retryable failure could be sent as final while the successful retry lost its
original Telegram destination.

## Decision

Pin and explicitly load `@narumitw/pi-retry`, which classifies the known Codex
websocket/backend failures and stalled streams for Pi's built-in retry policy.
Apply a version- and source-checked install patch to the pinned `pi-telegram`
lifecycle registration: retain the latest `agent_end` event and finalize it on
`agent_settled`. Pi continues to own retry limits and exponential backoff.

## Consequences

- A retried turn keeps its Telegram target and delivers only the settled result.
- Exhausted or disabled retries still deliver the final provider error.
- Telegram queue dispatch waits until Pi has no automatic continuation left.
- Dependency upgrades must revalidate or remove the lifecycle patch.
- Global extension discovery remains disabled; the retry package is an explicit,
  reviewable bridge dependency.


## Native migration implementation

The separate `durable-parity-test` profile replaces the coding-agent retry
extension with a host-owned provider wrapper. The native 1.3.0 matcher already
handles HTTP/network failures and explicit retry guidance; the wrapper adds only
empty-detail failures and Codex websocket connection-limit wording. Native
quota/billing exclusions remain authoritative. The wrapper applies a 90-second
idle watchdog to each provider stream, resets it on stream activity and aborts
its child signal when idle. Tools have their own bounds. Caller cancellation
stays aborted even if a provider sends a late success; late tool calls are
ignored. The wrapper has no retry loop or ambient retry settings.

The Harness owns the configured retry budget, exponential delay, persisted
attempt and task state. The host discovers finals only after submission
settlement, preserving the original destination across retry. A completed unsafe
tool result is historical evidence, so a subsequent provider retry does not
repeat its effect. Compatibility and recovery remain profile-specific; earlier
profiles keep their existing registrations. Production continues using the
legacy dependency and lifecycle patch until C6/C7 activation.
