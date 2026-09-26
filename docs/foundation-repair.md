# Assistant foundation repair

## Approved scope

Repair memory, jobs/dispatch, search, places, and their agent-facing boundaries.
Review existing Google, YNAB, reservation, and browser contracts with fixtures;
do not redesign every integration. Preserve canonical personal data and public
commands. Internal migrations may use a short maintenance window and must have
tested data-and-binary rollback. Finish with a verified production rollout.

Excluded: new assistant features, task-manager implementation, semantic search,
Telegram transport redesign, external services, and a generic workflow or
integration framework. Task issues #101/#110–112 remain deferred. Reconcile the
places application boundary with #96 rather than creating a second interface.

The user approved this scope and authorized implementation without further
design approval. This document tracks implementation intent; owning ADRs and
capability docs describe shipped behavior.

## Invariants

1. Cooperating writers cannot report conflicting mutations as successful.
2. Job publication is acknowledged by exact content identity, not file time.
3. Materialized occurrences survive restart. Known-unaccepted work can retry;
   possibly accepted work cannot silently replay.
4. Search never calls incomplete coverage complete or deletes unseen sources
   because a discovery budget or transient I/O failure was reached.
5. A stale place operation cannot overwrite edits, resurrect a deleted place,
   or reset its creation time.
6. Principal/view/credential boundaries and closed tool schemas survive every
   migration, error path, and adapter extraction.
7. Success names the actual boundary crossed. Saved, published, runtime-accepted,
   and externally completed are not interchangeable.

## Implementation decisions

### Memory and definition writes

Use cooperative cross-process serialization around each complete mutation.
For memory, include Git preflight, revision check, canonical mutation, and the
optional Git attempt. Keep persisted-but-uncommitted success explicit. A small
SQLite advisory lock uses the already required Node platform; it holds no
canonical domain data, releases on process death, and has a bounded acquisition
wait. Do not unlink a live lock file. Every mutating CLI and store entry uses
the same protocol. Reads remain unlocked over atomic canonical file replacement.

This is not compare-and-swap against arbitrary Obsidian or Git writers. Preserve
checks for external changes, document the residual check/replace race, and
require quiescent external editing for a strict no-lost-edit guarantee.

For jobs, validate the complete candidate using the scheduler parser before
atomic publication. Hash the exact UTF-8 file bytes. The host records the
observed hash, accepted hash, and rejection outcome; an unrelated state write
cannot acknowledge an edit. Timeout means saved but not acknowledged, not
failure to save. Never restore an old snapshot automatically.

### Scheduled work protocol

Keep `jobs.json` authoritative. Use a coordinator-local SQLite occurrence ledger
for transactions and recovery; do not make canonical definitions a second DB
source of truth. Recipient handoff files remain independently durable and are
reconciled, not claimed to be atomically committed with the coordinator DB.

Identity includes job ID, scheduled instant/event identity, and normalized
definition fingerprint. Definition changes create a different identity and
cancel known-unaccepted old work. Preserve existing cron downtime-skip policy;
retry only materialized occurrences. One-shot reminders still fire late.

| State/boundary | Owner and durable evidence | Recovery |
| --- | --- | --- |
| Pending occurrence | Coordinator ledger contains prompt, identity, target | Retry publication with the same identity |
| Published recipient | Atomic immutable pending handoff; coordinator may lag | Reconcile pending, processing, and terminal evidence before republishing |
| Claimed recipient | Atomic pending-to-processing move before invoking Pi | A surviving claim after restart is uncertain, never automatically pending |
| Known rejection | Pi prompt preflight explicitly rejects before acceptance | Return to pending; bounded repeated attempts, visible errors |
| Accepted recipient | Pi `preflightResult(true)` observed and terminal acknowledgement persisted | Never replay; this proves acceptance, not successful model work or Telegram send |
| Uncertain recipient | Invocation may have started but acceptance cannot be proven | Operator inspects session evidence, then explicitly acknowledges or retries |

Pi's installed SDK documents preflight acceptance independently of the full
run promise. Read that pinned contract before implementing the adapter. A crash
between acceptance and acknowledgement remains uncertain. Never infer rejection
from an arbitrary exception or an error-message substring after acceptance.

No exactly-once promise covers external actions or Telegram sends. Webhook
requests without a trustworthy stable event identity remain distinct deliveries;
do not silently deduplicate separate identical events by body hash. Do not
discard terminal dedup identities while old publications can be retried. Prefer
small retained tombstones over speculative retention windows.

### Search

Persist progress separately from source size: budget exhaustion is resumable,
not EOF. Preserve warning/coverage state across unchanged refreshes. Coalesce
overlapping refreshes rather than publish competing generations. Reconcile
deletion only within fully discovered roots; inaccessible roots are stale, not
empty. Privacy changes must fail closed rather than expose stale private notes.
No background indexing service or semantic retrieval is needed. Measure scans
and prefix hashing before replacing the existing retrieval strategy.

### Places and adapters

Invalidate active source operations transactionally on source edits, deletion,
or another completed move; preserve creation metadata on valid repositioning.
Keep ranking snapshot checks and operation-bound confirmations. A fresh
independent review recommended new source/category revision snapshots; first
test whether transactional invalidation achieves the same required safety
without a schema migration or invalidating harmless category-label changes.

Keep the deterministic places application boundary independent of Pi/Telegram
without a generic UI framework. Split the oversized Google module by transport,
operation parsing, and registration while preserving its exact public union,
bounded execution, sanitized errors, and credential isolation. Peripheral
integration changes must be justified by a failing contract test, not uniformity.

## Execution and verification

Worktree progress (not yet deployed): memory/definition serialization, exact
publication acknowledgement, place invalidation, progressive search coverage,
occurrence ledger, recipient preflight/recovery, and webhook materialization
acknowledgement are implemented. Search and job correctness reviews have driven
regressions and fixes. Google transport/operation parsing/registration are now
separate, with the pre-extraction public schema captured in a regression
snapshot. Failing fixtures drove descendant cleanup and transport redaction,
browser provider pinning, stale-PID refusal, serialized startup and launch-bound
cleanup, blocked/date/party reservation checks, and typed bounded YNAB
projection. Places now has one application command boundary for the tool and
native Telegram section, private reply-based text collection, single-use
draft-bound callbacks, and transactionally revision-bound deletion confirmations.
Google transport uses the same resolved runtime snapshot as input validation.
Offline migration now validates a complete terminal legacy handoff graph, seeds
only provable one-shot suppression, and preserves original evidence. Paired
state/unit/application-binary snapshots and pre-start restoration are rehearsed
on synthetic data, including source/destination corruption and post-start rewind
refusal. Deployment quiesces all discovered writers, keeps failure holds, and
uses a startup condition to enforce an interrupted maintenance hold on reboot.
Latest full check/build passed 593 tests; shell syntax and recovery guard/path
checks are clean.

Remaining: the disposable target-systemd guard smoke test, production inventory,
and verified production rollout. Fresh recovery
reviews drove regressions for unproven fired IDs, post-copy digest checks,
interrupted enablement, and release symlink containment. The final narrow
Places callback review found no new issues. No production state or service has been changed.
The first read-only production connection attempt could not resolve
`lyon-server`; a second read-only attempt failed with the same DNS error. Host
access remains necessary for the platform check, inventory, and rollout. No
push or merge is safe before that transition evidence is available.

1. Add failing regressions for the reviewed defects; make the smallest repairs.
2. Repair memory and definition mutation protocols, including multi-process and
   killed-writer tests. Preserve explicit partial-success outcomes.
3. Implement occurrence/recipient recovery with tests at every durable boundary,
   exact acknowledgement, definition edits, startup, and interrupted shutdown.
4. Repair search continuation/discovery and place transitions independently.
5. Extract only necessary adapters, reconcile #96, and run targeted integration
   fixtures without production accounts, browsers, credentials, or services.
6. Run independent correctness and simplification reviews; resolve every finding.
   Run `npm run check` and `npm run build` after code changes.
7. Rehearse migration, backup restore, and interrupted recovery on synthetic
   state. Quiesce actual writers for rollout, preserve old state and binaries,
   compare content-free counts/hashes, and verify every fleet instance. Never
   restore binaries alone over incompatible state. If production access or a
   safe migration boundary is unavailable, report the exact blocker.

An independent read-only design review endorsed incremental domain repair and
the jobs ledger, but rejected vague acceptance semantics, mtime acknowledgements,
destructive partial search rebuilds, and unbounded adapter refactoring. These
constraints are reflected above; implementation review must verify them.
