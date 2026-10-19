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


## Native recipient implementation

The separate `durable-jobs-test` profile consumes the same v1 handoff exchange
under the same private drain/transition locks. Its explicit recipient role reads
only its own configured state directory and routes to its configured private
chat. Legacy/native runtime generations never concurrently own one recipient;
coexistence is across separately owned instances. Cross-UID exchange remains
unsupported.

A native reservation binds dispatch payload and authority. A job source identity
retains dispatch/job/type/original-time metadata without synthetic Telegram
message IDs. Public native submission with a stable request ID establishes
admission before the file moves to `completed`. A native-owned surviving claim
can reconcile its reservation and submission; historical claims with no native
proof stay held. Changed or malformed bytes cannot authorize another request.
The native document records run outcome separately; v1 acceptance still says
nothing about external completion. Proactive output follows the native final
ledger and its delivery ambiguity policy, with `NO_REPLY` suppressed.

Canonical definitions, occurrence ledger and terminal identities keep their
existing domain owners. The [C5 recipient guide](../pi-durable-c5-jobs.md) records
recipient validation and open gates.

## Native cron and one-shot coordinator

The separate `durable-jobs-coordinator-test` profile adds cron/at publication by
reusing the host-neutral scheduler. Its coordinator state stays outside every
recipient state tree. Explicit self or same-UID target grants control each v1
publication; cross-UID exchange remains unsupported. A lifetime SQLite lease
excludes other native coordinators, while legacy/native transition still needs
quiescent writers and one active owner. The legacy coordinator does not use this
lease.

Publication retains the materialized occurrence's full identity and original
creation time. Restored unsupported work cannot publish. Definition edits and
removal reconcile cancellation before recipient startup; invalid identities,
unsafe trees or removed target grants can hold startup until explicitly resolved.
Processing and accepted work remain recipient-owned.

Fresh-runtime provenance, committed atomically with first ledger metadata only
when legacy state is absent, allows restart after a rejected first definition
file saves scheduler state. It does not mark definitions initialized or prove a
historical one-shot ran. Untagged/unknown ledgers and interrupted offline legacy
initialization retain their migration guard. This additive domain record keeps
the version-1 occurrence and handoff identities intact.

The [coordinator guide](../pi-durable-c5-coordinator.md) records offline evidence
and the subsequent schedule and child migration gates.

## Native heartbeat and webhook publication

The separate `durable-jobs-schedules-test` profile extends the same coordinator
with explicit heartbeat checker selection, scoped schedule helpers and optional
loopback webhook ingestion. Existing domain owners retain cursor, definition and
occurrence identity; HTTP 202 still establishes materialization only. The
[schedule guide](../pi-durable-c5-schedules.md) records the four-way heartbeat and
webhook admission matrix and SIGKILL publication barriers. Child execution and
retention remain open; this evidence does not establish production migration.
