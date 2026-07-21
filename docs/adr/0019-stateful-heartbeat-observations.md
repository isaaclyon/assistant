---
status: accepted
relates-to: ADR-0009, ADR-0010
supersedes-in-part: ADR-0010
---

# Evaluate stateful heartbeat observations in the host

## Context

ADR-0010 heartbeats treat exit code 0 as a match and append arbitrary stdout to
an agent prompt. That is sufficient for a script that already owns its state,
but makes every checker reimplement comparison, duration tracking, atomic state,
and notification deduplication. It also cannot distinguish a valid nonmatching
observation from an operational failure.

We need checks such as “the normalized product price changed” and “this YNAB
category has been negative for 15 days” without adding a database or a general
workflow engine.

## Decision

Model a heartbeat as `trigger -> checker -> rule -> onTrigger`.

- The cron schedule remains the trigger. A heartbeat names a constrained checker
  ID, which the host resolves beside its own module in the immutable release and
  executes directly with Node—never through a free-form shell command or the
  canonical checkout. The tracked TypeScript checker emits one bounded versioned
  JSON observation on stdout. Exit 0
  means the observation is valid; nonzero exit, timeout, malformed JSON, or an
  incompatible value is an operational failure. External content is untrusted
  data, not agent instruction text.
- The host evaluates either exact structural change or a small built-in sustained
  condition. The initial change observation is a silent baseline. A sustained
  condition starts at its first successful match, is checked again only on later
  successful observations, and notifies once per episode. Failed or missed checks
  neither reset the episode nor prove its continuity.
- Host-owned per-job state lives as atomic mode-0600 JSON under
  `<stateDir>/checkers/`. It stores only the latest normalized observation,
  condition markers, health timestamps, and at most one pending event. There is
  no observation history or database.
- The only reaction is `onTrigger.type: "prompt"`. The host combines its trusted
  prompt with bounded, clearly delimited event data and injects the agent turn.
  It persists an event before injection and clears it only after injection
  succeeds; a pending event blocks a later observation until retried. Direct
  scheduler-side commands and consequential actions are excluded.
- Checker command or rule changes reset that job's baseline through a configuration
  fingerprint. Removing or changing the type of a job prunes its checker state.
- `jobs.json` advances to schema version 2. Heartbeats use `checker`, `rule`, and
  `onTrigger`; version-1 heartbeat compatibility is not retained. Deployment runs
  the new release's validator before stopping the old service, so an unmigrated
  file or missing compiled checker blocks activation rather than silently
  starting without jobs.

## Considered options

- **Let each checker own state:** rejected because it duplicates persistence and
  temporal semantics in arbitrary scripts.
- **Store observation history in SQLite:** rejected because one latest value and
  a few timestamps satisfy the use cases; history and cross-check queries are not
  required.
- **Allow arbitrary expressions or direct actions:** rejected because a small
  typed rule set and agent prompt preserve a narrower, reviewable safety boundary.

## Consequences

- Small meaningful values can be included as old/new event data; large opaque
  results can be normalized to a hash by their checker.
- A failed checker preserves the last good baseline and condition episode. Wall
  time during failures or bridge downtime may count toward a duration, but a
  later successful matching observation is still required before notification.
- Prompt injection is at-least-once if the process crashes after injection but
  before clearing the pending event. ADR-0010's non-durable final Telegram send
  limitation remains unchanged.
- Existing external `jobs.json` files must be migrated to version 2 before a
  deployment using this decision. The old host retains its last-good version-1
  jobs while the new version-2 file awaits deployment.
