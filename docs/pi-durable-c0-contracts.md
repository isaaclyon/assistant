# Pi-durable C0 discovery and contracts

Status: contracts approved; C0–C3 passed. C3 chat and memory are implemented on isolated `feat/durable-c3` with local validation, independent review and dedicated live user acceptance; see the [C3 evidence](pi-durable-c3-chat-memory.md#validation-and-user-acceptance). No production migration has run.

This supplements the [approved migration roadmap](pi-durable-migration-plan.md). It preserves its native-extension strategy, chat-and-memory MVP, Node/systemd hosting, Telegram experience, domain stores and historical evidence. The user approved these contracts for publication and subsequently authorized baseline validation and the C1 pilot. C0 baseline validation is recorded below; live rollout remains C7. Existing ADRs remain authoritative until implementation-specific successors are accepted.

## Evidence and limits

Repository baseline: `bf7e4e8`, roadmap commit `488a956`. The inventory was checked against source, current tests and accepted ADRs. Two independent read-only source reviews covered capabilities/patches and release/job contracts; their conclusions were checked against the owning files. A third contract review prompted explicit admission/reconnect/media rules and creation-based child-expiry semantics; those corrections were checked against the fork and child-service source.

The published npm `latest` tag and the explicit candidate both resolved to pi-durable 1.3.0 during discovery. Its tagged source commit is `71023aec1546d6d677a65669c5665c0927ce0dd0`. Its manifest directly depends on `pi-ai`, `chord` and `pi-codemode` 1.3.0. The native codemode capability remains optional despite that dependency. Package metadata and source inspection establish available interfaces, not working assistant integration.

The initial discovery used an incomplete local installation and found missing Telegram imports and `ThinkingLevel` errors. A clean `npm ci` applied all existing guarded patches and resolved both findings without source or dependency changes. The first full run also exposed the process runner selecting macOS Bash 3.2; explicitly selecting installed Bash 5 and Node 24 resolved the four affected fake-deployment tests without skipping or changing them.

C0 validation: `npm run check` passed all three type checks and 1,162 tests in 143 files. The existing platform/tool availability conditions skipped 39 tests, including the real-browser suites; those paths remain unverified. `npm run check:changed`, `npm run build`, and a separate typecheck of the baseline probe also passed. No production secrets, stores, provider requests, Telegram pollers or service operations were used.

The [prototype-only baseline probe](../prototypes/durable-baseline/README.md) ran twice with ten samples per phase, measuring in-process host readiness, an immediate fake-provider turn, real Markdown CRUD, core compilation, FTS search, recall orchestration, inbox reopen/replay and finite-workload file growth. Raw measurements, environment details, baseline/lockfile hashes and comparison budgets remain in private external evidence. Recall retrieval/judgment and provider latency are synthetic; readiness is not live Telegram/systemd readiness. Comparison budgets trigger investigation of equivalent phases, not automatic rejection from ten samples. Named native crash barriers are now covered by the C1 evidence below; dedicated live pilot evidence is recorded below.

## C1 offline evidence

The isolated `prototype/durable-c1` branch owns `prototypes/durable-c1/README.md`, its probe helpers/tests, and a separate native 1.3.0 root manifest/lockfile. Retain it as prototype-only evidence. It is not a deployable native host, and passing C1 feasibility evidence does not make it production-ready.

The combined native `npm run check:changed` gate passed strict test typechecking and 60 tests in seven files; `npm run build` passed. JavaScript runtime helpers use `checkJs: false`. The suite includes the 24-case upstream public SQLite conformance suite with WAL/FULL checks, real SIGKILL admission/result barriers, durable source and grouped-attachment replay, concurrent failed-run queue wakes, abort/stop semantics, blocked-task registration, fatal-storage fail-closed behavior with bounded supervisor exit, completed-answer discovery and uncertain-send policy, scoped old/new history locators, profile filtering, and child-store close/removal. Separate native ToolTask probes reconcile an externally committed synthetic mutation without repeating it and exercise durable approval rejection cases. Provider tests use actual native serialization/streaming with injected transport and synthetic OAuth coordination.

The local Telegram fork candidate is `b463aec0683969f8c9b6075bb2f258f6ca382c5c`, based on `dc84d2038ce80d83406f1ea767df2fd99906cc3c`. Its full suite passed 1,185 tests with one platform skip; typecheck and package dry-run passed. The native pilot verifies this exact clean source SHA before importing the experimental public subpath. It proves real fork preview/final/sections/locks, fingerprinted metadata replay, actual owner-process exit/reconnect, and the retained trusted IPC/client/store's synthetic socket reconnect, update replay and offset acknowledgement. The broker uses protected socket access; repeated `getMe` is identity bootstrap, not an application authentication handshake. C2 still owns proper native package/release integration.

An independent review found missing discovery, attachment replay/reconnect, concurrent queue and history-resolver assertions. Focused fixes added those cases; a second read-only review confirmed their closure. The new replay assertion also caught and fixed cloning a native transaction-document proxy. The final combined check/build passed after that correction.

Offline limits: these automated tests do not exercise a real provider or dedicated live test-bot exchange. Native Responses preserves positional developer-message instructions and section patches, unlike the legacy Codex serializer's collapsed instructions. Service-tier/reasoning-summary parity and actual account refresh remain future provider work. Automatic fork-poller recovery and broker acknowledgement ordering with native admission are not integrated. Effect/delivery receipts and callback authentication are synthetic; attachment bytes, complete search/provenance, child lifecycle/confinement, Linux/systemd and C2–C7 parity remain unverified. No production service or deployment was changed. The separate live pilot below supplies the dedicated test-bot exchange.

## Live feasibility evidence

After the user authorized discovery of existing local/VM configuration, a disposable native Harness using the public SQLite WAL/FULL adapter completed and committed a real OpenAI API-key response with the expected fixed marker. Credentials flowed directly into the probe process and were not logged or saved with its state.

The user then selected an outbound-only test through an existing paired bot. A second native Harness provider turn committed the exact labeled test text; the SHA-verified Telegram fork adapter rendered it and the real Bot API acknowledged one final message. Bot identity and the private destination were checked first. No updates were consumed, no second poller was started, and no live service was changed. This was a synthetic internal input with a real provider and real outbound transport, not a live Telegram inbound turn.

The user subsequently supplied a dedicated test-bot credential and confirmed its identity. A bounded private pilot accepted one real private-chat message from the existing paired account, committed the native provider answer, and sent two acknowledged Rich Draft updates and one final reply through the same SHA-verified adapter. It presented a direct confirmation button, closed both native stores, exited the Node process, and started a new process against the same private state. The new process recovered the same conversation and committed answer, then handled the user's real callback. The persisted approval was consumed atomically with native task creation; replay was rejected and one harmless external SQLite counter increment survived another reopen. The Bot API acknowledged the callback and a completion message. The runner succeeded in about 21 seconds, stopped polling, and removed the disposable transcripts and databases.

This closes the dedicated inbound/preview/callback evidence gap. The live restart was orderly; hard-kill crash windows remain established by the offline probes. The test used a private bounded polling script, a single section registered in the same order after restart, a fixture domain receipt and API-key authentication. It does not establish general section-token persistence, arbitrary remote exactly-once effects, automatic production polling recovery, broker/native acknowledgement ordering, real OAuth refresh, or client-side visual quality. No production service or deployment changed. Private source references, scripts, timestamps and receipts remain outside the repository.

C1 checkpoint recommendation was **go to C2**. That work is now complete in a
separate native release tree; the prototype remains non-deployable evidence.

## C2 foundation evidence

The native `feat/durable-c2` branch owns strict `src/durable/` modules, a separate
exact 1.3.0 package tree and the compiled Telegram fork pin
`56f0fe38d2260db8dede028aca62d47cbb49bb20`. Clean install, 75 native tests and build
passed. The fork passed 1,188 tests with one platform skip; the legacy changed-file
suite passed 1,162 tests with 39 skips and its build passed. Independent review
closed the material findings. Ten exploratory samples remained below the C0
investigation budgets; short repeated-batch retained state growth was bounded.

See the [C2 foundation guide](pi-durable-c2-foundation.md) for lifecycle owners,
crash boundaries, measured limits and operator behavior. The foundation test
profile has no domain tools or jobs; its workflow validates without deploying.
The recommendation is **go to C3**. Real memory/history behavior, full provider
and Telegram parity, schedules/children, and target-system activation remain the
recorded C3–C7 gates. No live C2 service or canonical-state migration was run.

## C3 implementation evidence

The isolated native tree implements the seven-bundle, five-tool profile approved
in D3, canonical Markdown/Git receipt recovery, scoped native/archive provenance,
request-only core/date/recall context and direct Telegram controls. Local tests
and independent reviews are complete. The [C3 guide](pi-durable-c3-chat-memory.md)
records validation and limits. Real OpenAI tool-assisted chat and semantic
retrieval passed in a disposable programmatic smoke. Jev returned HTTP 401, so
enabled-recall authorization and dedicated live user acceptance remain blocked;
offline fixtures do not satisfy that checkpoint.

## Approved decisions

### D1. Separate native releases; select releases at deployment

Use a native migration branch with its own root manifest, lockfile, installed dependency tree and immutable releases through C2–C6. Keep legacy production fixes and grouped upgrades on `main`; forward-port applicable fixes with a reconciliation record. Do not combine or alias incompatible SDK copies inside one running host.

For C7, extend deployment to take a private, validated mapping from instance to immutable release SHA, resource root and runtime generation. Broker release selection stays separate. Only the selected canary changes runtime; peers can be restarted at their existing approved releases. Preserve whole-fleet or mixed-manager holds when writers share a checkpoint. A canary needs a measured observation interval, not uninterrupted peers.

The mapping is deployment input, not a model-facing flag. Validate release ancestry/digests, canonical paths, selected profile, state schema and exact instance/SHA/PID readiness. Record the previous mapping with the matching code/state checkpoint. Preserve the irreversible startup barrier and repair-forward rule. No old runtime opens the native Harness database.

C2 owns native packaging and test-instance startup. C6 owns the mixed-release installer, activation and rehearsal; it must pass before C7. Migration staging accepts explicitly reviewed native full SHAs through that controlled path; ordinary production keeps its existing main-branch release policy until cutover. After all instances pass C7, promote the native implementation to main and retire legacy packaging and runtime-generation selection. Per-instance release selection may remain useful for later observed upgrades. Ordinary `prepareBridgeFleet` and installation currently accept one release root/SHA, so this requires implementation. Isolated deployment must retain its administrator-owned policy, distinct UIDs, namespace and broker socket; it currently supports one isolated personal service beside user services, not an arbitrary isolated fleet.

Alternative: two runtime dependency trees inside every release. This makes production fixes easier to share but adds loader/build/patch selection and upgrade complexity throughout the host. It is not recommended. A migration branch without mixed-release activation is also insufficient.

Evidence: [fleet configuration](../src/fleet-config.ts), [installer](../src/install-service.ts), [activation](../scripts/activate-fleet.sh), [maintenance holds](../scripts/recovery-maintenance.sh), [isolated ordering](../src/isolated-deployment.ts), [isolated policy](../src/isolated-deployment-config.ts). Use the active maintenance path; `src/fleet-deployment.ts`'s historical unit-rollback helper does not supersede ADR-0030.

### D2. Candidate pins, provider boundary and update ownership

- Legacy remains the exact aligned `pi-agent-core`, `pi-ai`, `pi-coding-agent`, `pi-tui` set at 0.87.1 until a separately reviewed grouped upgrade. Keep nested alignment checks and all applicable patch guards.
- Pilot candidate: `@earendil-works/pi-durable`, `@earendil-works/pi-ai`, `@earendil-works/chord`, and `@earendil-works/pi-codemode` 1.3.0, with one committed lockfile in the native tree. Do not expose codemode merely because it is installed.
- Telegram fork starting point: `dc84d2038ce80d83406f1ea767df2fd99906cc3c`. C1 produces a separately reviewed full-SHA native adapter candidate. The existing fork is a reference, not a claim of Harness compatibility.
- The native host owns provider catalog, thinking settings, credential-store access and refresh coordination through pi-ai. Preserve per-instance account selection and Codex settings. Do not load the coding-agent Codex/retry/web wrappers into Harness as a compatibility shortcut. Port demonstrated provider/request behavior into focused services and validate against the existing serialization fixtures.
- The repository owner continues weekly legacy Dependabot review under the two-week review-or-deferral policy. The native branch needs an explicit manual weekly review while Dependabot targets the default branch. Native fixes land there; relevant legacy fixes are forward-ported before checkpoint acceptance. No auto-merge or silent update freeze.

C1 must prove credential refresh ownership, model/thinking validation, actual instruction/tool serialization, streaming/retry/final settlement and one authorized real provider request. Fast-mode and subscription usage parity finish at C4. Exact deployed account/model choices stay private.

Evidence: [package pins](../package.json), [upgrade policy](pi-upgrades.md), [nested SDK checks](../tests/codex-extension.test.ts), [request tests](../tests/codex-request.test.ts), [host compatibility](../tests/pi-compatibility.test.ts).

### D3. A narrowly selected chat-and-memory MVP

Profile ID to implement: `durable-chat-memory-test`. This is a new test profile, not an existing configured instance.

- Native bundles: `core-memory`, `search`, `memory`, `reload`, `restart`, `skills`, `debug`.
- Model tools: `assistant_memory`, `assistant_memory_search`, `assistant_session_search`, `session_context`, `search_index`.
- Skill: `personal-memory`. A selected `telegram-chat-memory-test` instruction resource retains applicable conversation, privacy, evidence and memory guidance and removes instructions to invoke unavailable integrations. Keep canonical-path checks and selection before imports.
- Telegram foundation still provides pairing/target policy, streaming, sections/buttons, new/abort/stop/compact, model/thinking controls, reload/restart and diagnostics.
- No shell, general file-write, web, browser, Google, places, scheduling, background-agent or codemode tools in this first test profile. The selected skill uses typed memory tools. General file/shell/public-web capability parity belongs to C4, and privileged builder workflows to C6. This is the approved C0 selection for the roadmap's MVP; all configured capabilities remain in final scope.
- Set `PI_TELEGRAM_MEMORY_RECALL=jev`, `PI_TELEGRAM_MEMORY_SEMANTIC=on`, `PI_TELEGRAM_SESSION_ROUTING=off` in private test configuration; test recall/semantic off variants and routing-on behavior separately before full parity. Jev and embedding fixtures are deterministic offline; real configured services require separate evidence. Missing provider authorization does not count as passing enabled-feature acceptance.
- Use a separate bot destination, manifest, state/workspace/agent roots and private memory fixtures. No production coordinator or fan-out registration. C2 must support a non-scheduling test host explicitly; changing the extension list alone is insufficient because today's host always loads provider/web dependencies and owns scheduling services.

MVP includes automatic recall and proposals, date hints even with recall off, usage/decay, draft duplicate review, targeted edits/append/list, delete/share confirmations, and both legacy/new provenance. Builder/household visibility fixtures still run even though the interactive test profile is personal.

Evidence: [capability selection](../.pi/capabilities.json), [host resource loading](../src/host.ts), [feature registry](../src/feature-flags.ts), [memory interface](adr/0048-standard-memory-interface.md), [memory proposals](adr/0047-propose-memories-in-batched-jev-recall.md). The latter supersedes the older rule that empty human recall candidates always skip Jev.

### D4. Preserve existing state guarantees and child retention

Use one main Harness/SQLite store per assistant instance process. Configure native SQLite with WAL/FULL before opening Harness. The 1.3.0 public `openNodeSqliteDatabase()` returns an adapter with `exec`; configure `PRAGMA synchronous = FULL`, then pass it to public `SqliteStorage.open()`. Verify the setting on every open and run storage conformance/reopen/crash tests in C1. This uses public adapters; it is not a patch to private tables. A source-supported configuration is not yet runtime proof.

Keep stronger existing domain ledgers unchanged: occurrences, broker, places and Places metering already use FULL. The current inbound inbox uses NORMAL. Distinguish process-crash acceptance from host/power-loss guarantees; FULL still depends on the storage stack honoring synchronization, and never makes an external send atomic.

Preserve seven-day cleanup of temporary child execution material. Children already require separate read-only execution confinement. C5 design: each child process uses its own temporary native Harness store; the main Harness owns orchestration tasks, stable child IDs, terminal outcomes and bounded parent reports. Store child execution material under private temporary task configuration with purpose, creation date, end condition and retirement. Measure expiry from `batch.createdAt`, matching current behavior, rather than extending it from completion. Retire a batch only after seven days, all children are terminal, no child/store writer remains, and no completion report is actively injecting. Run cleanup at startup and hourly or equivalently bounded intervals. Expired undelivered reports may be retired under those conditions. Keep only the correlation/status evidence necessary to prevent replay in the main store. Ordinary parent conversation/tool history remains retained, as it does today.

This deliberately uses process-owned child Harnesses rather than putting expiring raw child transcripts into the main append-only store. Native ownership within a child store does not confer cross-store authorization or cascade cancellation: the existing child-process supervisor must enforce deadlines, cancellation, termination and restart reconciliation. Persist a stable launch identity before spawning. Parent task recovery consults the child store/outcome and verifies exclusive process/store ownership before restarting work; a PID alone is insufficient. Reattach only to a verified owned process or confirm it has stopped before resuming the same store. Only read-safe unfinished child work can resume. Retention cleanup and recovery share a lease/lock; an expired child is terminal, never silently recreated. Preserve the original absolute 30-minute deadline across restart, 64-KiB output bounds and no nested delegation. Persist an expiry tombstone, verify child termination and store close, then remove the SQLite/WAL/SHM files and other owned artifacts. Retry incomplete removal after a crash without recreating the job. C5 tests must race recovery against cleanup and kill between tombstone and file removal.

Alternative: put children in the main Harness and retain their raw history indefinitely. It is simpler but changes the existing retention contract. Do not claim that cache eviction, compaction, or document retirement deletes append-only history. If the temporary-child design proves unsuitable, return for a retention decision before C5 rather than silently relaxing the limit.

Evidence: [child service](../src/subagents.ts), [child process boundary](../src/subagent-process.ts), [ADR-0021](adr/0021-bounded-read-only-background-subagents.md), [inbox](../src/inbox.ts), [occurrence store](../src/job-occurrences.ts), [broker store](../src/trusted-telegram-store.ts).

## Transport, identity and controls

The host owns stable source bindings; the fork owns Telegram rendering and ordinary polling/config/lock semantics. The broker remains authoritative for isolated upstream offsets and credential decisions. Preserve the ordinary five-second ownership monitor, valid external Pi owner handling and stale-owner recovery; never let the isolated adapter fall back to direct Bot API access.

Persist an immutable source envelope with instance/principal, transport/source identity, payload fingerprint, original event timestamp, chat/topic, conversation epoch and bound conversation. Scope Telegram message identity by bot/instance; preserve the fork's grouped-message identity and source-message set. Use job `dispatchId` and child completion IDs for those sources. Repeated identity with changed payload fails visibly. Native submission request IDs deduplicate only within one conversation and do not by themselves validate changed payload, so the host mapping is required.

Retain `inbox.db` as the transition front buffer. Persist the pending payload and its durable conversation/epoch binding before acknowledging transport acceptance/advancing its offset. Serialize binding with `/new` and idle-rotation decisions. Pending input may require a reserved new epoch while old work drains; materialize that conversation once and preserve the correlation across restart. The first event after the idle boundary belongs to the reserved new epoch. Already bound input never moves to the current conversation on retry.

Admit through public `Conversation.submit()` with a stable request ID, record the returned submission reference, then remove the inbox row. A crash before the receipt is recorded retries submission to the same bound conversation and recovers its ID. Do not use raw `Tx.createSubmission()` as a shortcut: it bypasses admission rules. These cross-store stages are reconciled, not a claimed atomic transaction. The pilot must demonstrate the ordering and target behavior. Legacy pending payloads need explicit binding during offline migration; uncertain already-dispatched work is quarantined. Retire the front buffer only after direct durable ingress and all legacy pending rows pass equivalent acceptance tests.

The following adapter contracts are explicit C1/C2 proof obligations; source inspection does not establish their implementation:

| Adapter surface | Selected contract / owner |
| --- | --- |
| Human text, grouped turns, reminders/jobs, child reports | Host submits `whenBusy: followUp`; `followUpMode: one-at-a-time`. No ordinary source silently becomes steering. Preserve source order within its bound conversation and recorded destination. Child reports also retain the existing parent-idle rule. |
| Steering | Keep a separate explicit adapter operation mapped to `whenBusy: steer`, with `steeringMode: one-at-a-time`. Normal Telegram chat does not select it; expose it only through an existing supported control. |
| Queued input after terminal run failure | Notify the failed input's recorded target; retain queued inputs and advance them in order without replaying the failed input. Native failures leave the queue in place. Proposed public-API bridge: submit a stable-ID control write containing `model: []` after failure. An empty model contribution triggers the documented final boundary while adding no user prompt, allowing the next queued input to start. Prove this against the pinned release in C1, including duplicate wakes, restart, no queued work, concurrent input and no model-context pollution. If that proof fails, the pilot stops for an adapter decision; it must not quietly require the user to resend. |
| Abort/next queue presentation | Preserve the fork's explicit next-item command and fold-after-abort presentation rules while retaining every original source identity/time. Never enable native all-at-once mode merely to approximate folding across unrelated targets. |
| Ordinary reconnect | Fork owns upstream polling/offset/lock updates; host owns the five-second check and reconnection after a valid external owner exits or a stale owner is safely cleared. Resume pending work by source ID before accepting duplicate dispatch. No second poller may start. |
| Broker reconnect | Restricted adapter reopens its configured socket, reauthenticates and resumes broker-owned update identity/acknowledgement. Runtime failure never changes upstream polling ownership or enables direct fallback. |
| Media/attachments/voice | Fork owns decoding/grouping and rendering; host owns durable source identity and references, and the adapter converts to native input/output. Preserve immutable authorized file references and bounded private artifact ownership across crash until consumption/retirement. Missing media fails visibly without silently sending a partial prompt or fetching from another target. C1 uses synthetic attachment identity/replay; full media/voice parity remains C6. |

The control-write proposal follows the tagged specification's explicit rule that a present `model` field, even an empty array, makes a write participate in boundaries. A display-only diagnostic write would not advance the queue. Keep control entries out of conversation search and memory provenance; they are execution metadata.

| Control | Native contract |
| --- | --- |
| `/abort` | Cancel current active work while preserving queued user input, matching the fork. Use supported active-task cancellation; conversation-wide abort would also withdraw queued input and is not equivalent. Prove the supported API in C1/C2. |
| `/stop` | Cancel active work and withdraw queued input in both the host buffer and Harness; retain terminal cancellation evidence. |
| `/new` / idle rotation | Serialize epoch selection and conversation creation; preserve original event time, no inherited context, no background-completion rerouting. Refuse incompatible busy states as today. |
| Compaction | Native context compaction; keep source history/citations and reset recall dedup only according to retained context. |
| Ordinary restart | Drain/close within the existing ten-second host bound; resume persisted work only after registry, policy and transport are bound. Rehydrate unexpired same-epoch ordinary approvals under the approved roadmap policy. |
| Reload/reset | Invalidate operation-specific pending drafts/approvals; rebuild selected registries safely; reject blocked/incompatible task versions rather than guessing. |

Evidence: [inbox contract](adr/0003-durable-inbound-inbox.md), [rotation contract](adr/0022-rotate-sessions-after-human-inactivity.md), [host lifecycle](../src/host.ts), [shutdown](../src/daemon.ts), and pinned fork command behavior. C1/C2 must establish queue ordering and cancellation behavior through public native APIs.

## Delivery and operation recovery

Persist final-delivery intent keyed by submission/entry and recorded target, with multipart segment identities and receipts. Scan authoritative completed work to recover a missed listener. Streaming previews are best effort. Suppress proactive `NO_REPLY` under the current policy.

A definite pre-send/no-effect failure may retry. A lost acknowledgement after a possible Telegram send becomes `uncertain`; do not blindly send again. A known, exclusively owned message ID may permit idempotent editing after validation. Operator/user reconciliation handles unresolved sends. Persisting a receipt cannot eliminate the external send/receipt crash window.

Operation records bind a stable operation ID, canonical request fingerprint, principal/target/epoch, schema/handler version, any approval/revision, and state: prepared, authorized, executing, succeeded, failed, interrupted, or uncertain. Delivery is tracked separately. Use typed per-domain records, not a general workflow framework. Recheck current authority on execution/recovery. Missing definitions or incompatible schemas block recovery with actionable diagnostics.

| Operation class | Replay/reconciliation contract |
| --- | --- |
| Memory/history reads, file reads, bounded public reads | Retry read-safe work; recheck current visibility. Cached completed results do not grant access after a policy change. Treat logs/metering as separate effects. |
| Memory create/update/append/share/delete | Persist operation identity and intended note ID/timestamp/pre/post revision under the existing mutation lock before effect. Add a narrow executor receipt/reconciliation path; the current random ID and process-local draft result are insufficient. Recognize the exact result after crash; changed/ambiguous content stops. Never repeat append or generate another note ID. |
| Optional memory Git commit | Separate outcome after Markdown publication. Reconcile the exact intended note change and Git commit; no reset, unrelated staging or duplicate commit. Report saved-note/Git outcomes separately. |
| Places mutations and comparisons | Preserve SQLite transactions and revisions. Put operation receipts in the same domain transaction where possible; retry returns its result. Destructive tokens remain operation/target/snapshot bound. |
| Calendar create | Retain deterministic remote event ID from stable operation key and payload fingerprint; read to reconcile ambiguous outcome. |
| Calendar update/delete | Preserve current account/calendar allowlist, revision preflight, one-write lock, deletion approval and bounded reconciliation. The current transport lacks atomic If-Match; never claim race-free external concurrency or repeat an uncertain mutation. |
| Google Places reads | Existing attempt metering is an effect. Preserve each charged attempt/cache policy; do not mark the whole mixed tool universally replay-safe. |
| Shell/general file writes/browser actions | Interrupt by default; resume only through a specific proven idempotency/reconciliation contract. No generic replay of commands or form submission. |
| Scheduling/background tools | Reuse occurrence/dispatch/batch identity, distinct admission and settlement, durable cancellation and terminal evidence. |

Memory/share/delete and Calendar-delete confirmations retain ten-minute, one-use limits, authenticated actor/chat binding and preview revision checks. Persist request, successful presentation and decision separately. Expired, canceled, stale-version, failed-presentation, reset/reload and consumed requests cannot authorize another effect. Ordinary restart may restore a still-valid same-epoch request; `/new` invalidates pending permission. A consumed operation already in flight is reconciled rather than reapproved or repeated. Places confirmation tokens also preserve their operation/target/deletion snapshot and session invalidation; the native direct callback path must bind its authenticated actor and target explicitly.

Browser entry/takeover/login keeps the existing crash gate and secret-free result boundary. Restart does not rerun a sensitive submission or silently release the gate. Perform verified stop/cleanup and return interrupted/blocked unless authenticated ownership and safe reconnection are proven. Credential approval remains in the trusted broker; host records may reference its opaque operation identity, never replace its authority or contain secret values.

Evidence: [memory application](../src/memory-application.ts), [shared executor](../.pi/skills/personal-memory/scripts/memory.mjs), [memory store](../.pi/skills/personal-memory/scripts/store.mjs), [Calendar writes](../.pi/lib/google-calendar-writes.ts), [places application](../src/places-application.ts), [browser gate](../src/protected-browser.ts), [broker authority](adr/0051-isolate-personal-runtime-and-credential-approvals.md).

## Mixed-runtime jobs

Keep the version-1 filesystem exchange unchanged during rollout. `pending` means published awaiting claim; `processing` is a claim whose surviving uncertainty needs reconciliation; **`completed` means recipient admission, not run/effect completion**. `acknowledged` is operator resolution without proof of acceptance. Coordinator `enqueued` means publication, not completion.

Native recipients durably admit by `dispatchId` before moving the v1 handoff into `completed`. Native run completion is recorded separately. Legacy recipients continue exposing acceptance only; a native coordinator must not infer completion from that evidence. Retain exact occurrence IDs, definition fingerprints, terminal identities and original timestamps. Test all four legacy/native coordinator-recipient combinations within supported ownership topology.

Cancellation of a v1 handoff affects known-unclaimed work only. It does not abort an already processing/accepted run; any native active-task abort is an explicit separate operation. Unknown/malformed schema bytes are quarantined and surfaced, not injected, discarded or guessed. Future completion/schema records live outside directories old drains consume.

Cross-UID filesystem handoff is not implicitly supported: current recipient validation requires current-UID ownership and mode 0600. The isolated personal deployment keeps self-only private jobs. Hold unsupported edges explicitly without advancing them to accepted or dropping occurrence identity; do not broaden filesystem permissions to make them work.

Evidence: [handoff source](../src/job-handoff.ts), [handoff tests](../tests/job-handoff.test.ts), [ADR-0030](adr/0030-record-scheduled-occurrences-and-recipient-acceptance.md), [singleton removal](adr/0031-remove-the-compatibility-singleton.md).

## State ownership and migration inventory

| State/current owner | Target and migration/recovery treatment | Retention/guarantee |
| --- | --- | --- |
| Session JSONL / coding-agent | Preserve read-only archives; add native Harness history and versioned locator resolver | Keep old citations exactly; no conversion of in-flight JavaScript |
| Inbox / host | Retained front buffer plus native source binding/admission receipt as above | Remove pending row only after admission; retain dedup evidence |
| Human-idle epoch / host JSON | Native host document after correlated migration | Original human clock; jobs do not advance it |
| Ordinary Telegram config, offset, locks / fork | Retain named private profiles and ownership monitor | One upstream poller; no new reader of credential contents |
| Broker updates/offsets/approvals / broker SQLite | Retain broker store and authority; adapt restricted host transport | FULL commits and existing one-use/reconciliation policy |
| Memory Markdown / shared executor | Retain vault, scope/revision rules and optional Git; add narrow operation receipts | Canonical notes remain authoritative; no new memory database |
| Drafts/confirmations / process-local applications | Native typed records with same TTL/limits plus approved restart recovery | Ten minutes; reset/reload/new and operation-specific invalidation |
| Places DB and add draft / places application | Retain domain transactions/comparison state/draft; reconcile mutations | Existing durable state; no unrelated format conversion |
| Google Places cache/metering / gateway | Retain existing private SQLite accounting | Retain attempt history/monthly limit semantics and cache TTLs |
| Search index / search coordinator | Rebuildable projection over legacy + native sources | Scope-filter every query and context expansion; cache is not authority |
| Recall/read logs / search and memory | Retain text-free usage evidence and decay semantics | Existing log policy; do not add raw notes/prompts to diagnostics |
| jobs.json/checker state/price-watch manifests / coordinator | Retain definitions, cursors and temporary task end conditions | No task-specific state in repository |
| Occurrence DB/job-dispatches/job-handoffs / coordinator and recipients | Retain v1 exchange and historical evidence; native tasks own new execution | FULL occurrence ledger; terminal IDs never recreated as new work |
| Child batches/session directories / subagent service | Main durable orchestration plus temporary process-owned child Harness stores | Preserve seven-day temporary cleanup, bounded output/deadlines |
| Browser runtime/profile/crash gates / protected host | Retain existing owner and stop-only recovery where blocked | Never serialize credentials into Harness or indexes |
| Provider/Google credentials and key files / external providers | Keep scoped private configuration, add native adapter boundary | No copying into repository or generic task records |
| Restart marker/runtime metadata / host | Retain service readiness/notification interface; native lifecycle producer | Exact instance/release/PID readiness, bounded shutdown |

History locator proposal: retain `sessionId/entryId/timestamp` for JSONL; add an explicit backend discriminator and instance/store/conversation/entry identity for native evidence. Native source event time remains separate from admission/entry time. Search results, bounded context expansion and memory provenance lint use the same resolver and principal policy. Do not fabricate a JSONL path or rely on derived-index offsets for native entries. Test old and new cited notes through compaction, `/new`, restart and index rebuild.

## Capability inventory and test ownership

All 14 selected resources need native registrations/lifecycle; retain their domain implementations. Source wrappers are `.pi/extensions/<name>.ts` except `subagents/index.ts`.

| Resource | Surface / owner | Checkpoint | Representative existing tests |
| --- | --- | --- | --- |
| core-memory | Scoped per-turn prompt compilation, bridge-only authority | C3 | `core-memory-extension.test.ts`, `memory-inspect.test.mjs` |
| search | Four search/context/index tools, recall/date/proposals | C3 | `search-extension.test.ts`, `search-coordinator.test.ts`, `memory-recall.test.ts` |
| memory | CRUD drafts, confirmation section, shared executor | C3 | `memory-extension.test.ts`, `memory-application.test.ts`, `memory-scope.test.mjs` |
| reload | Host registry replacement command | C2–C3 | `reload-extension.test.ts` |
| restart | Host restart request and completion notice | C2–C3 | `restart-extension.test.ts`, `restart-notification.test.ts` |
| skills | Selected resource listing | C3 | `skills-extension.test.ts` |
| debug | Target-scoped tool/lifecycle/core/recall diagnostics | C3; new integration coverage C4 | `debug-extension.test.ts`, `debug-messages.test.ts` |
| fast | Provider request preference | C1 proof, C4 parity | `fast-extension.test.ts`, `codex-request.test.ts` |
| usage | Read-only subscription usage service | C4 | `usage.test.ts` |
| deploy | Privileged builder deployment command | C4/C6 | Deployment script/host tests; add native command contract test |
| places | rank_places, menu/sections/replies, domain SQLite | C4 | `places-extension.test.ts`, `places-application.test.ts`, `places-e2e.test.ts` |
| google-workspace | Typed reads and per-operation Calendar writes | C4 | `google-workspace-extension.test.ts`, `google-calendar-writes.test.ts`, `google-calendar-confirmation.test.ts` |
| private-browser-input | Four protected input/login/takeover tools; conditional credential candidates | C4 | `private-browser-input.test.ts`, `private-login-browser.test.ts`, `browser-takeover-browser.test.ts` |
| subagents | background_subagents and confined child runner | C5 | `subagents.test.ts`, `subagent-process.test.ts`, `subagent-tools.test.ts` |

The manifest has four profiles, fifteen selected skill resources and one shared instruction resource. Personal profiles differ in Google/places access; household excludes protected private input; builder excludes core memory and memory CRUD. Preserve those differences. `manage-hue` is not in the manifest and is not silently added to parity scope. Capability selection is not a complete current tool inventory: the host also explicitly loads Telegram, Codex conversion, retry and Codex web, and owns schedules/child services. Native host-service/tool selection must therefore be explicit.

Skill ownership: `personal-memory` C3; `agent-browser`, `check-weather`, `google-calendar`, `gmail-read`, `google-contacts`, `find-places`, `manage-ynab`, `message-link`, `plan-weekend`, `reserve-restaurant` C4; `schedule-reminders-and-jobs`, `watch-prices` C5; `extend-this-agent`, `track-improvement-ideas` C6 builder parity. Cross-skill references must not advertise an unselected tool; e.g. weekend guidance requiring scheduling waits for that part of C5. Preserve all existing profile selections at full parity.

## Install-patch disposition

All names below are under `scripts/`; existing patch/source guards remain until replacement behavior passes. Pin changes alone do not justify deleting a patch.

| Patch | Behavior / native owner | Gate and test evidence |
| --- | --- | --- |
| patch-codex-conversion.mjs | Scoped settings and current model/request compatibility; native provider adapter | C1/C2; `codex-extension`, `codex-gpt61`, `codex-request`, `pi-compatibility` tests |
| patch-telegram-tool-activity.mjs | Private-safe activity labels and one-second updates; fork renderer | C3; `tool-activity-labels.test.ts`, `tool-activity-cadence.test.ts` |
| patch-telegram-new-session-dedup.mjs | Deduplicate `/new`; stable native command/source identity replaces TTL implementation | C2; `telegram-new-session.test.ts` |
| patch-telegram-agent-settled.mjs | Finalize only after retries settle; authoritative native settlement/delivery | C2/C3; `retry-extension.test.ts`, `host.integration.test.ts` |
| patch-telegram-subagent-target-scope.mjs | Exact proactive target; persisted source/completion target | C2/C5; `subagent-target-scope.test.ts` |
| patch-telegram-model-menu-return.mjs | Return to status menu after model selection; fork menu | C3; add focused bridge contract regression (upstream menu suite alone is not closure) |
| patch-telegram-new-session-menu.mjs | Show menu after successful `/new`; fork menu | C3; `telegram-new-session-menu.test.ts` |
| patch-telegram-debug.mjs | Authorized command target and diagnostic transport; native diagnostics adapter | C3/C4; `debug-extension.test.ts`, `debug-messages.test.ts` |
| patch-telegram-silent-veto.mjs | Suppress proactive NO_REPLY; delivery policy | C2/C5; `telegram-silent-veto.test.ts` |
| patch-telegram-thinking-level.mjs | Support max thinking level; provider validation/menu | C1/C3; `telegram-thinking-level.test.ts` |
| patch-telegram-trusted-transport.mjs | Broker fetch and no direct fallback; restricted transport | C1/C2; `telegram-trusted-transport.test.ts` |

C6 replacement evidence (`feat/durable-c6`). Native code has no legacy postinstall patches. The retained legacy scripts and source/version guards remain necessary for old releases until C7 retirement. The cases below test behavior, rather than inferring replacement from a dependency pin. Final integrated release checks and Linux rehearsal results appear in the [C6 guide](pi-durable-c6-rehearsal.md#validation-scope).

| Patch | Native owner and behavior evidence (`tests/durable/`) |
| --- | --- |
| codex-conversion | `provider.ts` selects explicit per-instance settings and native Responses serialization. `provider-gpt61.test.ts` exercises the actual SDK catalog and fake-OAuth request path: off/minimal rejected, high/max serialized. SDK 1.3.0 supplies a 500K context window; the legacy backport used 272K. Legacy Responses Lite/context wrappers are unnecessary in this native protocol. |
| tool-activity | `tool-activity.ts`, `visible-events.ts`, `telegram-bridge.ts`: friendly private-safe labels and one-second edits. `tool-activity.test.ts` covers labels/cadence; `visible-events.test.ts` covers suppression and cleanup; `media-application.test.ts` observes actual native tool events through the application. |
| new-session-dedup | Durable command receipts replace the old TTL cache. `new-session-parity.test.ts` replays the same actual Telegram `/new` before and after restart and proves one epoch change. `host.test.ts` retains busy rejection across restart. |
| agent-settled | Native submission settlement and `delivery.ts` own final output. `provider-retry.test.ts` exercises actual Harness retries/stalls; `provider-fast.test.ts` proves one final destination and completed effects while pending preferences wait for settlement. |
| subagent-target-scope | `children.ts` retains original conversation/epoch and target. `children.test.ts` covers reporting after parent idle/new; `children-application.test.ts` checks application authority and original-target delivery. |
| model-menu-return | `telegram-bridge.test.ts`: model and thinking selection edit the pressed message back to the status menu. |
| new-session-menu | `telegram-bridge.test.ts`: successful `/new` shows the menu; a rejected control does not. Household confirmation is actor/message/epoch-bound with a ten-minute expiry (`group-new.test.ts`). |
| debug | `telegram-bridge.ts` and domain diagnostics: `telegram-bridge.test.ts` checks bounded redacted output at the originating target; `parity-diagnostics.test.ts` excludes private arguments. |
| silent-veto | `delivery.ts` suppresses proactive `NO_REPLY`, while human literal `NO_REPLY` remains visible (`host.test.ts`). `visible-events.test.ts` suppresses proactive partials/activity, including child reports with scheduled jobs disabled. |
| thinking-level | Provider validation and Telegram menus retain max. `provider.test.ts`, `provider-gpt61.test.ts` and `telegram-ui.test.ts` test supported levels and callback bounds; `telegram-bridge.test.ts` tests selection. |
| trusted-transport | `transport.ts` uses the restricted broker protocol without direct fetch fallback. `transport.test.ts` exercises real IPC reconnect/replay and failed offset persistence. |

Media acceptance uses immutable artifacts, actual native image blocks, verified document paths, durable album recovery and operation-owned upload receipts. Unsupported voice fails visibly because the legacy deployment has no transcription provider. Frozen-copy migration remains held by design. Disposable Linux evidence and live provider/browser/operator acceptance have separate limits; see the C6 guide.

## ADR disposition

Keep domain facts and authority from existing ADRs. Successors must describe implemented changes, not preemptively mark this proposal accepted.

- Host/runtime/resource loading, provider settings and temporary coexistence: ADR-0001, 0002, 0004, 0005, 0009, 0015, 0020 and [0031-remove-the-compatibility-singleton](adr/0031-remove-the-compatibility-singleton.md).
- Input/delivery/control recovery: ADR-0003, 0006, 0007, 0008, 0013, 0022.
- Schedules, ownership, retention and recipient evidence: ADR-0010, 0019, 0021, 0030, [0031-judge-heartbeat-items-with-jev](adr/0031-judge-heartbeat-items-with-jev.md), 0032, 0033, 0049, 0050.
- Memory/history authority remains under ADR-0011/0012/0014/0016/0017/0018/0026/0034/0037/0038/0048; approval persistence requires a successor to 0035. Preserve the newer [0045 usage/decay](adr/0045-rank-memory-by-usage-and-decay.md), [0046 recall filtering](adr/0046-filter-automatic-recall-candidates.md) and [0047 proposals](adr/0047-propose-memories-in-batched-jev-recall.md) semantics.
- Places/Google domain behavior remains under ADR-0023/0027/0029; changed confirmation lifecycle needs a successor to 0036. Message links and scoped credentials remain under ADR-0024/0028; temporary SSH handoff remains under ADR-0025.
- Protected browser authority remains under ADR-0040/0041/0042/0044/[0045 multistep login](adr/0045-private-multistep-browser-login.md)/0051; update host lifecycle bindings without weakening their boundaries. ADR-0039 remains a prototype.
- Feature flags (0043), [0046 debug](adr/0046-telegram-debug-messages.md), and [0046 usage](adr/0046-telegram-model-usage-and-pace.md) retain their product behavior through new native owners.

## Evidence required before checkpoint acceptance

C0 is complete only after the approved contracts and accepted inventory/dispositions are accompanied by a clean baseline. Baseline measurements belong in private evidence: startup/readiness, deterministic ordinary-turn latency, core/recall preparation, memory CRUD/search, restart replay and state growth. Use the same synthetic workload/provider fixtures for legacy/native comparison; report distribution and workload, not a single invented threshold. Set regression budgets from those observations before judging C2.

C1 probes, each with a bounded test and an explicit failure outcome:

1. Open/close/reopen candidate Harness with WAL/FULL through public adapters; verify task registration and fatal storage-error shutdown. Use disposable local state; no claim of tested physical power-loss behavior.
2. Native provider/auth and Telegram adapter through the pinned fork base; deterministic fake transport first, then authorized live provider/test-bot evidence. Prove follow-up/explicit steering order, failed-run queue advancement through the proposed control write, `/abort` versus `/stop`, original timestamps, both reconnect ownership paths, and synthetic attachment identity/replay.
3. Source binding/inbox/admission receipts: duplicate event, changed payload, reserved rotation, crash after admission before receipt/removal, and exact destination after restart.
4. Completed-answer discovery without a listener, definite send failure and ambiguous acknowledgement; no false delivery success.
5. A simulated external mutation succeeds before its result commits; reconcile by operation identity without repeating it. Persisted same-epoch approval and replay/wrong-actor rejection.
6. Legacy citation resolver plus native identity shape; restricted profiles/children cannot import unselected resources. Temporary-child retention architecture gets a small public-API/process-lifecycle proof before C5 implementation, not a full child subsystem in C1.

C2 expands boundary/crash tests, C3 proves actual Markdown and optional Git reconciliation, C4 proves each integration and browser boundary, C5 proves all supported mixed-runtime handoffs and retention, C6 rehearses exact-release deployment/holds/restore and target Linux/systemd acceptance. Only explicitly recorded probe paths are verified; later integration gates remain open.

## Upstream sources

- [Published 1.3.0 manifest](https://registry.npmjs.org/@earendil-works/pi-durable/1.3.0).
- [Tagged durable README](https://github.com/earendil-works/pi/blob/v1.3.0/packages/durable/README.md).
- [Tagged durable specification](https://github.com/earendil-works/pi/blob/v1.3.0/packages/durable/docs/spec.md).
- [Public Node SQLite adapter](https://github.com/earendil-works/pi/blob/v1.3.0/packages/durable/src/storage/sqlite/node.ts).
- [Submission admission/deduplication](https://github.com/earendil-works/pi/blob/v1.3.0/packages/durable/src/harness/submissions.ts).
- [Conversation deletion request](https://github.com/earendil-works/pi/issues/11026).
