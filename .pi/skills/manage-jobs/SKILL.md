---
name: manage-jobs
description: "Creates, edits, lists, and removes scheduled jobs and triggers for this bridge: recurring cron prompts (morning brief), one-time reminders, heartbeat checks that trigger only when a script passes, and incoming webhooks. Use when the user asks to schedule something, set a reminder, run something periodically, watch for a condition, or wire up a webhook (e.g. GitHub events)."
---

# Manage scheduled jobs and triggers

Jobs live in one JSON file the bridge host watches and hot-reloads within about a second:

```text
${PI_TELEGRAM_BRIDGE_STATE_DIR:-~/.local/state/pi-telegram-bridge}/jobs.json
```

The host runs each due job by injecting its `prompt` as a new agent turn; the final reply is delivered to the paired Telegram chat automatically. Write prompts as instructions to your future self (they arrive with a short "job fired" preamble).

## Editing rules

1. Read the current file first (it may not exist yet; start from the template below).
2. Write the full new content to a temp file, then `mv` it over `jobs.json` (atomic — the host must never see a half-written file).
3. Validate: run `npm run jobs:check` from the repository root and report the result to the user. If it prints a `lastLoadError`, the host rejected a previous load; fix and re-edit.
4. Confirm to the user what was scheduled, including the schedule in plain words.

## Schema

```json
{
  "version": 1,
  "jobs": [
    { "id": "morning-brief", "type": "cron", "schedule": "0 8 * * *", "tz": "America/Denver",
      "prompt": "Give me my morning brief: weather, calendar, top news." },
    { "id": "vet-call", "type": "at", "at": "2026-07-18T15:00:00-06:00",
      "prompt": "Remind Isaac to call the vet." },
    { "id": "pr-watch", "type": "heartbeat", "schedule": "0 * * * *", "tz": "America/Denver",
      "check": "/home/isaaclyon/bin/pr-merged-last-hour.sh",
      "prompt": "A PR merged in the last hour (check output below). Review and summarize it." },
    { "id": "gh-events", "type": "webhook",
      "hmacSecret": "<openssl rand -hex 32>",
      "prompt": "A GitHub webhook arrived. Summarize what happened and whether action is needed." }
  ]
}
```

- `id`: unique, `[a-z0-9-]`, max 64 chars.
- `type: "cron"` — recurring; `schedule` is a 5-field cron expression, `tz` an optional IANA zone (default: server local time). Occurrences missed while the bridge is down are skipped.
- `type: "at"` — one-time reminder at an ISO 8601 timestamp; fires once (late if the bridge was down), then stays inert. Prune fired/stale `at` jobs whenever you edit the file.
- `type: "heartbeat"` — recurring like cron, but first runs `check` via `/bin/sh -c` (60s timeout). Only exit code 0 triggers the prompt; the check's stdout (first 4 KB) is appended to it.
- `type: "webhook"` — triggered by `POST /hook/<id>` on the bridge's webhook server (127.0.0.1:8776 by default; started only while at least one webhook job exists). The request body (truncated) is appended to the prompt.

## Webhook auth and exposure

Every webhook request must carry either:

- `Authorization: Bearer <secret>` where the secret is the content of `webhook-secret` in the state directory (host-generated). Treat it as a credential: never paste it into chat unless the user explicitly asks for it to configure a sender.
- For GitHub: set the job's `hmacSecret` (mint one with `openssl rand -hex 32`) and give GitHub the same value as its webhook secret; GitHub signs requests with `X-Hub-Signature-256`.

Public exposure goes through Tailscale Funnel (one-time, needs sudo): `sudo tailscale funnel --bg 8776`. The public URL is then `https://<host>.<tailnet>.ts.net/hook/<id>` — get the exact hostname from `tailscale status`.

## Inspecting state

`jobs-state.json` next to `jobs.json` (host-owned — read it, never write it) records `lastRun` per job, `fired` for at-jobs, and `lastLoadError`.
