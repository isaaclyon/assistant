# Native background children and temporary retention

The isolated `feat/durable-c5-children` branch adds background research to the
native schedule profile. Each child runs a separate native Harness in its own
process and temporary store. The main Harness records orchestration, terminal
status and a bounded parent report. This implements the approved
[C0 retention contract](pi-durable-c0-contracts.md#d4-preserve-existing-state-guarantees-and-child-retention).
The validation gate remains open. Production activation and private-state
migration remain C6/C7 work.

## Selection and configuration

Select `durable-jobs-children-test` with `jobsRole: "coordinator"` and the same
explicit private configuration required by the
[schedule profile](pi-durable-c5-schedules.md). No additional configuration block
is required. This additive profile selects `native-background-children` and its
own instructions; earlier profiles and instructions keep their selections.

The `background_subagents` tool supports launch, list, inspect, cancel and
collect. Launch requires explicitly listed independent read-only tasks and
returns stable batch/job IDs immediately. Every listed task starts without an
application concurrency cap. Each job receives only its task and explicit
context. The default model is `openai-codex/gpt-6-luna` with high thinking;
requested models and thinking levels must be available in the explicitly
selected provider catalog. An unavailable default requires an explicit allowed
selection. Children use the selected account's private credential/settings
references, with ambient provider credentials disabled.

List exposes status, creation/expiry times and IDs. Inspect and collect return
bounded, untrusted reports for the current authorized instance/principal/target,
including its earlier conversations' batches. Cancellation
first records a request; terminal cancellation follows verified process/store
closure. An ordinary host restart interrupts children and resumes read-safe
unfinished work under the same IDs and deadline. `/new` leaves background work
bound to its original conversation. Background tasks are excluded from ordinary
conversation abort/idle waits; the background tool owns explicit cancellation.

## Execution boundary

Private execution material lives at:

```text
<stateDir>/temporary/background-children/<batchId>/<jobId>/
  manifest.json
  partial.txt
  outcome.json
  cancel.json
  store/                 # process-owned Harness SQLite/WAL/SHM and writer lease
```

The manifest contains purpose, creation time, end condition, original deadline,
explicit task/context and selected provider references. Directories are private;
raw task files use mode 0600. Main orchestration task inputs contain only
`batchId` and `jobId`. Stable launch records commit before spawning. The worker
submits one stable request into the same child store on recovery.

Each worker registers exactly seven replay-safe tools: repository read, list,
literal search and image inspection; public web fetch/search; and a small
runtime snapshot. The existing inspector confines canonical paths to the
selected workspace and immutable resource roots, rejects escaping symlinks and
special/oversized files, and rejects private/local web targets. Discovery,
ambient extensions, shell, general writes, memory, Telegram and nested delegation
are absent. This is process/tool confinement under the trusted OS identity;
it is not a hostile-user operating-system sandbox.

Text tools cap output at 50 KiB; supported images cap at 2 MiB. Private partial
and final reports cap at 64 KiB, and the combined parent report also caps at
64 KiB. The deadline is the original creation time plus 30 minutes, including
after restart. Cancellation/deadline closure has bounded termination grace.
Stdout control traffic caps at 256 KiB, IPC messages are bounded and stderr is
drained without retention.

The supervisor holds a persistent SQLite control lease outside the batch tree
until the child reports acquiring its store writer lease. It signals only its
own live process handle/group. Recovery probes the OS-released SQLite writer
lease before reopening a store. An unknown busy writer holds recovery and
retirement; a recorded PID cannot authorize killing or resuming it. Parent IPC
disconnect interrupts the worker, and a watchdog can exit without inventing a
closed-store receipt. Native close must finish before writing an outcome.

## Completion and delivery

A main native report task waits for all child task receipts and ordinary parent
idle. It commits the bounded report before admission, then submits a distinct
proactive source bound to the original conversation, epoch and destination.
The source fingerprint detects changed payloads, and the stable submission
request ID reconciles admission after a lost acknowledgement. Child completion
does not update the human-idle clock or select the current conversation.

If a native child job task settles without committing a bridge outcome, the
report gate and expiry cleanup reconcile its bridge status to `failed`. They
hold the batch control lease and prove the store has no writer before doing so.
A busy writer keeps the job unresolved; the terminal native task is never rerun.
This lets the parent report orchestration failures and retire their artifacts.

The inline report is sufficient for synthesis after `/new`; old-conversation
tools still fail current-epoch authorization. The parent summarizes once without
further delegation from the completion. Proactive synthesis has final-only
Telegram output and uses the existing `NO_REPLY` and uncertain-send policies.
Native run settlement and external delivery remain separate receipts.

## Retirement and diagnostics

Expiry is batch creation plus seven days. Startup and hourly cleanup require
terminal child jobs, no live supervisor/store writer and no active completion
admission or synthesis. An expired report that failed before admission can be
retired once its task stops. An accepted synthesis remains protected even if
its reporting task fails or is aborted.

Recovery and cleanup share the external batch control lease. Cleanup commits a
main-store expiry tombstone, proves store closure, removes the batch's temporary
files including SQLite/WAL/SHM, then records removal. A crash retries removal
without reopening or relaunching the expired child. Persistent control files
remain outside the removed tree to avoid lock-inode races. Prepared orphan task
configuration receives the same expiry and writer checks. Failed removal holds
that batch and retries after one minute while ordinary host admission continues.
Read-only inspection reports active, retiring and removed counts plus bounded
cleanup holds.

The main store retains correlation/status evidence and the bounded parent
report. Ordinary parent conversation and tool-call history remain retained,
including task/context supplied in the launch call. Temporary child retirement
does not claim to delete that parent history, backups or filesystem snapshots.

## Validation

Focused offline tests cover tool confinement, private artifact validation, real
process supervision, cancellation/deadlines, main-task restart, original-epoch
reporting after `/new`, single synthesis and final-only application delivery.
Retention tests hold real SQLite writers and race the shared control lease;
failed report admission can expire while an active synthesis holds cleanup.

The nine compiled process tests use the production worker and supervisor. They
cover real repository reads, interruption and read-safe restart with one original
request, IPC disconnect before and after startup, cancellation, in-flight deadline
expiry, unknown-writer exclusion and child/main transcript separation. A default
fork test checks the manifest workspace and restricted environment. The pre-start
test waits for an explicit fixture handshake, disconnects IPC, then proves the
production entrypoint leaves the prepared store empty with no model call or outcome.

An actual SIGKILL after the main expiry tombstone commits preserves
`removed: false`. Reopening the host resumes a persisted production job task;
it settles without spawning an expired child. Cleanup respects a held control
lease, then removes SQLite/WAL/SHM without recreation. The persistent control
lease survives removal.

Node 24 strict native typechecking, all **69 tests in seven child suites** and
the build passed together in a 53-second bounded run after faulted-job reconciliation. This includes orphan inventory failure,
post-removal retry and a two-job batch with one busy writer. A separate
`npm run build` passed, including compiled worker and application imports.
No general-tools typecheck repair was added after the scope boundary.

**Full validation remains blocked.** The earlier complete native check reached
its 285-second cap before producing a final summary. Read-only diagnosis found
99 completed suites and serial execution, with no evidence of a hang. The user
retained that cap and declined a longer run. Scoped passing tests do not replace
the full gate; this slice remains unmerged until complete validation and required
CI/review pass.

The first exact-head GitHub CI run completed with 1,167 tests passing, two
inspection tests failing because the Ubuntu runner lacked ripgrep, and three
skipped tests. Its build step was skipped. The native workflow now installs
ripgrep before validation; this supplies the existing inspection prerequisite
without changing the tools or skipping tests. Native typechecking, all seven
existing general-tool tests and the build passed together in a bounded ten-second
local run with ripgrep available. CI on the prerequisite-fix commit `c6022ca`
then passed 1,169 tests with three skipped, plus typechecking and build. Its test
phase took 305 seconds. That evidence predates faulted-job reconciliation; passing
exact-head CI and follow-up review are still required. The older 223-second run
covered the C4 provider slice with 801 passing tests, so it does not establish that
the current full local gate fits the retained 285-second cap.

Independent read-only source review found no material correctness defect in
report deduplication, retention recovery, active synthesis protection or early
disconnect. Test review identified the prepared-directory assertion and missing
orphan/multiple-writer coverage; the added ordinary unit tests cover those latter
paths. Both reviews were static and supply no live acceptance evidence.

A subsequent reviewers-plus-judge workflow identified missing reconciliation for
faulted native child job tasks. Two focused regression tests reproduced the stuck
report and blocked-expiry paths before the fix. They now exercise failure
reporting after writer closure and cleanup when the report task has also faulted.
A follow-up independent judgment and exact-head CI remain required.

All providers and transports are synthetic. This slice establishes no live
provider, Telegram, Linux/systemd, physical power-loss or private-state migration
acceptance.
