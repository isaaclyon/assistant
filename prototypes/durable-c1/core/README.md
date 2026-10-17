# C1 native control and recovery probes (prototype only)

Claim: public pi-durable 1.3.0 APIs can implement the approved source, queue,
recovery and storage boundaries without loading the coding-agent SDK. Minimum
proof: deterministic assertions against real Harness/SQLite, plus process death
at explicit admission and tool-result boundaries. Retain as prototype-only
migration evidence. Scope is these fixtures and helpers, not a deployable host;
each combined verification command has a 180-second budget.

## Evidence

- `core.test.ts`: the upstream 24-case public Storage conformance suite runs on
  the Node SQLite adapter with WAL and FULL verified on every open. Eight controls
  cover durable answer/input deduplication, failed-run FIFO wake-up using an
  idempotent empty model write, normal follow-up versus explicit steering at a
  tool boundary, task-only abort versus conversation stop, and registration of a
  previously blocked task definition after reopen. Concurrent enqueue/wake tests
  exercise both invocation orders and assert one admission per source and FIFO.
- `crash.test.ts` / `worker.mjs`: real SIGKILL after native admission but before
  source receipt/inbox removal; reopen the existing `src/inbox.ts` buffer and
  native store, resume through a read tool, and retain source submission,
  destination and original timestamp despite epoch rotation. Changed payloads
  under the same source identity fail. A new source uses the reserved epoch.
  Grouped-message attachment metadata survives replay through this source
  protocol; identical replay retains one admission and changed attachments fail.
  A second SIGKILL occurs after a read result commits; reopen finishes the run
  without executing that read again.
- Fatal storage injection rejects the triggering and subsequent submissions.
  A deliberately cancellation-ignoring tool prevents cooperative close; the
  prototype supervisor exits with code 42 after its 150ms watchdog. Reopen
  confirms that rejected input never entered history. This is a synthetic
  `Storage.commit` failure, not physical disk or power-loss testing.
- A separate child process owns and closes its SQLite store, then exits before
  the parent removes the child directory. Reopened parent history retains a
  correlation receipt and contains no raw child transcript. This proves the
  small disposable-store architecture; expiry calculation, stale writer leases,
  task cancellation races, OS confinement and the C5 lifecycle are unimplemented.
- `boundaries.test.ts` / `delivery.mjs`: a restart scan discovers completed answers from
  durable source bindings and request IDs, including a missing admission receipt,
  without carrying a submission ID or destination over from the caller. A definite pre-send failure can retry; a missing or
  lost acknowledgement, or a surviving `sending` intent, remains uncertain and
  cannot automatically resend. A verified synthetic message receipt suppresses
  subsequent sends. Changed destinations fail.
- A small read-only resolver dispatches old JSONL anchors to the existing parser
  and native instance/store/conversation/entry locators to public entry reads.
  It retains old session/entry/timestamp identity, resolves after reopen, and
  rejects unknown backend/store, foreign principal and changed timestamps.
  Native message time stays separate from original source time. The host supplies
  allowed stores; citations cannot supply paths. This does not implement the
  complete search/context/provenance tool API or compaction/index rebuilding.
- The existing capability loader selects modules before import and rejects a
  selected symlink outside the release. Recovered stored selection of an absent
  extension cannot load it; a task-owned child inherits the same restriction.
  This tests the native registry boundary, not the eventual confined child host.

## Limits

`ingress.mjs` and `delivery.mjs` are small synthetic application protocols using
native documents and submissions. The production transport, host polling,
rotation scheduler, job handoffs, source-envelope normalization and delivery
reconciler do not call them. Delivery tests use a synthetic sender rather than
Bot API receipts; they do not prove exactly-once Telegram delivery. The replay
cases cover the named barriers, not every possible crash window.

The TypeScript tests compile with strict checking. Runtime helpers are JavaScript
with `checkJs: false` and behavioral coverage. The test build emits fixture code;
it is not a service release. All state is synthetic and disposable. No private
Harness SQL tables, ambient credentials or live transport are used.
