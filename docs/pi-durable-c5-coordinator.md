# Native cron and one-shot coordinator

The isolated `feat/durable-c5-coordinator` branch extends the
[C5 recipient](pi-durable-c5-jobs.md) with cron and one-shot publication through
the existing v1 exchange. C5 remains open; production activation remains C6/C7.

## Selection and ownership

Select `durable-jobs-coordinator-test` with `jobsRole: "coordinator"` in private
native configuration. This profile includes the native recipient and the same
selected capabilities as `durable-jobs-test`, with coordinator instructions.
It exposes no schedule-editing or background-child tools. Older profile
selections remain unchanged. The new direct dependency is exact `croner@10.0.1`;
the four Pi runtime packages remain pinned together at 1.3.0.

The additional configuration is:

```json
{
  "coordinator": {
    "stateRoot": "/private/native-state",
    "coordinatorStateDir": "/private/native-state/coordinator",
    "scope": "self",
    "targets": ["test-instance"]
  }
}
```

The native recipient's `stateDir` must be
`<stateRoot>/instances/<instanceId>`. `coordinatorStateDir` must be separate from
the entire `instances` tree and must not contain that tree. Configuration paths
are canonical; state root, instances directory and coordinator directory are
existing, owned mode-0700 directories. This example is configuration guidance,
not an instruction to create or migrate live state.

`self` grants exactly the active instance. `shared-owner` explicitly grants a
bounded list of same-UID recipient IDs. Each peer directory must already exist
and be private. `both-personal` expands only when both individual targets are
explicitly granted. It is never an authority grant itself. Publication validates
the relevant private recipient directories and dispatch files; unsafe or
out-of-scope work stays pending. The private-tree checks assume cooperating
same-UID writers; they do not create a cross-UID boundary or repair permissions.
Isolated personal deployments remain self-only.

One native coordinator holds an OS-released SQLite lease for its configured
coordinator directory. Startup failure releases it; successful shutdown settles
the scheduler before release. This lease excludes other native coordinators.
The legacy coordinator does not honor it. Switching generations requires
quiescent writers and one active owner; native and legacy processes cannot
concurrently own the same coordinator or recipient state.

## Definitions, recovery and cancellation

The existing scheduler owns `jobs.json`, `jobs-state.json`, `job-occurrences.db`
and `job-dispatches/` inside `coordinatorStateDir`. Native code reuses that domain
implementation. Definition fingerprints, full occurrence hashes, terminal
identities and v1 handoff fields retain their existing owners.

The native coordinator accepts cron and `at` definitions only. Heartbeat and
webhook definitions reject the whole new file before reconciliation. On reload,
the last accepted definitions stay active. A restored unsupported pending
occurrence cannot publish. This slice starts no webhook listener or checker.
Read `jobs-state.json` for the saved load error; lifecycle debug output is
redacted. Read-only `npm run inspect` adds pending/published/superseded counts
and whether this application's coordinator has started. Inspection never creates
or adopts a ledger.

A fresh ledger records fresh-runtime provenance atomically with its metadata,
only when no legacy state exists. An invalid first definition file can therefore
save its load error and restart safely before its first accepted definitions.
Older untagged ledgers and interrupted offline legacy initialization retain their
conservative migration guard. Definitions become initialized only on a successful
reconciliation; provenance supplies no historical one-shot suppression proof.

Cron advances after durable materialization and skips unobserved downtime slots.
An overdue one-shot still fires late. Publication retries retain the occurrence's
original creation time and identity. Before using occurrence fields in paths,
the adapter validates job ID, fingerprint, event identity and expected full hash.
Published means v1 file publication; `completed` means recipient admission.
Native run completion and final delivery remain separate.

Definition changes and removal supersede occurrences and reconcile pending-file
cancellation again after restart. Processing or accepted work stays with its
recipient. A corrupt retired identity, unsafe recipient tree or removed target
grant can block coordinator startup while cancellation remains unresolved.
Preserve that evidence, restore the explicit grant or safe tree under the
one-owner recovery procedure, and retry startup. Do not discard terminal rows
or widen permissions to bypass the hold.

## Validation

Node 24 `npm run check:changed` passed 978 tests in 93 files, with 38 existing
platform/browser skips, including three whole suites. `npm run build` passed,
including the compiled application import. The combined gate took 109 seconds.
The focused gate passed 139 tests in ten files with strict native typechecking.

The offline fixtures cover:

- All four legacy/native coordinator-recipient combinations for late one-shot
  publication, v1 admission, original timestamp, duplicate/restart suppression
  and preservation of accepted work after definition removal.
- Cron slots, explicit fan-out, target rejection, unsafe directory holds,
  corrupt identities, lease exclusion and recovery after restored authority.
- First-invalid-file restart, unknown/legacy ledger guards, existing scheduler
  behavior and offline legacy migration evidence. Escaped JSON may expand a
  valid 32-KiB prompt; bounded file checks allow that expansion during both
  publication retry and native admission.
- Real SIGKILL barriers after materialization, after publication, before
  cancellation and after cancellation. Restart preserves identities and avoids
  duplicate pending files.

Independent read-only reviews found the recipient-directory overlap, which is
now rejected in both configuration and direct construction. A follow-up recovery
review found no material issue in fresh-ledger provenance or read-only inspection.

These are synthetic local application/provider/transport and filesystem tests.
They do not establish live provider or Telegram delivery, Linux service readiness,
real state migration or cross-UID handoff. The complete matrix for heartbeat and
webhook work remains pending with those implementations.

## Remaining C5 work

Heartbeat/checker rules and cursors, webhook ingestion, temporary price-watch
tasks, schedule-editing capability selection, background children and
creation-based seven-day child-store retirement remain open. Keep canonical
definitions, terminal occurrence identities and historical uncertainty through
those slices. See the [roadmap](pi-durable-migration-plan.md#c5--native-schedules-and-background-agents).
