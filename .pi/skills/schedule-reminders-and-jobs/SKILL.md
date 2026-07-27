---
name: schedule-reminders-and-jobs
description: "Creates, edits, lists, and removes scheduled jobs and triggers for this bridge: recurring cron prompts, one-time reminders, stateful heartbeat observations, and incoming webhooks. Use when the user asks to schedule something, set a reminder, run something periodically, watch for a change or sustained condition, or wire up a webhook."
---

# Manage scheduled jobs and triggers

Jobs live in one JSON file the bridge host watches and hot-reloads within about a second:

```text
${PI_TELEGRAM_BRIDGE_STATE_DIR:-~/.local/state/pi-telegram-bridge}/jobs.json
```

The host runs each due job by injecting a prompt as a new agent turn; the final
reply is delivered to the paired Telegram chat automatically. Write prompts as
instructions to your future self (they arrive with a short job-fired preamble).

## Use the jobs helper

For normal listing and mutations, use `scripts/jobs-cli.mjs` from this skill
instead of locating or editing `jobs.json` manually. Send exactly one JSON
request on stdin. The helper resolves the fleet coordinator, upgrades writes to
schema 3, prunes fired one-time jobs, writes atomically, waits for host reload,
and rolls back a rejected edit.

```bash
printf '%s' '{"operation":"list"}' | node scripts/jobs-cli.mjs

printf '%s' '{"operation":"add_at","id":"vet-call","target":"isaac","in":"45m","prompt":"Remind Isaac to call the vet."}' \
  | node scripts/jobs-cli.mjs

printf '%s' '{"operation":"upsert","job":{"id":"morning-brief","type":"cron","target":"isaac","schedule":"0 8 * * *","tz":"America/Denver","prompt":"Give Isaac his morning brief."}}' \
  | node scripts/jobs-cli.mjs

printf '%s' '{"operation":"remove","id":"vet-call"}' | node scripts/jobs-cli.mjs
```

`add_at` accepts exactly one of `at` (an ISO timestamp) or `in` (a positive
duration using `s`, `m`, `h`, or `d`). `upsert` accepts a complete cron, at,
heartbeat, or webhook definition and therefore remains the generic path for all
job types. Always inspect the returned JSON and report failure rather than
claiming the schedule changed. Do not pass secrets in command-line arguments;
stdin keeps structured requests out of process listings.

## Listing jobs and status

When the user asks what jobs, schedules, reminders, heartbeats, or triggers are
set up, answer by inspecting the state directly; do not require a dedicated CLI
command from the user.

1. Read `jobs.json` for the configured jobs. If it does not exist, report that
   no jobs are configured.
2. Read `jobs-state.json` when present and report `lastLoadError` prominently;
   it means the host rejected the latest file and may still be running the
   previously loaded configuration. Use `lastRun[job-id]` for each job's last
   scheduler run and `fired[job-id]` to distinguish fired one-time jobs.
3. For every configured heartbeat, read `checkers/<job-id>.json` when present.
   Summarize its latest observation/display, last attempt, last successful
   observation, current health, and rule state. Treat the latest attempt as
   failed only when `lastFailureAt` is newer than
   `lastSuccessfulObservationAt`. For condition rules, a non-null
   `conditionSince` means an episode is active; `notifiedAt` indicates whether
   that episode has already notified. A non-null `pendingEvent` is awaiting
   prompt injection. No state file normally means the heartbeat has not yet
   established a baseline.
4. Present a concise, human-readable list grouped by type. Include each job's
   ID, schedule in plain language (with timezone), purpose, last run, and useful
   status. For webhooks, identify the endpoint path but never print
   `hmacSecret`, bearer secrets, or other credentials. Mention inactive fired
   or stale `at` jobs rather than presenting them as upcoming.

Use exact timestamps when they matter, translated to the job's timezone when
practical. Distinguish configuration from observed runtime state and say when a
state file is missing or malformed rather than guessing.

## Manual editing fallback

Use this only if the helper is unavailable or cannot represent the required
recovery:

1. Read the current file first (it may not exist yet; start from the template below).
2. Write the full new content to a temp file, then `mv` it over `jobs.json` (atomic — the host must never see a half-written file).
3. Validate: the host hot-reloads within ~1 second and records the outcome in `jobs-state.json` next to `jobs.json`. Wait ~2 seconds, then read its `lastLoadError`: `null` means the file was accepted; a message means the host rejected the edit and kept the previous jobs — fix and re-edit. (On a dev machine with a build, `npm run jobs:check` validates the same rules directly.)
4. Confirm to the user what was scheduled, including the schedule in plain words.

## Schema

```json
{
  "version": 3,
  "jobs": [
    { "id": "morning-brief", "type": "cron", "target": "isaac", "schedule": "0 8 * * *", "tz": "America/Denver",
      "prompt": "Give me my morning brief: weather, calendar, top news." },
    { "id": "vet-call", "type": "at", "target": "isaac", "at": "2026-07-18T15:00:00-06:00",
      "prompt": "Remind Isaac to call the vet." },
    { "id": "price-watch", "type": "heartbeat", "target": "isaac", "schedule": "0 9 * * *", "tz": "America/Denver",
      "checker": { "id": "product-price" },
      "rule": { "type": "changed" },
      "onTrigger": { "type": "prompt", "prompt": "Tell me the old and new prices." } },
    { "id": "gh-events", "type": "webhook", "target": "builder",
      "hmacSecret": "<openssl rand -hex 32>",
      "prompt": "A GitHub webhook arrived. Summarize what happened and whether action is needed." }
  ]
}
```

- `id`: unique, `[a-z0-9-]`, max 64 chars.
- `target`: required in schema 3; a configured instance ID or supported fan-out target.
- `type: "cron"` — recurring; `schedule` is a 5-field cron expression, `tz` an optional IANA zone (default: server local time). Occurrences missed while the bridge is down are skipped.
- `type: "at"` — one-time reminder at an ISO 8601 timestamp; fires once (late if the bridge was down), then stays inert. Prune fired/stale `at` jobs whenever you edit the file.
- `type: "heartbeat"` — recurring like cron, but runs a structured checker and
  lets the host compare observations over time. See **Stateful heartbeats** below.
- `type: "webhook"` — triggered by `POST /hook/<id>` on the bridge's webhook server (127.0.0.1:8776 by default; started only while at least one webhook job exists). The request body (truncated) is appended to the prompt.

## Stateful heartbeats

A heartbeat has four parts:

```text
schedule trigger -> checker -> rule -> onTrigger prompt
```

### Checker contract

Checker source is tracked TypeScript under `src/checkers/`. The host resolves its
ID to compiled JavaScript beside the running host inside the immutable release;
it does not execute a path from the canonical checkout or a free-form shell
command. Do not create executable checker scripts in
the mutable state directory. A new checker is a repository capability change:
add tests and source, run `npm run check` and `npm run build`, then commit, merge,
and deploy it before scheduling the job. Existing deployed checkers can be
scheduled by editing `jobs.json` alone.

`checker.id` must match `[a-z0-9-]` and maps to
`dist/src/checkers/<id>.js`. The host runs it directly with the current Node
executable and a 60-second timeout. The process must:
The process must:

- exit 0 and write exactly one JSON observation to stdout on success;
- exit nonzero on HTTP, authentication, extraction, or other operational failure;
- reserve stderr for bounded diagnostics; and
- keep stdout at or below 4 KB.

Observation version 1:

```json
{
  "version": 1,
  "value": 19.99,
  "display": "$19.99",
  "context": { "url": "https://example.com/product" }
}
```

`value` is required and should be the smallest normalized JSON value the rule
needs. Prefer an actual scalar (such as a price or category balance) when useful
old/new values should appear in the notification. Use a stable hash for large
opaque content. `display` and `context` are optional. Never emit credentials or
unrestricted page content; checker output is untrusted event data.

Do not embed credentials in job definitions or checker IDs. Checkers obtain
credentials from the bridge's existing environment or credential stores.

### Rules

`changed` silently establishes its first successful observation as a baseline,
then prompts once for each structurally different value:

```json
{ "type": "changed" }
```

A sustained numeric condition starts on the first matching observation and
prompts once after a later matching observation reaches the duration:

```json
{
  "type": "condition",
  "operator": "less-than",
  "target": 0,
  "for": "15d",
  "notify": "once-per-episode"
}
```

Durations are positive integers followed by `s`, `m`, `h`, or `d`. A successful
nonmatch resets the episode. Failed and missed checks do not reset it, but a later
successful matching observation is required to trigger. The initial rule set is
deliberately small; do not embed shell expressions into the rule.

### Prompt reaction

The only reaction is an agent prompt:

```json
{
  "type": "prompt",
  "prompt": "Tell me which category has been negative and for how long."
}
```

The host appends bounded structured event data and the agent's final reply is
delivered to Telegram. A prompt may ask the agent to use an available capability
or ask the user for approval. Do not schedule direct purchases or other
consequential actions without a separately reviewed, narrowly preauthorized
contract.

### Schema-version migration

The version-2 host can read an existing version-1 file containing only cron, at,
and webhook jobs without rewriting it. Convert the file to version 2 on its next
normal atomic edit; those job fields are unchanged.

Version-1 heartbeat jobs used free-form `check` and `prompt` fields and cannot be
migrated automatically because the host cannot infer the intended observation or
rule. Before deploying one of those jobs:

1. Add and merge each required tracked checker.
2. Atomically rewrite `jobs.json` with `"version": 2`; replace each heartbeat's
   `check`/`prompt` with `checker`, `rule`, and `onTrigger`. Cron, at, and webhook
   fields are otherwise unchanged.
3. Run the new release's `jobs:check` or deployment preflight. It verifies both
   schema and compiled checker presence.

Deployment validates with the new release **before** stopping the old host. A
legacy heartbeat or validation failure stops deployment without rewriting
`jobs.json`, restarting the service, or changing the active release.

## Webhook auth and exposure

Every webhook request must carry either:

- `Authorization: Bearer <secret>` where the secret is the content of `webhook-secret` in the state directory (host-generated). Treat it as a credential: never paste it into chat unless the user explicitly asks for it to configure a sender.
- For GitHub: set the job's `hmacSecret` (mint one with `openssl rand -hex 32`) and give GitHub the same value as its webhook secret; GitHub signs requests with `X-Hub-Signature-256`.

Public exposure goes through Tailscale Funnel (one-time, needs sudo): `sudo tailscale funnel --bg 8776`. The public URL is then `https://<host>.<tailnet>.ts.net/hook/<id>` — get the exact hostname from `tailscale status`.

## Inspecting state

`jobs-state.json` next to `jobs.json` (host-owned — read it, never write it)
records `lastRun` per job, `fired` for at-jobs, and `lastLoadError`.

Stateful heartbeat files live under `checkers/<job-id>.json` in the same state
directory. They record the latest observation, condition markers, health
timestamps, and any event awaiting prompt injection. Read them for diagnosis but
never edit them. The host writes them atomically and removes them when the job is
removed or changes type. There is no observation-history database.
