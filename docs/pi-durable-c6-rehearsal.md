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

## Instruction-only native upgrades

Instruction and skill wording is separate from schema-2 runtime compatibility.
Tool names, schemas, replay modes, handler/bundle versions, profile and configured
authority remain compatibility gates. The immutable release parent stays bound;
changing the selected child-process release directory alone is not an authority
change. Stored conversation instructions refresh at startup without resetting
history or model/thinking choices.

For an existing schema-1 store, set `instructionUpgradeFrom` to its currently
installed full release SHA in the new private configuration. Preserve all other
configuration except `releaseSha` and `resourceRoot`. Keep the old immutable
release available. The administrator verifies the predecessor map and prior
configuration pin. The runtime reconstructs the old signature from the old
selected instruction/skill text and current versioned tool contracts; a mismatch
still refuses startup. The field grants no permission to change tools or
identity. After migration, later deployments may omit this one-time field.

Before an instruction change, let tasks, submissions, accepted local inbox work,
controls, and external delivery settle under the existing release. Uncertain
outcomes require explicit reconciliation, not deletion. Broker-held updates are
not replayed or discarded by the migration. The host applies the revision and
stored instructions in one commit before transport/schedulers start. The
inspector does not apply an upgrade. A failed startup still retains the existing
maintenance hold and no-rewind boundary; never replace metadata by hand to force
compatibility.

## Delegated scheduling permission upgrades

The separate `scheduleUpgradeFrom: {configPath, sha256}` selector supports only
changes to `scheduleClient` and `coordinator.control` against an exact retained
predecessor. It is mutually exclusive with `instructionUpgradeFrom`, keeps all
other identity/authority/tool contracts fixed, and requires settled native work
and delivery before the transactional metadata/instruction update. Administrator
preflight binds the predecessor to the installed map and its existing pin.
See [delegated scheduling](delegated-schedules.md#settled-scheduling-authority-transition)
for provisioning, the isolated socket-directory exception and self-upgrade order.
It does not enable a general authority migration or rewrite recovery state.

## Canary observation and deliberate advancement

Observation is a separate administrator invocation. Its private selection file
normally contains only `{dispatchId}`. Select an actual scheduled native run created after
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
If no evidence files exist, an administrator can explicitly repeat `stage-observe`
with `{dispatchId,resumeHeld:true}`. The adapter requires the selected unit stopped
and disabled, a private runtime-owned hold matching the active checkpoint, and
unchanged release, unit, configuration and stage identities. It repeats native
inspection before authorizing startup. It never restores a checkpoint or submits
work. A missing or different hold refuses this recovery. Retained evidence still
requires separate reconciliation.
The administrator evidence stores submission IDs as strings. The inspector can
return the SDK's positive numeric record ID; the adapter normalizes that exact ID
before retaining and validating the proof.
The broker retains updates while the runtime restarts. A later stage requires
the previous root-owned observation and an exact map chain. Advancing to another
instance always needs another explicit `stage-activate` invocation.

These records prove local native completion and controlled restart. They do not
prove arbitrary external exactly-once effects, Telegram client display or live
provider/browser authorization. The interval measures elapsed wall-clock time
after initial readiness; it does not prove uninterrupted availability.

## Deployment completion notices

The GitHub workflow checks code; it does not deploy or send deployment notices.
After `stage-observe` has retained valid completion/restart evidence, re-enabled
the selected runtime and removed its hold, the administrator helper sends
`✅ Code deployed: <short SHA> — <instance>` through the policy's single private
engineering bot. It names only the selected instance, not an entirely upgraded
fleet. No job or observation file supplies a destination or message text.

The stage's private `notification.json` records `started` before the HTTP request,
then `confirmed` or `unknown`. An unfinished attempt is unknown, never retried
automatically. A confirmed API response is not proof of client display. Delivery
failures are separate from deployment success: they cannot enter the runtime
hold/stop/restart handler. Inspect the bounded notification status printed by the
helper; a successful command alone does not prove the notice was delivered.

For verified retained evidence whose automatic notification was never attempted,
use the same administrator invocation with `stage-notify` instead of
`stage-observe`, omitting the dispatch-selection argument. This checks the active
map, installed release/config, live readiness and retained completion proof but
never restarts or changes a runtime. Existing confirmed/uncertain receipts suppress
another send. Inspect uncertain outcomes and obtain approval before any separate
manual resend; never delete receipts to force one.

Do not append an ad-hoc success sender to a cutover that already uses this hook.
Standalone utility deployments do not run `stage-observe`: the engineering
assistant must explicitly report their commit, affected components and live
verification itself. A merged-only change must be called **not deployed**.

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
`npm run build` pass on Node 24 after the provider cleanup fix: 150 test files
pass, with 1,366 tests passing and 39 platform/browser tests skipped. The latest inbox, deployment, network and
unit checks also pass: type checking, 45 tests across six files, and a fresh
build. A subsequent four-test inbox check also passes with type checking. It
verifies that selected asset migration cannot bypass the empty-inbox gate.

[Linux CI](https://github.com/isaaclyon/assistant/actions/runs/39159662779) also
passes on `ef836d43`: 151 test files pass and one file is skipped, with 1,398
tests passing and four tests skipped. The run completes in 6 minutes 12 seconds.
The [follow-up CI run](https://github.com/isaaclyon/assistant/actions/runs/39163788343)
also passes on `bd20641`: 152 test files pass and one file is skipped, with 1,401
tests passing and four tests skipped. It completes in 6 minutes 3 seconds.
A separate Linux run on the same source commit passes all 43 tests across the
five protected-browser, private-login, takeover, stock-Chrome and credential-worker
suites, without skips. This includes the two headed observer tests, the real
noVNC takeover test and Linux worker cancellation. That run uses Node 24.13.0,
Chrome 144.0.7559.59 and agent-browser 0.32.2. A first observer run fails because
its temporary socket path exceeds the Unix socket limit. A rerun with a short
`AGENT_BROWSER_SOCKET_DIR` passes. The temporary socket directory is removed.

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

### Live integration evidence

A dedicated full-builder instance uses the real Codex OAuth provider, a separate
native store and ordinary Telegram polling. It delivers three replies and
completes one hosted web request with HTTP 200. It reports no unfinished work or
transport failure at shutdown. The access-only OAuth copy has refresh disabled;
both credential copies are removed after the check. This first run does not
establish `/usage` or priority-tier behavior.

A follow-up full-builder run on `bd20641` passes the actual user-driven controls:
`/usage` returns HTTP 200, `/fast on` produces three priority-tier provider
payloads, and hosted web search returns HTTP 200. Two replies reach Telegram.
After `/fast off`, both the active and saved fast preferences are off. No
unfinished work, transport failure or fatal error remains. The application closes
and the process exits naturally with code 0. Both credential copies are removed.

The native execution environment also runs the real YNAB CLI through the skill's
`~/.bun/bin` fallback. The CLI reports no authentication and refuses a budget
read with HTTP 401. Authenticated CLI acceptance remains open. A separate Messages
check uses the CLI integration test profile, a synthetic recipient and the real
private static page. The draft helper preserves the recipient and body in the
URL fragment, and a clean-page request returns HTTP 200. No message is sent.
This check does not execute the page's JavaScript.

The ordinary provider check exposes a shutdown limit: application cleanup
returns and removes the credential copies, but cached provider sockets keep the
process alive until its outer timeout. The fix tracks the SDK session IDs used
by each native provider. Closing that provider releases only its own session
resources and always closes its credential store, including after cleanup errors.
Regression tests cover both streaming APIs, separate instances, sessionless calls,
repeated close and cleanup failure. An independent source review finds no material
issue. A separate real Codex request creates one WebSocket without SSE fallback;
provider close returns and the process exits naturally with code 0 in six seconds.
Its credential copies are removed. The later browser check below closes real
broker, Mini App and credential approval/copy acceptance.

A real restricted-broker instance also starts on a separate ephemeral Tailscale
node. The native browser opens and inspects the synthetic HTTPS sign-in form,
and the instance receives a real Telegram request. It delivers two replies and
exits naturally with no unfinished work. Three private-login attempts return
`browser_blocked`; the broker records no approval request. The safety gate stays
enabled. This run does not prove successful sign-in, credential approval/copy or
Mini App takeover. The later bounded check below resolves those browser gates;
authenticated CLI acceptance remains open.

An offline source review identifies two failure paths: an existing crash gate,
and uncertain observer disconnection or page protection that retains the gate.
Stubbed observer failures reproduce the second path without a browser or secrets.
Opt-in [host-only diagnostics](private-browser-input.md#host-only-failure-diagnostics)
now distinguish setup and cleanup failure phases using content-free metadata.
Regression tests cover phase reporting, privacy, callback failures and gate
retention. The full Node 24 check passes 151 files and 1,379 tests, with 39
platform/browser tests skipped; the build also passes. The independent source
review finds no material defect. This does not establish the cause of the live
failure. The later live check uses these diagnostics with separate authorization.

A separately authorized 45-minute browser check runs the full native builder on
`6c2dcca` with the real provider, restricted broker and an ephemeral test node.
The first protected login fails at `page-protect`, followed by
`cleanup-unprotected-page`; observer disconnection completes. No approval or
site submission occurs in that attempt. The exact cause remains unproven.

A private configuration change gives the native observer and protected operation
one short `browser.runtimeDir`, without a harness-only
`AGENT_BROWSER_SOCKET_DIR` override. The immutable configuration guard correctly
refuses the changed configuration against the earlier state. A fresh test store
with the matching configuration then passes; no public source change is needed.
This validates the consistent-runtime setup without proving the earlier cause.

The paired user approves the synthetic credential with **Always Allow**. The
broker records one delivered approval and one credential copy. The site records
one successful sign-in and no failed sign-in. Private login returns `submitted`
with `copiedCredentialItem`; takeover returns `handed_back` after the user's
**Hand back** action. Matching native browser tool results confirm the signed-in
marker and sign-out link after both login and private handback. External helper probes
with empty output are excluded from this proof. Submission status alone is not the authentication evidence.

The native application delivers one final reply for one human request, with
seven provider payloads, no unfinished work and no fatal or transport error.
The process exits naturally with code 0. These results close the live browser,
restricted-broker, credential approval/copy and Mini App acceptance gates.

All owned resources are retired before the 45-minute limit. Explicit stock-helper
status and stop checks verify that both test browser runtimes stop; owned
observer sessions are closed. The application, broker, site and test node have
no remaining processes. The three dedicated proxy mappings and temporary
loopback address are removed, and the node logs out. Credential copies, browser
state and node state are removed. Both synthetic vaults are deleted with absence
verified. The production proxy mappings retain their original targets. The test
service account has a one-hour expiry; early revocation is not claimed.

Exact-source [Linux CI on 6c2dcca](https://github.com/isaaclyon/assistant/actions/runs/39166498677)
reports 1,412 passing tests, four skipped tests and two failures in
`tests/protected-browser.test.ts`: `Test Chrome did not start` and a timeout.
The CI build is skipped after the test failure. A separate
[repeat run on d71933e](https://github.com/isaaclyon/assistant/actions/runs/39175769662)
passes 153 files and 1,414 tests, with four tests skipped; its build also passes.
The original CI failure is intermittent. A dedicated Linux baseline passes all
19 protected-browser tests without reproducing it; the exact cause remains unproven.

The synthetic Chrome fixture now waits for an actual CDP connection, not only a
port file. It retries readiness within one 30-second startup deadline. Partial
port files and early endpoint refusals do not trigger protected actions. Failure
reports include the exit state and at most 2 KB of startup stderr, captured
before input is inserted. Cleanup bounds SIGTERM and SIGKILL waits. The 60-second
test limit leaves room for startup and assertions. These changes affect tests only.

Nine deterministic regressions cover cold startup, partial files, endpoint retry,
spawn/exit failures, late connections and bounded cleanup. The dedicated Linux
check passes those nine tests and all 19 real-browser tests without skips.
An independent source review finds no material defect. The full local check
passes 152 files and 1,388 tests, with 39 platform/browser tests skipped; the
build also passes. C6 remains unaccepted pending authenticated native CLI acceptance.

Check `tailscale serve status --json` before choosing a private test endpoint.
The text status can omit foreground configurations. The occupied-port guard
refuses the existing foreground mappings before any network change.

### Separately authorized one-bot production trial

A separately authorized personal-bot trial activates immutable native release
`7d1ebb6`. The first attempt reaches its command limit before native startup.
A matching pre-start restore precedes the successful guarded activation.
The paired checkpoint and selected external backups verify before
startup. All twelve existing jobs load, and the pause configuration and webhook
secret remain unchanged. The engineering peer and broker retain their existing
legacy release. This trial does not authorize another runtime transition.

The scheduled canary reaches native admission, run completion and submission
completion. Stopped inspection verifies that exact work. A controlled restart
then reaches stable readiness with a distinct process ID at the same native
release. The retained observation and root evidence cross-check successfully.
The runtime, peer and broker are active and enabled with no maintenance hold.

The first observation exposes an administrator checker mismatch: the SDK returns
a numeric submission ID, while the evidence validator expects a string. Reviewed
administrator helper `4e5acda` normalizes that exact ID and explicitly resumes the
matching held observation. It repeats inspection before startup and retains the
restart evidence. The production native release remains `7d1ebb6` throughout;
observation recovery does not rewind the checkpoint or resubmit work.

The fix passes type checking, 1,392 tests and a build, with 39 platform/browser
tests skipped. A focused 34-test check also verifies the real native inspector's
proof through the administrator parser. An independent read-only safety review
finds no material issue. The user confirms an ordinary personal-bot reply.
Read-only native evidence also verifies two completed human-message submissions.
This completes the limited one-bot production trial. The user explicitly skips
authenticated YNAB acceptance for the current scope. No authenticated YNAB
validation is claimed. This scope decision does not authorize fleet advancement,
legacy retirement or a branch merge.

### Repeat the offline checks

1. Run `npm run check:changed` and confirm that the check passes.
2. Run `npm run build` and confirm that compilation and import checks pass.
3. Run `scripts/c6-rehearsal.sh builder` and confirm `REHEARSAL OK`.
4. Run `scripts/c6-rehearsal.sh happy` and confirm `ALL PASS`.
5. Run the `fail-ready` and `fail-install` modes separately and confirm `ALL PASS` for each.

Each Linux mode requires Docker and Node 24. The containers use only synthetic
data and repository build output. Run the modes separately within their bounded
execution times. The separate Linux browser run closes its 43 selected platform
checks. User-driven provider controls and natural shutdown also pass.
Authenticated YNAB acceptance is skipped by user decision for the current scope.
