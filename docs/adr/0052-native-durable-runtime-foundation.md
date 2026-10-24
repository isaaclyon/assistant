---
status: accepted
relates-to: ADR-0002, ADR-0003, ADR-0006, ADR-0009, ADR-0013, ADR-0022, ADR-0035, ADR-0051
---

# Build the native runtime in a separate release tree

## Context

The approved C0–C7 migration replaces coding-agent sessions with pi-durable
conversations and tasks. C1 demonstrated the public 1.3.0 APIs; its probe
helpers and minimal manifest were not a production host. The legacy fleet must
continue using its reviewed SDK and release while native integration proceeds.

## Decision

C2 owns `src/durable/` and a separate root dependency tree with exact pi-durable,
pi-ai, chord and pi-codemode 1.3.0 pins. A compiled `@llblab/pi-telegram/durable`
export in the pinned fork provides configuration, ownership and rendering
primitives without importing coding-agent. The fork remains an external pinned
dependency. Installing pi-codemode does not enable a model tool.

The native entrypoint requires an explicit private configuration identifying
its runtime, instance, release, workspace, state root, profile, provider account
and transport. C2 runs a dedicated text-only foundation profile with scheduling
disabled. C3 supplies the approved chat-and-memory profile. The native branch
cannot replace an ordinary fleet release before C6 activation rehearsal and C7
rollout. Existing legacy code is retained as a reference and shared domain
source; native builds do not construct its host.

### Storage and execution

One process holds an OS-managed exclusive SQLite writer lease before opening
`<stateDir>/durable/harness.db`. Harness and the retained `<stateDir>/inbox.db`
use WAL/FULL. Closing releases ownership only after runtime execution and stores
have closed. A timed-out close retains ownership until process termination; the
daemon has the existing ten-second shutdown bound. Fatal storage failure stops
acceptance and requests process exit, including when tool code ignores abort.

The host records the source envelope, original event time, principal, exact
destination, fingerprint and bound conversation before transport acknowledgement.
The inbox remains the accepted-but-not-admitted front buffer. Public native
submission uses the stable source request ID; its receipt precedes inbox removal.
Reopening reconciles this cross-store protocol. Epoch rotation cannot remap a
previously bound source. Controls also retain identity and exact work targets;
replaying a control cannot cancel newer work. An ambiguous compaction request
is inspected rather than repeated.

Final answers are discovered from authoritative completed submissions. Stable
segments carry delivery intent and acknowledged message IDs. A definite
pre-send failure or matching parsed Telegram client rejection is retryable.
The final-delivery ledger persists rejection retry deadlines across restart.
Rate limits use a bounded Telegram retry interval; other client rejections use
a sixty-second delay. Rejected segments remain pending until delivery succeeds
or an operator repairs the cause; they have no automatic attempt limit.
A send with missing acknowledgement or a surviving
sending intent becomes uncertain. Streaming previews are best effort and never
prove final delivery. The same transient observer refreshes Telegram's typing
chat action during human-requested runs (including tools and provider retries).
Run settlement, observer replacement and shutdown cancel its timer and outstanding
request. Recovered proactive runs remain silent. Typing is best effort, uses the
transport's current ownership/pairing checks, and never enters the delivery ledger;
Telegram may retain the last action briefly after refresh stops.
Proactive `NO_REPLY` is suppressed. Native storage cannot
make an external Telegram send exactly once.

### Authority and extension lifecycle

All selected resource paths are canonicalized inside the release before any
module imports. Native bundles provide versioned tools and optional native
hooks, sections and tasks. Tool wrappers recheck current authority and handler
signature when execution resumes. Completed results remain historical evidence;
the host and C3 history reader own access checks on that evidence.

The host checks runtime schema, selected profile, instance identity and registry
signature before scheduling recovery. Missing definitions and incompatible
selections block startup. Host metadata schema 2 separates the registry's tool
and bundle contract from its instruction revision. Text-only instruction and
skill updates require settled tasks, submissions, local inbox work, controls,
and delivery. They atomically update stored conversation instructions and the
revision, preserving model/thinking choices and conversation history. Inspection
alone does not apply that update.

Schema 1 retains a content-bound hash. Its one-time upgrade requires an explicit
`instructionUpgradeFrom` full SHA in the pinned instance configuration. The host
reads selected text from that retained sibling release without executing its
code and reconstructs the old hash with the current tool schemas, replay modes,
and handler/bundle versions. Only an exact stored match permits the transition;
no operator-supplied replacement hash or generic compatibility bypass exists.
Administrator preflight binds that SHA to the prior runtime map and refuses
simultaneous configuration changes. Subsequent schema-2 releases bind the
immutable release parent rather than the changing child-process release path. Provider credentials stay in an explicitly selected
private store; the Pi-auth adapter uses the existing proper-lockfile protocol
so legacy and native processes can coordinate refresh. It preserves unrelated
provider records and disables ambient credential fallback. Native account
settings are explicit; there is no interactive login or implicit credential copy.

Ordinary polling retains named profiles and fork ownership locks, with the
five-second recovery monitor. A valid live external owner is observed rather
than preempted. Restricted mode uses only the existing trusted broker socket and
its update acknowledgements; it has no direct Bot API fallback. The broker
continues owning upstream polling, tokens and credential approval authority.

Ordinary memory operation records bind identity, epoch, actor, destination,
revision, handler, expiry, presentation and authenticated decision. Consuming a
confirmation and creating its native task share one transaction. Current
execution authority is checked again. An interrupted effect can only reconcile
against a domain receipt; an unknown outcome cannot repeat the effect. Create,
update and append have a separate trusted authorization path; delete and share
always require a direct confirmation. C3 supplies actual Markdown/Git executors.

## Consequences

- C1 helpers remain evidence; production code does not import them.
- Each supported runtime retains its own exact-pin compatibility gate. The
  repository owner reviews native pins manually each week while the default
  branch's grouped updates continue serving legacy production.
- Historical JSONL and canonical memory/domain stores are preserved. No old
  in-flight JavaScript stack or historical uncertain operation is imported.
- Schema/profile/signature changes require explicit reconciliation rather than
  reopening incompatible pending work under newly selected code.
- This decision applies to the native release tree. The linked legacy ADRs
  continue describing the deployed fleet until its explicit rollout.
- Full Telegram UI, recall and memory are C3; integration/provider parity is C4;
  schedules/children are C5; Linux/systemd/mixed-release activation is C6/C7.

Validation and checkpoint status are recorded in the
[C2 foundation guide](../pi-durable-c2-foundation.md).
