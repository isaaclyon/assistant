# Delegated schedule management

This optional native interface lets a bot manage authorized **cron and at prompt
jobs** without owning a scheduler or reading another bot's private state. The
coordinator alone still publishes occurrences. It is disabled unless explicitly
configured on both sides. See [ADR-0055](adr/0055-delegate-schedule-definition-management.md).

## Administrator provisioning (not performed by the agent)

1. Select the existing coordinator and the recipient targets it already owns.
   Do not broaden an isolated coordinator's self-only recipient grant.
2. Provision a canonical socket directory owned by the coordinator UID with
   mode 0750 and a dedicated group that permits the authorized client to
   traverse it. The coordinator's primary group or the directory's setgid
   policy must give its new socket that same group. The server creates its
   socket mode 0660. Do not make the parent group/world-writable. No private
   state directory is shared; the directory contains only this socket.
3. Generate 32 cryptographically random bytes encoded as 64 lowercase hex
   characters using a trusted administrator terminal. Store separate private
   regular mode-0600, single-link key files owned by each runtime. Never paste
   keys into chat, request JSON, command arguments, source, or environment.
4. Add the server's optional `coordinator.control` and the non-coordinator's
   optional `scheduleClient` to their private native configurations. Repin the
   administrator configuration digests through the staged deployment procedure.
   Use distinct keys and non-overlapping prefixes for additional grants.
5. These are **authority changes**, not instruction-only updates. Select the
   narrow `scheduleUpgradeFrom` transition described below. Do not edit stored
   signatures, remove databases, or replay uncertain work.
   For an isolated system coordinator the socket must be exactly
   `/run/pi-telegram-schedules/<instanceId>/control.sock`. The administrator
   renderer opens only that directory in `ReadWritePaths`; all other sandbox
   restrictions remain unchanged. Provision its setgid directory and boot-time
   recreation separately. A pre-existing operator-only client group can be used
   without adding the personal runtime to any privileged supplementary group.
6. Use the [staged administrator procedure](pi-durable-c6-rehearsal.md) for
   release/service operations. No restart or enablement is implied by merging.
   Verify the actual cross-UID socket permissions under the deployed identities.

Synthetic server fragment (inside the existing coordinator configuration):

```json
{
  "control": {
    "socketPath": "/run/bridge-schedules/control.sock",
    "grants": [{
      "keyFile": "/private/coordinator/schedule-client.key",
      "jobPrefix": "ops-",
      "targets": ["personal"]
    }]
  }
}
```

Synthetic client fragment (top-level, alongside `jobsRole: "recipient"`):

```json
{
  "scheduleClient": {
    "socketPath": "/run/bridge-schedules/control.sock",
    "serverUid": 2001,
    "keyFile": "/private/engineering/schedule-client.key"
  }
}
```

The client does not need the coordinator state path, global manifest, server key
path, personal token, memory or provider credentials. Its OS identity can use
its granted key; the interface is an authority boundary at the server, not a
restriction on arbitrary shell execution by the same identity.

## Settled scheduling-authority transition

A new private native configuration may select:

```json
{"scheduleUpgradeFrom":{"configPath":"/private/retained-prior.json","sha256":"<exact prior configuration SHA-256>"}}
```

Keep the prior configuration and immutable release available. The predecessor
must be a private, canonical, single-link runtime-owned file matching the exact
pinned digest. Administrator preflight binds its path and release to the installed
previous map; the old unit's existing config digest remains independently checked.
The new and old releases must be distinct SHA-named siblings.

Only `scheduleClient` and `coordinator.control` may change. Existing coordinator
targets, checker selection, jobs role, transport, identity, credentials, memory,
workspace, model account and all other settings must remain identical. Drop a
previous instruction-upgrade selector; never select both upgrade modes. The
runtime reconstructs schema-1 and schema-2 predecessor signatures using the
current exact tool contracts and retained prior instructions/configuration. A
contract mismatch still refuses startup.

Before cutover, let native tasks, submissions, controls, local accepted inbox work
and external delivery settle. The old metadata is not changed during inspection.
Startup validates retained sources under unchanged recipient authority and updates
compatibility plus instructions in one native transaction before the coordinator,
transport or provider execution starts. Pending/uncertain work remains held, not
resubmitted. This preserves conversation IDs, history, model preferences and
operation receipts. After success the selector may be omitted from later configs.
This is not a generic authority/signature override.

Use staged activation and its paired checkpoint/no-rewind barrier. When upgrading
the bot performing the work, queue the approved administrator cutover in a managed
one-shot service **after that turn has settled**, rather than killing the active
turn and then attempting to bypass the settled-work check. Retain a private status
receipt and perform post-start list/create/inspect/remove checks using the client
runtime identity. A canary's native completion and restart observation remain
separate from definition acceptance.

## Agent workflow

Use the immutable release helper with exactly one JSON object on stdin:

```sh
node "$PI_TELEGRAM_BRIDGE_RESOURCE_ROOT/.pi/skills/schedule-reminders-and-jobs/scripts/jobs-cli.mjs" <<'EOF'
{"operation":"list"}
EOF
```

The host supplies `PI_TELEGRAM_SCHEDULE_CLIENT` as non-secret serialized client
configuration. Do not construct or override it from chat. When present the helper
forwards schedule operations rather than locating a local coordinator. No
endpoint discovery or local fallback occurs on failure. Without either client
configuration or coordinator access, stop and report unavailable scheduling.

`list` returns the grant's prefix, targets, supported job types and up to 20
`{job, revision}` entries (job summaries omit prompts; inspect for full definitions). Follow `nextOffset` with `{operation:"list",offset:N}`.
This is the current saved definition view, not proof of scheduler acceptance.

Create with `expectedRevision: null`:

```json
{"operation":"add_at","id":"ops-example","target":"personal","in":"45m","prompt":"Perform the approved read-only review.","expectedRevision":null}
```

`upsert` accepts a complete cron or at definition, with an explicit target.
Inspect before updates/removal:

```json
{"operation":"inspect","id":"ops-example"}
```

Use the exact returned `revision` as `expectedRevision`:

```json
{"operation":"remove","id":"ops-example","expectedRevision":"<exact inspected revision>"}
```

Unknown fields, fan-out targets, out-of-grant IDs, heartbeat/webhook definitions,
and cross-target replacement are rejected. Only cron/at job fields are accepted.
Edits to unrelated jobs are preserved, including already fired one-time jobs.
Use ordinary coordinator management for heartbeat checkers and watch manifests.
`inspect_handoffs` and `recover_handoff` remain bound to the calling runtime;
they are never forwarded.

Only `publication.status: "accepted"` proves the exact file was accepted.
`pending`, `rejected`, and `superseded` never mean active. Inspection includes
current file acknowledgement plus that job's scheduler `lastRun`/`fired` markers;
these do not prove recipient execution, completion or external effects.

There are no automatic transport retries. A timeout, disconnect or generic
failure may follow a saved edit; inspect the same ID and reconcile before any
new mutation. An absent job after removal establishes current absence only,
not whether admitted work ran. Revisions guard concurrent edits, not exactly-once
external effects. The server redacts underlying errors to avoid leaking private
coordinator details; administrator diagnostics may be needed for a malformed
unrelated definition or storage failure.

## Lifecycle and validation

The listener starts inside the coordinator lifetime lease and drains before the
scheduler stops. A clean stop removes the socket. Restart removes only an owned
stale socket after a refused connection and an unchanged inode; live/uncertain
listeners and non-socket paths fail closed. Keys and grants are loaded once;
revocation/rotation requires coordinated configuration changes and restart.

Tests exercise the production Unix transport, actual coordinator acceptance,
compiled release helper, native config loading and scoped shell environment.
They cover concurrent revision conflicts, filtered reads, unrelated-state
preservation, wrong keys/UIDs, unsafe key files, non-retried disconnects and
saved-but-unacknowledged writes. Local tests use one UID; they do not establish
cross-UID production provisioning, live Telegram delivery or authority migration.
