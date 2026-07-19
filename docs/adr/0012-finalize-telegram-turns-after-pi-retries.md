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
