# Native heartbeat, webhook and schedule helpers

The isolated `feat/durable-c5-schedules` branch extends the
[cron/at coordinator](pi-durable-c5-coordinator.md) with selected heartbeat
checkers, loopback webhook ingestion, schedule editing and temporary price
watches. The subsequent [child slice](pi-durable-c5-children.md) adds background
children and their retention; its offline validation gate passed. Production
activation remains C6/C7.

## Explicit selection

Select `durable-jobs-schedules-test` with `jobsRole: "coordinator"`. It retains
the coordinator profile's capabilities and adds the existing
`schedule-reminders-and-jobs` and `watch-prices` skills with scoped instructions.
Earlier profile selections remain unchanged. It exposes no background-child
service. Runtime dependencies and their exact pins are unchanged.

Keep the coordinator's existing private directory and target-grant configuration.
The additional required block is:

```json
{
  "coordinator": {
    "stateRoot": "/private/native-state",
    "coordinatorStateDir": "/private/native-state/coordinator",
    "scope": "self",
    "targets": ["test-instance"],
    "schedules": {
      "checkerIds": ["web-page-items", "retail-product-price"],
      "judgeKeyFile": "/private/keys/schedule-judge",
      "webhook": { "port": 8776 }
    }
  }
}
```

`checkerIds` is an explicit, unique selection from `web-page-items`,
`retail-product-price`, `gmail-inbox` and `ynab-unapproved`. An empty list is
valid and disables heartbeat definitions. Omit `webhook` to disable webhook
definitions; its explicit port must be 1–65535. The listener always binds
127.0.0.1 and starts only when webhook jobs exist. Unknown fields and unselected
checkers reject the complete candidate before definition reconciliation, retaining
the last accepted jobs. The older coordinator profile still accepts only cron/at
and rejects this configuration block.

`judgeKeyFile` is optional and separate from memory recall authorization. When
present it must name a private, owned, mode-0600 regular file with one link and
1–4096 bytes. Missing authorization fails semantic checks lazily and preserves
the previous cursor. No ambient judge key is selected. Obtain agreement before
sending private source data to TypeSafe. Missing Google gog configuration with
`gmail-inbox` selected fails startup before the coordinator lease is taken.

These paths describe configuration, not an instruction to migrate live state.
The same self/same-UID target rules, private canonical directories and one-owner
transition procedure from the coordinator guide apply. The native-only lease
does not exclude legacy writers.

## Execution and state

The existing scheduler retains ownership of definitions, fingerprints, occurrence
identities, checker files and publication acknowledgements. Snapshot baselines,
sustained conditions, semantic judgment and incremental cursors use the existing
[heartbeat](adr/0019-stateful-heartbeat-observations.md) and
[inbox](adr/0050-incremental-inbox-heartbeats.md) contracts. Failed reads or
judgments preserve the saved cursor. Successful incremental judgment commits the
next cursor together with pending matches; publication retries precede another
read. Removing a definition cancels known-unclaimed work and preserves accepted
recipient evidence. Terminal occurrence identities remain durable.

Each checker receives ordinary process variables (PATH, HOME, identity, locale,
timezone and temporary-directory settings). Ambient provider secrets and PI
settings are excluded. Gmail alone receives the explicitly selected Google gog
binary, private password-file path, home and optional account, plus the
coordinator state directory. The configured Google account is a default; each
Gmail job explicitly selects its account within that gog home's authentication
scope, as existing Google read operations do. It is not an account allowlist.
Public checkers receive no Google settings. YNAB
uses the selected runtime's OS identity, HOME-based private defaults and existing
CLI authentication; this is the same OS-permission boundary as the CLI skill.
It retains the existing checker threshold and date behavior.

All four checker entrypoints and both CLI helpers are emitted by the native
build. The build imports them and the native application as an ESM smoke check.
Checker subprocesses resolve compiled files in the immutable release and use the
existing bounded output/timeout protocol.

Webhook requests retain bearer/HMAC authentication and bounded payload handling.
HTTP 202 establishes durable occurrence materialization; publication, recipient
admission, execution and external delivery are separate boundaries. Requests
without a trusted stable event identity remain separate occurrences. Public
exposure, Tailscale configuration and service changes need their own authority.
A port conflict fails coordinator startup and releases its native lease; resolve
the configured listener conflict before starting again. Secrets and source text
stay out of lifecycle diagnostics.

## Editing and temporary watches

The new profile's bounded shell receives explicit `PI_TELEGRAM_JOBS_DIR` and
`PI_TELEGRAM_BRIDGE_STATE_ROOT` for this coordinator. Its existing
`PI_TELEGRAM_BRIDGE_STATE_DIR` still selects its own recipient for recovery.
No ambient fleet manifest is inherited. Resolve helpers under
`$PI_TELEGRAM_BRIDGE_RESOURCE_ROOT` and send JSON on stdin:

- `.pi/skills/schedule-reminders-and-jobs/scripts/jobs-cli.mjs`
- `dist/src/price-watches.js`

A saved edit is active only after its exact publication is accepted. Rejected
edits remain saved while the host retains its last accepted definitions. Inspect
an interrupted shell operation before retrying; never restore an old jobs file
automatically. Target grants still control runtime acceptance.

Temporary watches live in the coordinator's private
`temporary/price-watches/<id>/watch.json`. Purpose, creation time, baseline
evidence, end condition and retirement remain task data. The existing helper
publishes reusable source configurations and verifies retirement before moving
manifests into `retired/`. No product-specific code or personal watch is added to
the release. See [ADR-0049](adr/0049-temporary-price-watch-configuration.md).

## Offline evidence and remaining gates

Focused validation passed 110 tests in 14 files with strict native typechecking.
Eight additional application tests cover all four legacy/native coordinator and
recipient combinations for heartbeat and webhook work, including incremental
baseline silence, v1 admission, original timestamp, restart suppression and
preservation of accepted work after definition removal. The earlier cron/at
matrix remains in the suite.

Four actual SIGKILL tests cover incremental heartbeat and webhook occurrences
before and after handoff publication. They restart from the same on-disk state,
compare occurrence identity and original time, and preserve one handoff.
Heartbeat recovery preserves the committed cursor and pending match without
another read or judgment. Webhook fixtures receive 202 before killing the
worker. These barriers prove persistence at publication; they do not interrupt a
checker-state write internally or simulate physical power loss.

Additional tests cover failure/retry ordering, missing judge authorization,
checker selection, sanitized environments, real loopback bearer/HMAC requests,
invalid and oversized requests, and actual compiled release helpers running
through the native application to add/list definitions and retire a temporary
watch. Sources, judges, providers and transports are synthetic; no live mail,
YNAB, price source, TypeSafe or Telegram acceptance is established here.

Node 24 `npm run check:changed` passed 1,067 tests in 108 files, with 38 existing
platform/browser skips, including three whole suites. `npm run build` passed,
including the compiled application, checker and helper imports. The combined
gate took 128 seconds. Independent read-only review found no blocking defect in
profile selection, environment projection or recovery ordering. Its account
scope and occupied-port observations are documented above; existing Google
multi-account reads and same-UID key-file ownership retain their current contract.

The [child slice](pi-durable-c5-children.md) adds background children and
creation-based seven-day child-store retirement in a separate profile. Its
offline validation gate passed; C6 live/platform/migration acceptance remains
open. No production service or private state is changed by this slice.
