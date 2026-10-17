# Pi-durable migration plan

Status: approved architecture and checkpoint sequence; implementation has not started.

The user approved the durable-only extension strategy, chat-and-memory MVP, retained hosting and Telegram experience, target architecture, and C0–C7 sequence. This plan records intended work; it does not describe implemented behavior or supersede existing ADRs until their replacements are accepted.

## Outcome and agreed scope

Migrate the assistant from `pi-coding-agent`'s `AgentSessionRuntime` to native `pi-durable`. Use durable submissions, tasks, documents, and recovery where they replace fragile process-local coordination. Preserve existing assistant capabilities and private data.

User-selected scope:

- Native pi-durable extensions. Supporting the old wrappers in ordinary Pi sessions is not a final-state requirement.
- First usable MVP: Telegram chat and controls, memory CRUD, core/automatic recall, memory search, and conversation-history search.
- Keep Node/systemd hosting, instance and broker isolation, and familiar Telegram flows. Hosting changes and broader UX redesign are out of scope.
- Plan and approval checkpoints first. Live rollout is a later, explicit checkpoint.

Other exclusions: moving every domain store into Harness storage; rewriting the Google/places/memory/browser domain implementations; a universal coding-agent extension compatibility layer; importing old in-flight JavaScript execution; making arbitrary external actions exactly-once; new cloud services or a generic workflow platform.

Research baseline: assistant commit `bf7e4e8`; Pi packages pinned at `0.87.1`; pi-durable release `1.3.0` at `71023aec1546d6d677a65669c5665c0927ce0dd0`. Revalidate versions at C0. Main-branch APIs are not assumed available in that release.

## Target architecture

1. **One native Harness and SQLite store per assistant instance process.** Retain separate operating-system identities, workspaces, private state roots, capability profiles, and broker ownership. Conversation ownership is execution structure, not authorization. Enforce one writer for each Harness store.
2. **A focused Telegram runtime adapter in the pinned fork.** Reuse Telegram rendering, media, menus, sections, and callback handling where possible. Replace its dependency on coding-agent session/context/lifecycle APIs through an explicit host interface. Preserve the pinned dependency and review changes under ADR-0002; do not vendor it or emulate all of ExtensionAPI.
3. **Native extension bundles around shared domain services.** Replace tool registrations, result envelopes, hooks, commands, and lifecycle management. Keep canonical Markdown and existing application databases. Load only profile-selected resources before module execution, with canonical-path checks. Skills and instructions remain explicitly selected resources.
4. **Durable input identity and execution.** Bind each accepted source event to its authorized origin, original timestamp, conversation, and submission. Reuse stable request IDs on retry. Conversation rotation cannot remap an already accepted event. Keep transport acceptance, Harness admission, run completion, and external delivery as distinct facts.
5. **Durable delivery tracking.** Record intended final replies and their destination, recover missing delivery work by scanning authoritative completed submissions/entries, and retain send receipts. Streaming watches improve responsiveness but are not the delivery ledger. A lost send acknowledgement produces an uncertain outcome governed by an explicit reconciliation policy.
6. **Explicit operation and approval recovery.** Every tool has a documented replay policy. Reads may replay after review; mutations use operation-specific idempotency/reconciliation or stop as interrupted. Persist approval requests and authenticated decisions, then execute authorized operations through durable work. Keep credential approval authority in the trusted broker. Do not assume a built-in durable human-input pause API exists.
7. **Native background ownership.** Use durable tasks and owned conversations for assistant execution, child completion reporting, cancellation, and progress where appropriate. Keep cron/calendar trigger calculation, checker adapters, and cross-instance delivery policy as application responsibilities. Remove redundant custom state only after an equivalent durable path passes its gates.
8. **Versioned history and upgrades.** Preserve old JSONL archives and their exact citations. Add a new history source for durable entries, with stable anchors and principal filtering. Version task/document schemas, inspect blocked recovery, and define how pending work crosses releases. Reset/compaction are not storage deletion.

### Alternatives considered

- **General compatibility shim:** potentially fewer first edits, but would reproduce session managers, synchronous IDs, commands, UI contexts, and lifecycle behavior that Durable does not provide. Rejected as the target architecture.
- **Fresh assistant rewrite:** maximum freedom but recreates working domain capabilities and expands regression risk. Rejected.
- **Native runtime with focused adapters and reused services:** approved. Extra infrastructure is limited to input/delivery/operation records needed to demonstrate crash recovery and preserve existing authority.

## State ownership

| State | Target owner and migration treatment |
| --- | --- |
| New conversations, inputs, run/tool/child state | Harness SQLite, native records/tasks/documents |
| Telegram source identity and conversation binding | Host durable records; atomic with admission where public APIs permit, otherwise recoverable through stable identity |
| Accepted input awaiting Harness admission (`inbox.db`) | Retain the host inbox as the acceptance front buffer during transition. Harness admission becomes authoritative after a durable admission receipt; only then remove the pending inbox row. C0 defines the reconciled handoff and stable identity. Retire the buffer only after direct durable admission before offset advancement is proven and every legacy pending row is accounted for. |
| Final reply intent and delivery receipt | Host durable delivery records/tasks; independent of stream listeners |
| Ordinary approvals/drafts and mutation outcomes | Typed operation records with actor/target/revision/expiry bindings; reuse application executors |
| Ordinary-fleet bot token, upstream offset and polling lock | Pinned pi-telegram adapter; preserve named profiles in private `telegram.json` and `locks.json`. The native host retains ownership monitoring, valid external Pi owner handling and stale-owner recovery. |
| Isolated-deployment credential approvals, bot token and upstream offset | Existing trusted broker; never delegated to Harness authority. The runtime adapter uses only the restricted transport. |
| Canonical memories | Existing private Markdown vault and existing scope/revision rules |
| Places, Google cache/metering, other domain stores | Existing private databases; no unrelated data migration |
| Job definitions/checker observations/occurrence identities | Existing coordinator-owned sources initially; replace individual execution-state layers only after parity |
| Old session history and memory citation anchors | Retained read-only JSONL archives and legacy reader |
| New history search | Derived index over durable entries plus legacy archives; rebuildable, privacy-filtered |
| Browser state, gates and cleanup ownership | Existing protected-browser infrastructure, with new host lifecycle adapter |
| Temporary tasks and products | Private external configuration under existing temporary-task conventions |

The same data need not be written to multiple competing execution journals. For every transitional duplicate record, document which one is authoritative and the condition for retiring the other.

## Transition contracts to settle at C0

The ordinary deployment currently builds one immutable release from `main`, stops the fleet, and activates all configured instances at that release. Sequential startup is not an observed canary rollout. C2–C6 development and the C7 observation window therefore require an explicit release and activation strategy before production host replacement begins.

C0 must choose and record:

- **Code and runtime coexistence:** whether unfinished native work stays on an isolated branch/dependency tree or ships alongside the legacy runtime behind explicit per-instance selection. Specify how the dedicated C3 instance runs, how ordinary production receives fixes, and how only a selected canary changes runtime while other instances remain on their approved runtime. A long-lived branch alone does not provide staged production activation; either strategy must supply a tested C7 activation path. Temporary legacy support ends after C7.
- **Dependency compatibility:** the current aligned set is `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui` at 0.87.1. The 1.3.0 durable package requires `pi-ai`, `chord`, and `pi-codemode` at 1.3.0. Decide whether to upgrade the legacy set first under [the existing upgrade gates](pi-upgrades.md), or isolate dependency trees with explicit package/load boundaries. The current compatibility test also checks nested SDK versions. Any successor to that gate must preserve equivalent checks for each supported runtime; adding an incompatible nested SDK is not a passing transition. Depending on the codemode package does not select its optional user-facing capability.
- **Ongoing upgrades:** retain grouped exact-pin review for the production runtime and identify who reviews weekly Dependabot PRs during migration. Record any deferral under the existing upgrade policy, carry relevant fixes into the migration branch/tree, and define the candidate runtime's exact-pin group and compatibility checks before it ships. Do not silently freeze updates for the migration's duration.
- **Mixed-fleet jobs:** define compatibility for the version-1 `job-handoffs/` publication, acceptance, completion and cancellation records. Specify which coordinator/recipient runtime combinations are supported during rollout and how duplicate dispatches and unknown schema versions behave. If a combination is unsupported, explicitly quiesce and preserve its work until both ends are compatible. Do not infer acceptance from the other runtime's transcript.
- **MVP configuration:** name the dedicated test capability profile and its selected extensions, skills, instructions, shell/file/web tools and feature flags. Include the chat/memory behaviors required by C3, and keep integrations awaiting C4/C5 unselected. Keep live instance identities and credentials in private configuration.

These are required C0 decisions, not claims that coexistence, package compatibility or canary activation already works. The chosen contracts feed C1 feasibility checks, C2 packaging and lifecycle work, C5 handoff tests, and C6 deployment rehearsal.

## Checkpoints and dependency order

```text
C0 Contract inventory and design
  -> C1 Feasibility pilot
  -> C2 Production runtime foundation
  -> C3 Chat-and-memory MVP
       -> C4 Remaining integrations and private browser workflows
       -> C5 Durable schedules and background agents
  -> C6 Full parity and migration rehearsal
  -> C7 Production rollout and retirement
```

C4 and C5 can proceed independently after C3 when file ownership is coordinated. C6 requires both. Testing is part of every checkpoint; C6 is the integrated acceptance and operational rehearsal.

Each checkpoint records deliverables, passing evidence, unresolved failures, and a go/rework/stop decision. A checkpoint does not pass with a partial implementation or a waived material regression. Keep live identities, credentials, dumps, and task-specific operational evidence outside the repository.

### C0 — Contract inventory and design

**Deliverables**

- Inventory all 14 selected extension resources, their tools/commands, skills and instructions, external dependencies, and 11 install patches.
- Map each existing behavior/test and owning ADR to its native owner and checkpoint, using full ADR filenames where numbers are reused. Distinguish implemented capabilities from prototypes and only preserve configured/supported behavior.
- Inventory state by owner, durability meaning, retention rule, writer, migration need, and recovery procedure.
- Resolve each [transition contract](#transition-contracts-to-settle-at-c0). Inspect release APIs, provider/auth changes, schema compatibility, and Telegram fork changes.
- Define the Telegram adapter surface: admission, steering/follow-up, final settlement, abort/new/compact, model/thinking, commands/sections, media, and target-scoped output. Cover ordinary polling/config/offset/lock ownership and isolated broker transport separately. Specify the existing five-second ownership monitor, valid external Pi owner handling, stale-heartbeat recovery and reconnect behavior.
- Define source IDs, conversation rotation, delivery outcomes, approval/operation records, and tool replay policy. Identify required atomic transactions versus explicitly reconciled cross-store boundaries. Specify the inbox-to-Harness receipt and retry protocol, including a crash after admission but before inbox removal, and the proof required before retiring the front buffer.
- Define the failure model: process kill, storage failure, host/power loss, and external delivery have different guarantees. Release 1.3.0's default SQLite WAL/NORMAL protects process-crash recovery but can lose newest acknowledged commits on host/power failure. Preserve stronger existing ledger guarantees; prove a supported stronger storage configuration if acceptance requires it.
- Define approval invalidation per operation. Approved behavior: an ordinary process restart may rehydrate an unexpired request in the same conversation epoch. Preserve explicit `/new`, reload/reset, expiry, stale revision and failed-delivery invalidation where the current operation requires them. Persistence never extends authorization.
- Decide the storage retention approach before moving existing seven-day subagent cleanup into append-only Harness history.
- Establish synthetic fixtures, failure-injection points, and current performance baselines using disposable state.

**Pass gate:** every current capability, durable record, and patch has an owner and disposition; no unspecified authority, input identity, or storage-retention boundary remains hidden in the implementation estimate. Each [transition contract](#transition-contracts-to-settle-at-c0) has a recorded decision, implementation owner and acceptance cases. Both Telegram transport modes and inbox handoff/retirement have explicit owners and acceptance cases.

**Decision:** approve the detailed contracts and release pins for the pilot. Accepted ADRs remain in force until an explicit successor is approved.

### C1 — Feasibility pilot

Use an isolated dependency tree, private disposable state, and a dedicated test Telegram destination. Do not open production stores or start a second poller for a live bot.

**Build/prove**

- Minimal Harness open/resume/close with SQLite, selected instructions, one read tool, and deterministic fake model/tool transports for repeatable tests.
- The intended provider integration: credential-store adapter, refresh coordination, model catalog, thinking settings, correct prompt/tool serialization, and one authorized real request when credentials are available.
- A thin Telegram adapter through the pinned fork: input, streamed preview, final answer, origin tracking, restart, and a direct callback. Exercise ordinary polling/offset/lock ownership with synthetic fixtures, including an external Pi owner and stale-lock recovery; exercise the restricted broker-shaped transport separately. No live polling contention is needed for these checks.
- Stable source-to-conversation mapping and retried submission; preserve original input time. Exercise inbox persistence before offset advancement and reconciliation after admission succeeds but pending-row removal is interrupted.
- Simulated external operation with an operation key; kill after effect success but before result commit and reconcile without repeating it.
- Persisted approval request and callback decision across restart; a replayed/wrong-user callback cannot trigger another mutation.
- Recovery of a completed answer whose delivery listener never ran; distinguish retryable send failure from ambiguous send acknowledgement.
- Read a legacy session fixture through the current history/provenance contract.
- Confirm a restricted profile cannot acquire another profile's tools or resources through recovery or a child conversation.

**Representative crash traces:** one accepted input resumed through a read tool; one simulated mutation whose effect succeeded before its result was recorded; one committed answer missed by its delivery listener; and an approval/replayed callback across restart. Test an ambiguous Telegram send with a fake transport. The exhaustive boundary matrix belongs to C2 onward; the pilot must not become a miniature full migration.

**Pass gate:** these traces match the stated policy; no accepted synthetic input disappears; source retries reuse one submission; committed tool work is not needlessly repeated; uncertain external work is never reported as verified success; intended provider and Telegram integration are demonstrated.

**Decision:** go, revise the adapter/provider approach, or stop before building C2 infrastructure. If provider credentials are unavailable, mark that proof blocked rather than calling the pilot complete. Re-estimate later checkpoints from measured work. Identify explicitly which pilot code is reusable and which is discarded; promotion requires tests and lifecycle ownership.

### C2 — Production runtime foundation

**Deliverables**

- Implement the native host construction and lifecycle under C0's coexistence strategy. Establish its packaging, dependency isolation or approved legacy upgrade, and instance/runtime selection before replacing production host construction. Keep same-workspace restart behavior and dedicated private state/history roots.
- Native registry, schema conversion, tool result conversion, explicit skill/instruction loading, profile isolation, and lifecycle cleanup. Replace process-local session assumptions with explicit instance/conversation references.
- Production provider/auth adapter and exact dependency pins with C0's runtime-specific compatibility gates; preserve authorized accounts and per-instance settings. Audit source patches before removing them. Verify the legacy production path remains usable while the native runtime is incomplete.
- Implement both transport ownership contracts and the inbox admission/receipt protocol. Test valid external poller ownership, stale-owner recovery, restart with pending input, and deduplicated admission when a committed receipt precedes inbox cleanup.
- Persisted source admission and origin mapping; serialize rotation with queued input; bounded cancellation and shutdown; specified outcomes for restart, abort, `/stop`, `/new`, and automatic rotation. Cancelling a wait does not cancel durable execution; native conversation abort may withdraw queued inputs. Adapt these deliberately to Telegram controls rather than equating the APIs.
- Final delivery intent/receipt/reconciliation path with stable destination and proactive `NO_REPLY` handling. Define which streamed updates are best effort.
- Operation-record and direct-confirmation mechanisms needed by memory; revalidate authority inside execution/recovery, not only in a pre-tool hook.
- Recovery inspection for pending/blocked/interrupted/uncertain work, schema versions, release compatibility and missing definitions. Resume only after registry, policies, and transport bindings are ready.
- Crash harness and contract tests reusable by every extension. Measure overhead relative to C0 baselines; investigate meaningful latency/storage regressions.

**Pass gate:** foundation passes the expanded crash matrix in the production host shape; both transport ownership paths and inbox admission reconciliation pass; the selected dependency strategy passes compatibility checks for each supported runtime; one writer and trusted transport remain enforced; no unselected module executes; failed-run queued-input behavior is explicit and tested. Fatal storage errors mark the instance unhealthy, stop new durable-acceptance acknowledgements, and exit within the existing bounded shutdown policy even when tool code ignores cancellation. Restart cannot overlap another writer.

### C3 — Chat-and-memory MVP

This is the first usable assistant checkpoint, on a dedicated test instance using the capability profile and explicit skill/tool selection approved at C0. Run it through C0's release/dependency strategy while production retains its approved runtime. Production cutover remains C7.

**Deliverables**

- Telegram text conversation, streaming/final rendering, buttons/sections, model/thinking selection, new/abort/compact, reload/restart, skills listing and `/debug` for MVP tool activity, lifecycle, core/date context and recall. Preserve target scoping, redaction and bounded output; extend diagnostics as later integrations arrive.
- Native `assistant_memory` with existing CRUD, draft duplicate review, revisions, append/list behavior, user approval rules, and safe recovery for mutations and confirmation delivery.
- Native core memory, date context, automatic recall/proposals and memory usage/decay behavior. Maintain current feature flags and per-principal filtering.
- Native memory/session search, bounded session-context reads, and index maintenance. Preserve legacy citations; index new durable conversations with a stable source locator understood by search, context expansion, and provenance lint. A small backend discriminator/resolver is sufficient; do not convert the old transcript archive.
- Compaction-aware recall deduplication, stable incoming timestamps, and hidden context that is neither sent to Telegram nor accidentally indexed as user history.
- Preserve the configured shell/file/web capabilities selected in C0's MVP profile, with explicit replay policies. Keep unfinished integration skills/tools unselected until their supporting checkpoint passes.
- Ordinary memory confirmations follow C0's epoch, expiry and invalidation rules. Already consumed operations cannot rerun because reply rendering failed.
- Cover real memory executor effects: creation/update can finish replacing Markdown before the durable tool result exists, and optional Git commit is a separate effect. Add narrow operation receipts and reconciliation without introducing another canonical memory database.

**Pass gate:** ordinary conversation and the complete memory lifecycle work end to end; recall and history remain correct after compaction/new/restart; memory permissions hold across all relevant profile fixtures; repeated model requests do not duplicate context injection. Inject failures after Markdown replacement and before/after optional Git completion: no duplicate note or false success is possible, and unresolved outcomes remain explicit. Both an old cited note and a new durable-history citation resolve after restart, reset/compaction and index rebuild within the same visibility bounds.

**User checkpoint:** try the dedicated instance and confirm chat/memory behavior is useful and familiar. Record gaps before extending scope.

### C4 — Remaining integrations and protected browser workflows

Implement in this order, reusing domain code:

1. **Read-oriented integrations:** Google Calendar/Gmail/Contacts/Places reads, cache/metering, CLI-backed skills, weather and public lookup. Port schemas, bounded transports, outputs, and feature selection.
2. **Direct Telegram applications:** places ranking/menu flows, durable comparison progress, callback routing and model-to-section handoff.
3. **Guarded mutations:** Calendar create/update/delete and places destructive actions. Carry stable operation identity, current revision checks, explicit confirmation policy and ambiguous-outcome reconciliation through restart.
4. **Protected browser operations:** private input, multistep login, OpenTable adapter, email verification, takeover, and approved credential delivery. Preserve the current browser gate and private data boundary.
5. **Provider and operator parity:** web tool behavior, fast-mode control, subscription usage reporting, diagnostics for newly ported integrations, deployment controls, and profile-specific command visibility. The `/debug` command and MVP diagnostics already belong to C3.

Classify each tool operation separately: a mixed read/write tool must not be declared replay-safe just because its read operations are harmless. Existing external idempotency/revision limits remain documented.

Browser recovery is a separate acceptance boundary. A surviving browser process does not prove a web action completed. Reconnect only to an authenticated, still-owned operation when proven safe; otherwise retain the protection gate, perform verified cleanup, and return interrupted/expired. Do not serialize credentials or promise arbitrary browser stack resumption.

**Pass gate:** all configured integration operations behave as before; stale/wrong-user/wrong-chat/replayed callbacks fail; success followed by delivery failure cannot repeat a mutation; browser tools exclude ordinary agent access across entry/restart/cleanup; credentials stay outside model context; broker transport cannot fall through to direct bot access.

### C5 — Native schedules and background agents

**Deliverables**

- Preserve canonical job definitions, cron/at/webhook semantics, heartbeat rules, checker cursors, temporary price-watch manifests, cancellation tombstones and occurrence identities.
- Map each materialized recipient occurrence to a stable conversation/submission. Replace preflight uncertainty with durable acceptance evidence where possible; preserve uncertainty for historical claims without proof.
- Use native tasks for recipient execution tracking and completion reporting. Keep coordinator publication and recipient acceptance distinct across instances; no implicit cross-instance privileges. Implement C0's handoff compatibility policy and test every supported legacy/native coordinator-recipient combination for publication, acceptance, completion, cancellation, duplicate dispatch and restart. Unsupported combinations must hold work explicitly without losing occurrence identities.
- Retain one-shot late delivery, existing missed-cron policy, `NO_REPLY`, human-idle rotation rules and original target routing.
- Port background agents to native task/conversation ownership, explicit read-only loadouts, limits, cancellation, progress and persisted completion reporting. Preserve execution confinement and process control where the current boundary requires it.
- Model foreground and background ownership explicitly: human abort, batch cancel, process restart and parent rotation have different effects. Report into the recorded destination using stable completion identities and the delivery ambiguity policy. A late report must not enter a newly selected unrelated conversation. Native submission deduplication does not make a Telegram send exactly-once.
- Evaluate native codemode as a separately gated follow-on if selected for assistant tool composition, with replay journal, nested-tool policies, deadline and upgrade compatibility tests. It is not a C5 or cutover requirement unless explicitly added to scope.
- Implement the C0 retention decision for temporary child transcripts and completed task records; cache limits are not deletion. Verify cleanup before retiring the existing seven-day behavior.
- Remove old batch/acceptance recovery records only when their replacement is authoritative, migrated and tested. Keep legacy occurrence terminal identities.

**Pass gate:** scheduled and child work recover across process restart; supported legacy/native handoff combinations pass and unsupported combinations hold work explicitly; no completed fan-out recipient or parent completion submission is repeated; external report delivery follows the stated ambiguity policy; cancellation and parent-idle behavior match the contract; late reports retain their intended conversation and target; no child gains unselected capabilities; unsupported historical uncertainty is quarantined for explicit resolution; temporary-state retention is effective.

### C6 — Full parity and migration rehearsal

**Deliverables**

- Close every row in the capability/patch matrix across all four profiles. Finish media/voice/attachment and household routing parity, plus all operational commands and supported browser/CLI workflows.
- Test concurrent human input, scheduled work, `/new`, callbacks and child completions. Verify no wrong-destination delivery or cross-principal context.
- Exercise retry, failed runs with queued input, compaction, cancellation, blocked task versions, disk/storage failures and non-cooperative shutdown. Exercise interrupted codemode only if the optional C5 follow-on was explicitly added to scope.
- Build migration inventory/dry-run/apply checks using disposable copies: preserve memory/domain stores, archives, pending inbox and admission receipts, job identities, ordinary Telegram profiles/offsets/locks, broker offset/approval evidence, and browser gates. Verify every legacy pending input is accounted for before retiring its store.
- Classify old work: proven terminal, proven unaccepted, or uncertain. Do not manufacture durable task checkpoints from old session text. Resolve/quarantine uncertain claims before opening new execution.
- Rehearse upgrades with pending tasks and old schema versions. Check storage ownership, disk growth, retention, backup/restore and exact-release readiness.
- Implement and rehearse C0's staged activation path using disposable instances and the target service topology: select only the intended runtime transition, observe the canary across restart and scheduled work, then advance deliberately. Verify the remaining instances retain their approved runtime/state, all supported mixed-runtime handoffs work, and unsupported work remains held. Preserve coordinated maintenance holds and startup barriers for shared writers; the existing whole-fleet deployment command alone does not satisfy this gate.
- Update ARCHITECTURE, successor ADRs, fleet/recovery runbooks, capability documentation and Pi upgrade gates to describe implemented behavior.

**Pass gate:** full capability matrix passes; no unresolved migration ambiguity is silently replayed; a complete offline rehearsal preserves references and accepted-work evidence; staged activation demonstrates an observed canary and deliberate advancement with mixed-fleet work accounted for; target Linux/systemd/broker acceptance passes; release checks and build pass.

### C7 — Production rollout and retirement

**Deliverables and order**

1. Prepare a private operational inventory and explicit instance rollout order using C0's activation strategy proven at C6. Select the first canary using a representative, bounded workload rather than assuming the privileged builder is lowest risk. Notify affected users of personal and shared instances of the maintenance window, expected interruption and completion/hold status channel. Record the recipients in the private operational inventory. The existing engineering-only deployment notification does not replace these notices.
2. Stop/quiesce affected old runtime, scheduler and broker writers as required by the deployment topology. Take a matching application/state checkpoint and enforce the existing maintenance hold.
3. Run migration preflight, preserve the startup barrier, activate exactly one new writer/poller, and verify instance/release/PID readiness.
4. Confirm authorized ordinary chat, memory, history, job delivery, browser protection and restart behavior on the canary. Compare recovery diagnostics, latency, storage growth and user-visible delivery against C0 baselines.
5. Observe the canary for an agreed evidence-based interval covering scheduled work and at least one controlled restart; then roll out one instance at a time. Repeat ordinary-poller, broker and mixed-runtime handoff checks where topology differs. Notify affected users when their instance is verified or remains on hold.
6. After all profiles pass, remove old coding-agent wrappers/runtime dependencies, obsolete fork patches, unused globals and redundant recovery paths. Keep any remaining SDK dependency only for an explicitly documented supported use.
7. Retain historical JSONL and citation readers, canonical data and occurrence identities. Archive migration evidence privately; mark this plan complete with links to implemented owners and acceptance evidence.

**Recovery rule:** before candidate startup, matching state/code restoration may follow the existing runbook. After the startup barrier/candidate execution, hold and reconcile or repair forward; never rewind accepted work or run an old binary over incompatible new state.

**Pass gate:** all intended instances use the native runtime, all selected capabilities pass, no duplicate owners remain, known pending/uncertain work is accounted for, and the old runtime can be removed without losing supported behavior or historical evidence.

## Extension and compatibility disposition

| Current resource | Native disposition | Checkpoint |
| --- | --- | --- |
| `core-memory` | Native prompt section using current scoped compiler | C3 |
| `search` | Native search tools and explicit durable turn-preparation/context handling | C3 |
| `memory` | Native CRUD wrapper; durable draft/confirmation/operation state around existing executor | C3 |
| `reload`, `restart`, `skills`, `debug` | Host/Telegram commands and MVP diagnostics with explicit lifecycle ownership; extend diagnostics with later integrations | C2–C3; integration coverage C4 |
| `places` | Native tool plus direct sections/callbacks; retain ranking/application store | C4 |
| `google-workspace` | Native typed operations; retain transport/cache and operation-specific write recovery | C4 |
| `private-browser-input` | Native wrappers and host guard around existing protected operations; broker stays authoritative | C4 |
| `fast`, `usage` | Explicit provider-facing host services and Telegram commands; remove dependence on old command contexts | C4, provider feasibility C1 |
| `deploy` | Host command retaining instance privileges and deployment policy | C4/C6 |
| `subagents` | Native durable tasks/owned conversations and completion reporter with bounded read-only execution | C5 |
| Selected skills/instructions | Preserve content and profile selection; update guidance for actual runtime behavior | C2–C6 |
| Codex conversion/web/retry dependencies | Replace or adapt each demonstrated behavior; retire only after request/tool/recovery parity | C1/C2/C4 |
| Eleven install patches | Map each behavior to native code/fork change or documented retirement; retain guards while needed | C0 inventory, C6 closure |
| Legacy session parser/provenance | Retain reader and exact old anchors; add durable history source | C3/C6 |

## Validation and evidence

For every checkpoint, use behavioral tests and synthetic effects rather than tests that mirror helper structure. Reuse existing host, Telegram, memory, search, job, browser, broker, capability and deployment fixtures where their behavior remains applicable; replace tests of obsolete API shapes.

Required cross-cutting assertions:

- Identity: duplicate event, duplicate request ID, changed payload under an existing ID, rotation between attempts, and grouped/attachment input identity.
- Recovery: restart before/after each durable boundary; repeated safe tool versus interrupted unsafe tool; effect succeeded/result lost; answer committed/listener missed; send acknowledged/receipt lost.
- Authority: profile filters before imports, actor/chat/thread binding, broker ownership, stale/replayed confirmations, child guard selection, and current authorization on recovery.
- Context/history: legacy anchors, stable new anchors, hidden recall, compaction/reset semantics, original timestamps, per-principal indexing, and feature flags.
- Operations: single writer/poller, ordinary and broker transport ownership, inbox admission receipts and retirement, blocked task definitions, version migrations, bounded close, storage failure, queued-input failure behavior, disk growth, retention and deployment holds.
- Transition: run the acceptance cases recorded for each approved [transition contract](#transition-contracts-to-settle-at-c0) across its supported runtime combinations.

Run `npm run check:changed` and `npm run build` after code changes. Use `npm run check` for full checkpoint/release gates and ensure browser integration suites follow repository naming/selection rules. Live provider, Telegram, browser and Linux/systemd evidence is distinct from offline tests; mark any unverified path explicitly. No checkpoint passes solely because types compile.

## Estimates and decisions

The research estimate was 6–10 engineer-weeks for full parity and cutover. Treat it as provisional. C1 is approximately 3–5 working days; estimate C2–C7 again after the pilot measures Telegram/provider adaptation and approval/recovery work. The MVP checkpoint includes correct memory and history behavior, not only a chat demonstration.

Checkpoint decisions are go/rework/stop. A failed pilot does not authorize a universal compatibility framework or silently reduced product scope. Bring the specific blocker and smallest alternative back for a decision.

Before production rollout, choose the canary, observation interval, live validation cases and maintenance window from private operational facts. These do not need to block architecture approval or the isolated pilot.

## Evidence and owning references

- [Architecture](../ARCHITECTURE.md), [capability profiles](../.pi/capabilities.json), [package pins](../package.json), [Pi upgrade gates](pi-upgrades.md), and [household fleet runbook](household-fleet.md).
- Runtime and transport: [ADR-0002: pinned Telegram fork](adr/0002-pin-pi-telegram-fork-for-host-session-actions.md), [ADR-0003: inbound inbox](adr/0003-durable-inbound-inbox.md), [ADR-0009: isolated instruction source](adr/0009-isolate-telegram-agent-instructions.md), [ADR-0013: settled replies](adr/0013-finalize-telegram-turns-after-pi-retries.md).
- Deployment and isolation: [ADR-0005: deployment runner](adr/0005-deploy-from-a-self-hosted-runner.md), [ADR-0020: household fleet](adr/0020-run-a-household-bot-fleet-from-one-release.md), [ADR-0031: remove the compatibility singleton](adr/0031-remove-the-compatibility-singleton.md), [ADR-0051: isolated runtime and credential approvals](adr/0051-isolate-personal-runtime-and-credential-approvals.md).
- Jobs and background work: [ADR-0010: scheduled jobs](adr/0010-scheduled-jobs-and-triggers.md), [ADR-0019: heartbeat observations](adr/0019-stateful-heartbeat-observations.md), [ADR-0021: bounded subagents](adr/0021-bounded-read-only-background-subagents.md), [ADR-0030: occurrences and acceptance](adr/0030-record-scheduled-occurrences-and-recipient-acceptance.md), [ADR-0031: heartbeat judgments](adr/0031-judge-heartbeat-items-with-jev.md), [ADR-0032: checker arguments](adr/0032-pass-bounded-arguments-to-heartbeat-checkers.md), [ADR-0050: incremental inbox heartbeats](adr/0050-incremental-inbox-heartbeats.md).
- History and routing: [ADR-0017: provenance](adr/0017-validate-personal-memory-session-provenance.md), [ADR-0026: derived search indexes](adr/0026-use-derived-fts-indexes-for-memory-and-session-search.md), [ADR-0022: idle rotation](adr/0022-rotate-sessions-after-human-inactivity.md), [ADR-0033: Jev routing](adr/0033-route-conversations-with-jev.md).
- Memory and guarded writes: [ADR-0015: bridge-only core memory](adr/0015-inject-core-memory-only-in-the-bridge-runtime.md), [ADR-0035: memory operations](adr/0035-typed-memory-operations.md), [ADR-0036: Calendar writes](adr/0036-guarded-calendar-writes.md), [ADR-0037: automatic recall](adr/0037-recall-memory-with-jev-before-each-turn.md), [ADR-0038: date context](adr/0038-resolve-date-context-before-memory-recall.md), [ADR-0045: usage and decay](adr/0045-rank-memory-by-usage-and-decay.md), [ADR-0046: recall filtering](adr/0046-filter-automatic-recall-candidates.md), [ADR-0047: memory proposals](adr/0047-propose-memories-in-batched-jev-recall.md).
- Protected browser: [ADR-0040: private input](adr/0040-protected-telegram-browser-input.md), [ADR-0041: OpenTable](adr/0041-protected-opentable-sign-in.md), [ADR-0042: email codes](adr/0042-private-email-verification-codes.md), [ADR-0044: takeover](adr/0044-telegram-browser-takeover.md), [ADR-0045: multistep login](adr/0045-private-multistep-browser-login.md).
- Features and diagnostics: [ADR-0043: feature flags](adr/0043-per-instance-feature-flags.md), [ADR-0046: debug messages](adr/0046-telegram-debug-messages.md), [ADR-0046: model usage and pace](adr/0046-telegram-model-usage-and-pace.md).

The filename links distinguish reused ADR numbers. C0 must complete the behavior-to-ADR inventory and identify which decisions need successors; this reference list is a starting set, not a claim that every ADR requires replacement.

Upstream research:

- [pi-durable 1.3.0 README](https://github.com/earendil-works/pi/blob/v1.3.0/packages/durable/README.md).
- [pi-durable 1.3.0 specification](https://github.com/earendil-works/pi/blob/v1.3.0/packages/durable/docs/spec.md).
- [pi-ai 1.3.0 provider/auth documentation](https://github.com/earendil-works/pi/blob/v1.3.0/packages/ai/README.md).
- [Coding-agent extension compatibility request](https://github.com/earendil-works/pi/issues/10386).
- [Durable human/client-tool approval request](https://github.com/earendil-works/pi/issues/10852).
- [Conversation deletion/retention request](https://github.com/earendil-works/pi/issues/11026).
