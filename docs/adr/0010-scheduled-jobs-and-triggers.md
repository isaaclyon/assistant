---
status: accepted
relates-to: ADR-0003, ADR-0009
superseded-in-part-by: ADR-0019, ADR-0030
---

# Scheduled jobs and webhook triggers via host-injected prompts

## Context

The bridge only reacted to incoming Telegram messages. We want recurring
prompts (morning brief), one-time reminders, heartbeat checks that trigger
only when a script passes, and incoming webhooks (GitHub events) — all
manageable conversationally through Telegram.

## Decision

The host schedules and triggers; the agent authors the job definitions.

- Jobs live in an agent-edited `jobs.json` in the bridge state directory.
  The host watches it (fs.watch plus an exact-content hash check on each tick) and
  hot-reloads with last-good semantics; it never writes that file. Host-owned
  run state (`lastRun`, `fired` for one-shot jobs, `lastLoadError`) lives in a
  separate `jobs-state.json`, written atomically. A `schedule-reminders-and-jobs` skill and a
  `npm run jobs:check` validator teach the agent the workflow; there are no
  Telegram CRUD commands.
- The jobs CLI serializes complete read/validate/publish mutations with a
  bounded SQLite advisory lock and validates the entire candidate using the
  scheduler parser. Each publication carries a new publication ID. Host state
  records observed and accepted SHA-256 hashes of exact file bytes. A timeout
  means saved but not acknowledged; a rejection preserves last-good runtime
  definitions without restoring an old canonical file over later edits.
- A single 30-second tick loop (`src/jobs.ts`, `croner` for cron/DST math)
  fires due jobs by injecting the job prompt through
  `runtime.session.prompt(..., { source: "rpc" })` after `waitForIdle()`.
  Because such turns have no active Telegram turn, the pinned fork's
  proactive push delivers the final reply to the paired chat — no fork
  changes.
- Heartbeat jobs run their `check` command via `/bin/sh -c` with a timeout;
  only exit code 0 injects the prompt, with the check's stdout appended.
- Webhook jobs are served by a `node:http` listener (`src/webhook.ts`,
  default 127.0.0.1:8776) that runs only while webhook jobs exist. Requests
  authenticate with a constant-time bearer comparison against a
  host-generated secret file, or per-job GitHub `X-Hub-Signature-256` HMAC.
  Authentication is checked before job existence is revealed. Bodies are
  capped at 256 KB and the server replies 202 after durable occurrence
  materialization, before the agent turn runs (ADR-0030).
  Public exposure is delegated to Tailscale Funnel.

## Consequences

- Cron occurrences missed while the process is down are skipped; one-shot
  `at` jobs fire late instead, with the original time in the prompt.
- Webhook requests cannot arrive while the service is down; senders must retry.
  Accepted occurrences survive restart in the ADR-0030 ledger.
- Injected turns share the single-flight session: a long user turn delays a
  job (the recipient waits), and a long job turn delays queued user
  messages by design.
- Scheduled replies arrive as one final message (proactive push), without
  the streaming preview a normal Telegram turn gets.
