# Native scheduled-job recipient admission

The isolated `feat/durable-c5-recipient` branch starts C5 with the recipient side
of the approved [mixed-runtime contract](pi-durable-c0-contracts.md#mixed-runtime-jobs).
C5 validation remains open. Production activation remains C6/C7.

## Selection and ownership

The new `durable-jobs-test` profile extends `durable-parity-test` and requires
`jobsRole: "recipient"` in its private native configuration. Earlier profiles
still require `jobsRole: "disabled"`; their resource selections remain unchanged.
This profile retains the Isaac-only private chat and its explicit memory,
Google, browser and optional CLI configuration. It exposes no schedule-editing
or child-agent tools. Use a fresh native store for this profile.

The recipient reads only `<stateDir>/job-handoffs/`, and delivery uses the
configured private Telegram destination. The state directory must be owned by
this runtime and private. There is one active runtime for an instance: the native
writer lease and shared handoff drain/transition locks do not authorize a second
legacy/native process to own the same recipient. No shared fleet root or foreign
recipient path is inferred. Isolated deployments remain self-only; cross-UID
publication stays unsupported and cannot be fixed by widening permissions.

This slice does not migrate real handoff files or initialize a coordinator.
An authorized later rehearsal must map the recipient's private state directory
and preserve its v1 evidence while all affected writers are quiescent.

## Admission and completion

The v1 exchange stays compatible with the existing coordinator and recipients:

- `pending` awaits a claim; cancellation affects known-unclaimed work only.
- `processing` is a claim, including historical claims with unknown acceptance.
- `completed` proves recipient admission. It never proves run or external-effect
  completion.
- `failed`, `cancelled` and `acknowledged` retain their existing terminal meanings.

A native reservation binds the exact dispatch payload and source identity.
The host records a job-specific source namespace containing the dispatch ID,
without inventing Telegram message IDs. The source preserves job ID/type,
original `createdAt`, principal and configured destination. A reused dispatch
with changed content or authority cannot become a new request.

The recipient binds the source to a conversation and calls public native
`Conversation.submit()` with a stable request ID. It commits admission evidence
before moving the v1 file to `completed`. Native submission state and final
answer discovery supply run completion and delivery separately. The native
`bridge.job-admissions` document records these outcomes; completion data never
enters directories consumed by legacy drains.

A native-owned reservation can reconcile a surviving claim after restart,
including a lost submission receipt or file move. The same request ID recovers
the original submission. A historical `processing` claim with no native evidence
stays held for explicit inspection. Session text, a matching prompt and a legacy
`acknowledged` file are not acceptance proof. Unknown or malformed work cannot
be injected. Private-file validation, quarantine and terminal evidence remain
part of the handoff protocol. Each scan handles at most 100 pending files and
100 processing files, prioritizing native-owned claims. Remaining work stays on
disk for later scans or operator inspection. Cancellation-proof checks and
native run lookups each examine at most 100 receipts per pass, with persistent
cursors so older unresolved receipts cannot starve newer work. The retained
receipt document is still read to select each batch. Quarantine preserves
conflicting bytes using a separate filename instead of overwriting older evidence.

A reservation cancelled before claim settles only from a private cancelled file
with the same payload and authority. A bare legacy tombstone or changed payload
leaves the reservation held; it supplies no matching payload proof.

## Conversation behavior

Jobs enter the bound conversation as one-at-a-time follow-up input. They retain
their source time and destination, do not advance the human-idle clock, and do
not turn into steering. A busy human turn delays execution without delaying the
admission receipt until run completion. Previously bound work keeps its
conversation across restart and later rotation.

Scheduled output uses durable final delivery without streaming previews.
Proactive `NO_REPLY` stays silent. Pinned 1.3.0 follow-ups begin after the active
run finishes; they do not join its post-tool continuation. Preview checks also
refresh public live input authority at turn/message boundaries and watch overflow,
so a growing or unknown input set cannot inherit human preview permission.
Human replies retain best-effort previews. Definite
pre-send failures may retry; ambiguous Telegram sends stay uncertain. Neither
native admission nor a v1 receipt makes an external action or send exactly once.
Explicit `/stop` cancellation remains separate from v1 unclaimed-work cancellation.

`npm run inspect` reads counts of handoff states, unresolved claims, native
admissions and run outcomes without starting the scheduler or Telegram transport.
An unsafe directory tree is reported rather than repaired. Unexpected storage
errors stop reconciliation and reach the host failure handler; they do not
advance or silently discard work. Opt-in `/debug` adds
fixed job lifecycle counts without prompts, filenames, paths or destinations.
Conflicting quarantined files retain `.conflict-<uuid>` suffixes; the legacy
recovery CLI does not enumerate those suffixes. They need explicit inspection
alongside the counted failed evidence.

## Validation

Node 24 `npm run check:changed` passed 898 tests in 87 files, with 38 existing
platform/browser skips, including three whole suites. `npm run build` passed,
including the compiled application import. The combined gate took 111 seconds.
The focused recipient/visibility/legacy-exchange gate passed 65 tests in six
files with strict native typechecking.

The tests cover claim recovery, lost native submission acknowledgement,
completed shell-effect recovery, source identity, private profile selection,
idle-clock preservation, bounded fair receipt reconciliation, cancellation
proof and proactive preview suppression. Three real SIGKILL barriers cover
claim, admission and committed shell-effect recovery.

Independent source review prompted exact cancellation-proof reconciliation,
bounded fair run settlement and defensive live-input preview checks. A second
read-only review found no remaining material preview leak in the checked flows.
The proposed same-run scheduled follow-up leak was not reproduced: direct
inspection of pinned 1.3.0 and the held-tool application test establish that
follow-ups wait for a final boundary. Growing-input and watch-overflow fixtures
separately guard preview authority. Earlier capability/profile objects and human
source identities remain unchanged.

These fixtures use synthetic coordinators, providers, effects and transport.
They do not establish live Telegram delivery, Linux service readiness, real
state migration or cross-UID handoff.

## Remaining C5 work

The subsequent [coordinator slice](pi-durable-c5-coordinator.md) adds cron and late
one-shot publication, four-way legacy/native admission and restart coverage, and
coordinator inspection. The [schedule slice](pi-durable-c5-schedules.md) adds
selected heartbeat/webhook execution, their four-way mixed-runtime matrix,
price-watch tasks and schedule-editing selection. The [child slice](pi-durable-c5-children.md)
adds process-owned temporary Harness stores, native orchestration and creation-based
seven-day retirement. Its validation gate remains open. Canonical definitions,
occurrence identities and legacy uncertainty retain their existing owners.
Optional codemode remains separately gated. See the [roadmap](pi-durable-migration-plan.md#c5--native-schedules-and-background-agents).
