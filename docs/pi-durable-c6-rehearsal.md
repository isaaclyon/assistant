# C6 parity and offline migration rehearsal

This guide describes the native C6 tools. C7 production rollout remains a
separate operation. C6 does not authorize a production poller, private-state
migration, credential change or service restart.

## Profiles, media and routing

The four full profiles preserve legacy resource selection. Emma keeps protected
browser input. The household group has no browser, Google or places tools.
The builder has session-history search without canonical memory CRUD or core
memory. `/deploy` admits an engineering request through the normal durable
source path; it does not bypass deployment policy.

Only full profiles enable human Telegram attachments. The pinned fork decodes
messages and groups albums. The host journals album members before acknowledging
updates and verifies the chat and actor before downloading. Photon prepares
bounded image blocks, including EXIF orientation. Other files become immutable,
read-only host-verified paths for file tools. PDF text extraction is not automatic.
Voice fails visibly because no legacy transcription provider is configured.
`telegram_attach` copies up to ten authorized files and sends them after final
text settlement. Unknown upload outcomes remain uncertain and never repeat
automatically, including after restart. Canary proof refuses unfinished or
uncertain media output as well as uncertain text delivery.

Artifact bytes expire seven days after settled work is first observed. The host
commits a retirement record before deleting bytes. Pending inbox work, live
conversation tasks and journaled albums protect needed copies. Unknown upload
receipts, source references and conversation history remain durable after byte
retirement. Old document paths can become unavailable; request a new upload.
Startup still verifies all nonretired references and rejects missing live bytes.
Retired historical references do not prevent startup. Private file/source/total
quotas reject excess input visibly. Orphaned failed copies also expire.

Routing is an explicit `routing: {mode: "jev", judgeKeyFile: "/private/key"}`
selection with a separate private key file. Absence means off. It uses the
existing conversation question and threshold after a strict fifteen-minute gap;
provider failure keeps the current conversation. Recall does not enable routing.

## Frozen-copy migration

`src/durable/migration-cli.ts` operates on disposable, stopped copies. It never
starts a Harness, coordinator, poller or provider. Stopped writers are an operator
precondition; filesystem checks cannot prove that another process stays stopped.
The private manifest selects
canonical, runtime-owned assets outside the release. Supported asset kinds cover
memory, history, inbox, receipts, domain stores, jobs, ordinary Telegram profiles,
broker evidence and browser gates. Keep real paths and identities outside Git.

1. Stop the disposable writers and create private frozen copies.
2. Write a mode-`0600` manifest with `version: 1`, `assets`, and optional `inbox` and `receipts` selections.
3. Run inventory and dry-run against the manifest.
4. Inspect the content-free plan and its exact SHA-256 digest.
5. Apply to a new private output directory, then verify the output.

```sh
node dist/src/durable/migration-cli.js inventory --manifest /private/rehearsal/manifest.json
node dist/src/durable/migration-cli.js dry-run --manifest /private/rehearsal/manifest.json
node dist/src/durable/migration-cli.js apply \
  --manifest /private/rehearsal/manifest.json \
  --output /private/rehearsal/output \
  --plan-digest <inspected-sha256> --uncertain quarantine --unaccepted hold
node dist/src/durable/migration-cli.js verify --output /private/rehearsal/output
```

Each asset has a unique `role`, a supported `kind`, and an absolute `source`.
`inbox` selects `{role, database}`; `receipts` selects `{role, file}`. The file
selections are relative to their asset roots. Sources cannot overlap. The tool
refuses writable shared paths, symlinks, hard links, unknown inbox schemas, hot
journals and nonempty WAL files. Inbox inspection bounds both row count and total
payload bytes before loading rows.

A pending legacy row is uncertain by default. A crash can occur after legacy
admission and before inbox removal. Parseable input therefore does not prove
that execution never starts. Assistant text in historical JSONL never proves
that a task or external effect completes.

The receipt input is an explicit operator assertion. Its authority allowlist,
file ownership and payload digest checks do not authenticate its producer.
A terminal or unaccepted classification requires independently verified evidence.
A native-bound row also requires its exact native source fingerprint. The tool
does not export bindings from a live Harness or invent native task checkpoints.

Apply preserves the original asset bytes under `preserved/`. It writes uncertain
and unaccepted payloads to private `held-rows.json`, with content-free accounting
in `reconciliation.json`. It stages only rows with matching native-bound receipts
in `staged-inbox.db`. It binds the complete staged database and reconciliation
files to the completion record. Verification rejects changed bytes, including a
changed payload with the same row count. An interrupted apply verifies retained
copies before continuing; it never overwrites conflicting evidence.

**The output remains held.** `assertMigrationActivatable()` always refuses
executable activation. This tool has no legacy checkpoint importer, resubmission
command or automatic reconciliation operation. Do not install the staged inbox
as a production runtime store. Resolve held work with a separate reviewed
procedure before C7. Existing native stores also reject unknown or unbound inbox
rows before transport, controls, coordinator startup or task execution.

## Immutable release builder

`src/durable/release-build-cli.ts` builds one reviewed full commit from an
explicit repository. The private allowlist is `{version:1,releases:[sha...]}`
outside that repository. The release root must be a separate canonical directory.
The builder does not fetch, reset, clean, select `main`, install a service or
change an existing release.

```sh
node dist/src/durable/release-build-cli.js \
  --sha <reviewed-40-character-sha> \
  --allowlist /private/rehearsal/releases.json \
  --source /source/assistant \
  --release-root /private/rehearsal/built \
  --node-bin /opt/node24/bin
```

The builder verifies the commit and archive identity. It uses a private temporary
home and explicit Node 24 path for `npm ci` and `npm run build`. It bounds command
time, output and archive size, checks runtime/inspector/start-check and broker
support entrypoints, rejects escaping links, and
normalizes release modes. Promotion records a tree digest in
`.digests/<sha>.json` and atomically renames the completed tree. The staged
administrator adapter requires this exact source path and digest record.
A build does not establish runtime readiness or provider authorization.

The builder can run without root. Before administrator preflight, an administrator
copies the selected tree and `.digests/<sha>.json` into a canonical root-owned
staging directory. The administrator verifies the tree against that record and
removes non-administrator write access from every ancestor. The staging path must
remain `<stagingRoot>/<sha>`. Preflight refuses runtime-owned trees or digest
records. Retain the reviewed allowlist with the deployment evidence.

The default command budget is 280 seconds for the complete build. An existing
`.build.lock` requires operator inspection after an interrupted builder; the tool
does not delete a potentially live lock. Approved repository lifecycle scripts run
during installation and building.

## Explicit staged activation

The administrator adapter is `dist/src/isolated-deploy-cli.js`. It extends the
existing isolated topology: one system-managed personal runtime, user-managed
peers and an independently selected trusted broker release. The root-owned
policy and runtime map remain private deployment inputs. The staged path requires
an already migrated Telegram identity; it refuses simultaneous Telegram ownership
migration. The network service creates a root-owned, traversable `/run/netns`
directory on fresh hosts while retaining its private ownership journal.

The map contains `version`, `stageId`, `selectedInstance`, `releaseRoot`,
`brokerReleaseSha`, `observationMs`, `previous`, and `desired`. Each runtime entry
selects `instanceId`, `runtime` (`legacy` or `pi-durable`), and a full `releaseSha`.
Native entries also select an absolute `nativeConfigPath`. A stage changes exactly
one instance to a distinct native release. Every peer keeps its approved mapping.
The broker selection must match its installed release.

The native configuration is a canonical mode-`0600` file owned by its runtime.
Administrator preflight reads it as data and pins its SHA-256 in the rendered
unit. Every daemon and inspector start checks that pin before loading authority.
Isolated broker configurations require a pin. A runtime rewrite therefore fails
on restart until an administrator reviews and installs the new configuration. It binds identity, principal, release,
workspace, state, jobs role and transport to the existing manifest and policy.
An isolated coordinator must select only itself. Candidate code never executes
before the paired checkpoint and startup barrier. The legacy `target-only` jobs
role maps to native `recipient`. The runtime performs full
native schema and provider validation during startup.

```sh
node dist/src/isolated-deploy-cli.js <selected-sha> /built/<selected-sha> \
  stage-preflight /etc/pi-telegram-bridge/isolated-deployment.json - /private/stage.json
node dist/src/isolated-deploy-cli.js <selected-sha> /built/<selected-sha> \
  stage-activate /etc/pi-telegram-bridge/isolated-deployment.json - /private/stage.json
```

Preflight checks each installed runtime against the previous map. A first
legacy-to-native transition also requires a known empty legacy inbox. This check
reads the current WAL snapshot. It repeats after all writers stop, before the
checkpoint, and after selected asset migration, before unit installation and the
startup barrier. Unknown schemas and pending rows refuse activation.
Native-to-native upgrades retain the native source-binding recovery checks.

For a refused legacy inbox, stop its writer and preserve matching private state
and inbox copies before reconciliation. Drain verified work with the legacy
runtime, or preserve and quarantine the stopped inbox under a separate reviewed
procedure. Do not delete rows, infer completion from session text, or resubmit
uncertain work to make the check pass. The staging tool does not perform this
reconciliation or replace the active inbox.

Activation
holds and stops shared writers, verifies quiescence, and captures matching state,
configuration, units and releases. It installs the desired units, records the
irreversible startup barrier, authorizes startup, and checks each runtime's exact
instance, SHA and process ID. Personal readiness also checks the isolated OS
identity. Peers can restart at their existing releases during this sequence.
Failure retains maintenance holds and disables writers. After the startup barrier,
shutdown verification permits native pending inbox rows and preserves that work. There is no automatic
checkpoint rewind after candidate startup.

Root-owned stage and readiness receipts remain under
`<checkpointRoot>/runtime-activation/<stageId>/`. `current.json` records the active
map and the verified digest of each selected release. Later stages recheck peer
and broker trees against those retained digests. An unchanged peer unit must
exactly match the administrator rendering. A retained stage ID cannot be replayed
as a new activation.

## Canary observation and deliberate advancement

Observation is a separate administrator invocation. Its private selection file
contains only `{dispatchId}`. Select an actual scheduled native run created after
initial readiness. An admission-only v1 handoff receipt is insufficient.

```sh
node dist/src/isolated-deploy-cli.js <selected-sha> /built/<selected-sha> \
  stage-observe /etc/pi-telegram-bridge/isolated-deployment.json - \
  /private/stage.json /private/canary-dispatch.json
```

The adapter requires the full observation interval after initial readiness.
It rechecks the installed unit, native configuration and existing Telegram
identity, then holds, disables and stops the selected runtime, and runs its read-only inspector under the selected OS user
with a clean environment. The inspector checks native admission, source binding,
submission identity and completed run state. It refuses uncertain delivery or
blocked task evidence. Inspection does not submit, resume or wait for work.

The adapter then restarts the selected runtime and checks a stable, distinct
process ID at the same release. It re-enables the unit before removing the hold.
It retains completion/restart evidence and its
digest. Repeated observation refuses retained evidence before stopping a runtime.
Observation failure keeps the selected runtime held and disabled. An interrupted
finalization can leave valid evidence and a maintenance hold together. An
administrator must inspect the evidence, unit state and hold before a separate
recovery action; the adapter does not clear that hold automatically.
The broker retains updates while the runtime restarts. A later stage requires
the previous root-owned observation and an exact map chain. Advancing to another
instance always needs another explicit `stage-activate` invocation.

These records prove local native completion and controlled restart. They do not
prove arbitrary external exactly-once effects, Telegram client display or live
provider/browser authorization. The interval measures elapsed wall-clock time
after initial readiness; it does not prove uninterrupted availability.

## Recovery, receipts and shared memory

Pending task upgrades require registered definitions and compatible versions.
Preflight checks both migration availability and a read-only migration attempt
on cloned task data. Missing or throwing migrations stop startup before work
can execute. A non-cooperative shutdown retains the writer lease until ownership
ends; another process cannot open a competing writer.

Legacy and native Markdown mutations share the canonical vault lock and revision
checks. A stale writer fails with `REVISION_CONFLICT`; it cannot replace a newer
write. Retain canonical operation receipts with the vault and its backups.
Git or Obsidian edits do not authorize receipt deletion. No receipt-expiry policy
is enabled until it preserves recovery and deduplication for retained tasks.
Do not restore a vault alone across an accepted operation's receipt boundary.

Household memory confirmations retain the legacy shared-chat authority: either
configured household member can confirm the chat's memory operation. The
requester-only rule applies to the shared `/new` control. Epoch, message and
one-use checks still constrain each confirmation.

## Validation scope

Focused tests cover frozen-copy preservation, held legacy ambiguity, tamper
rejection, startup guards, pending-schema upgrades, shared-vault concurrency,
release building and staged activation ordering. `npm run check:changed` and
`npm run build` pass on Node 24: 149 test files pass, with 1,362 tests passing
and 39 platform/browser tests skipped. The latest inbox, deployment, network and
unit checks also pass: type checking, 45 tests across six files, and a fresh
build. A subsequent four-test inbox check also passes with type checking. It
verifies that selected asset migration cannot bypass the empty-inbox gate.

All four disposable Linux modes pass individually: `builder` (10 seconds),
`happy` (72 seconds), `fail-ready` (65 seconds) and the extended `fail-install`
(44 seconds).
Each mode compiles the native build without a compiler-error bypass and uses a
240-second container execution limit. The actual compiled administrator adapter,
renderers, mixed system/user managers, network namespace, checkpoints and
no-rewind barrier run inside disposable containers.

The rehearsal verifies first-attempt observation, re-enabling after observation,
retained peer/broker releases, and legacy `target-only` to native `recipient`
mapping. Pending and unknown legacy inboxes refuse preflight and activation
before any hold or unit change. A row admitted during shutdown refuses the
stopped-writer gate. A selected asset migration that introduces pending legacy
rows refuses activation after the checkpoint and before unit installation. The
checkpoint and migrated rows remain intact, and the startup barrier stays absent.
A failed native start retains newly accepted pending rows while cleanup verifies
that every writer is stopped and disabled.

The daemon, inspector, broker and Tailscale CLI are synthetic fixtures. They do
not establish live native integration acceptance or Linux execution of the real
native configuration loader. The native configuration tests separately verify
required digest pins, changed bytes and restart checks. Production state, real
credentials, live bot polling and C7 rollout are outside this rehearsal.

### Repeat the offline checks

1. Run `npm run check:changed` and confirm that the check passes.
2. Run `npm run build` and confirm that compilation and import checks pass.
3. Run `scripts/c6-rehearsal.sh builder` and confirm `REHEARSAL OK`.
4. Run `scripts/c6-rehearsal.sh happy` and confirm `ALL PASS`.
5. Run the `fail-ready` and `fail-install` modes separately and confirm `ALL PASS` for each.

Each Linux mode requires Docker and Node 24. The containers use only synthetic
data and repository build output. Run the modes separately within their bounded
execution times. Skipped browser/platform tests and live provider, browser, CLI
and broker acceptance remain separate C6 gates.
