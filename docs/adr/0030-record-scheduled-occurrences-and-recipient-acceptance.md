---
status: accepted
relates-to: ADR-0010, ADR-0019, ADR-0020
supersedes-in-part: ADR-0010
---

# Record scheduled occurrences separately from recipient acceptance

## Context

Advancing cron state before durable publication loses work on a crash. Retrying
every Pi exception can duplicate work accepted before the error. Definitions,
coordinator publication, Pi acceptance, and external completion cross different
durable boundaries and cannot share one success flag.

## Decision

Keep canonical definitions in `jobs.json`. The coordinator owns a private SQLite
`job-occurrences.db`, using full synchronous commits, with normalized definition
fingerprints and materialized prompts. An occurrence identity includes job ID,
definition fingerprint, and scheduled instant or event identity. Cron advances
only after materialization. Unobserved downtime slots remain skipped; materialized
work retries after restart and one-shot reminders still fire late.

Ledger states are pending, published, and superseded. Published means recipient
files exist, not that Pi or an external action completed. Definition edits and
removal supersede old occurrences, cancel pending recipient work, and retain
terminal identities. Cancellation reconciles again after restart because the
coordinator database and recipient files do not share a transaction. Initial
legacy one-shot suppression requires exact terminal handoff evidence; an old
`fired[id]` alone cannot prove that the current definition already ran.

All hosts, including singleton mode, use the same recipient protocol:

| Recipient directory | Meaning |
| --- | --- |
| `pending` | Durable prompt awaiting a claim |
| `processing` | Claimed before invocation; surviving claims are uncertain |
| `completed` | Pi explicitly reported preflight acceptance |
| `failed` | Malformed/quarantined work or five known preflight rejections |
| `cancelled` | Known-unclaimed work cancelled, including cancellation ahead of publication |
| `acknowledged` | An operator resolved uncertainty without replay; not proof of Pi acceptance |

Private SQLite advisory locks serialize recipient transitions and exclude manual
recovery during an active drain. Atomic file publication and moves synchronize
file and directory contents. Publication checks recipient evidence before
recreating pending files, even when coordinator acknowledgement lags.

Pi 0.80.10 documents `preflightResult(true)` as acceptance/queueing/immediate
handling and `false` as rejection before acceptance. Persist either outcome
when the callback fires, independently of the full run promise. The drain returns
at durable preflight while keeping a handled continuation for the run. A missing
callback or arbitrary exception leaves the claim uncertain; error text never
authorizes retry. Host shutdown cancels idle waits before invocation and stops
further claims.

Operator recovery is bound to the active recipient and an exact inspected file
hash. Explicit retry resets its attempt count and returns it to pending; explicit
acknowledgement creates separate terminal evidence. Neither action is inferred
automatically from session text.

Webhook HTTP 202 means the occurrence was durably materialized. Materialization
failure returns 503. Requests without a trusted stable upstream event identity
receive separate UUIDs; identical bodies are not silently deduplicated.

## Consequences

- No exactly-once guarantee covers model work, external actions, or Telegram sends.
- A crash between Pi acceptance and its durable callback transition remains
  uncertain. Operator retry can duplicate previously accepted work.
- Canonical definitions remain portable, but the occurrence ledger is durable
  recovery state, not a disposable search cache. Keep terminal identities.
- Migration requires quiescent writers and recipients. Rollback must restore
  matching state and binaries, never older binaries alone over changed recovery
  state. Legacy handoff reconciliation must precede production rollout.

## Offline transition and deployment failure

The one-time migration preserves legacy dispatch and recipient files unchanged.
It refuses unresolved pending/processing/failed work, missing or conflicting
fan-out evidence, unsafe files, duplicate JSON keys, and malformed scheduler
state. It does not invent historical event IDs, definition fingerprints, or
occurrence rows. An exact current one-shot event hash, target, present job type,
and rendered terminal payload may seed only its suppression bit. Unprovable
current one-shot fired IDs require operator resolution, not guessed replay or
suppression. Existing legacy state blocks automatic first ledger initialization.

Deployment disables and stops every discovered bridge unit, including retired
and singleton units, before snapshot or migration. Cooperative job locks exclude
active manual definition/recovery operations; external writers must also pause.
A private retained checkpoint contains state, previous units, and their immutable
application releases, with source/copy and restored-copy digest verification.
Only relative, in-tree release symlinks are allowed. Release hard links (npm
creates them, for example for esbuild) are allowed only when every link to the
file is inside the same release; state files must not be hard-linked. Node itself, external
credentials, and memory outside the state tree are not migrated or rewound.

Before any candidate can start, deployment persists an irreversible startup
barrier. Failures leave all units disabled and preserve evidence. A pre-start
checkpoint can restore matching state and binaries offline; after the barrier,
automatic rewind is forbidden because it could replay accepted work.

Generated units use `ExecCondition` to enforce the maintenance hold. Only a
matching temporary authorization in the user manager's environment permits
candidate startup. Deployment revokes that authorization before enabling units,
then removes and synchronizes the hold only after all instances are ready and
enabled. Reboot clears manager authorization, so an interrupted enable sequence
cannot bypass the surviving hold. This replaces the unit-only automatic rollback
in ADR-0005 and ADR-0020. See the fleet runbook for explicit recovery and the
required target-systemd smoke test.
