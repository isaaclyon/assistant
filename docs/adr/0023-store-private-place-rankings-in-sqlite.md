---
status: accepted
relates-to: ADR-0009, ADR-0020
---

# Store private place rankings in per-instance SQLite

## Context

The Telegram places feature needs one ordered list per category, resumable
binary insertions, idempotent button handling, and atomic publication of a
completed rank. Unlike personal memory, this data is highly structured and its
ordering invariants require transactions. Repository releases are immutable,
while each fleet instance already owns a durable mutable state tree.

## Decision

Store canonical place-ranking data in `<stateDir>/places.db`, where `stateDir`
is already isolated per configured assistant instance. Use Node's built-in
`node:sqlite` API rather than adding a database service or dependency. The file
is mode `0600` under the host-created mode-`0700` state directory.

The database uses a `PRAGMA user_version` migration sequence. Version 1 stores
categories, published places with contiguous positions, insertion sessions,
and comparison actions. An insertion is provisional until one transaction
inserts the ranked place and marks its session complete. Comparison actions
have unique delivery IDs and optimistic session revisions, so redelivery is
idempotent and stale writers fail without partially advancing state. Completed
and cancelled sessions retain bounded comparison history for undo and audit;
they are not agent conversation memory.

Later migrations add comparison undo state, provisional move/re-rank metadata,
and a per-category mutation revision. A completed addition records the category
revision it produced, so any later edit, insertion, move, re-rank, or deletion
invalidates its immediate Undo action without relying on timestamp ordering.

Use WAL with full synchronous commits. Create consistent backups through
SQLite's online backup API, not by copying a live WAL database. A JSON export
contains only published categories and places; a SQLite backup is required to
recover active insertions and history. Place contents must not be written to
logs or committed to the repository.

The MVP enables this store only for the `personal-isaac` capability profile on
its host-enforced private Telegram surface. Database separation is by assistant
instance, and insertion ownership uses the trusted runtime instance ID and
principal—not user-selected chat input. Shared or collaborative rankings
require a later identity and product decision.

The tool and Telegram section share one `PlacesApplication.execute` command
boundary, including read queries and operation-bound confirmations. The service
and store retain ranking and persistence invariants; Telegram views, provisional
name/category drafts, and reply capture remain transport concerns. This is the
application-boundary reconciliation for issue #96, not a second UI framework.

Delete confirmations snapshot the existing category mutation revision and
compare it inside the deletion transaction. Cancel confirmations bind the exact
insertion revision. Section callback capabilities are one-use, expire after ten
minutes, and bind category/sentiment selection to its specific draft. Text entry
uses fresh standalone prompts with unique references and only one pending input
per private chat. Because raw update handlers run before default authorization,
the handler requires the already-authorized section's exact private actor/chat,
an exact fresh bot-prompt body, and a newer reply-target message ID. Failed result
delivery cannot forward a possibly saved input to Pi for another execution.

Persist the short-lived direct add draft used before an insertion exists in
`<stateDir>/places-add-draft.json`. Write it atomically with mode `0600` and
keep only the place name plus optional category ID. Restore it at session start
so `/place_rankings` and stale category or sentiment buttons reopen the saved
step with the place name instead of losing it. Clear it when an insertion starts,
and ignore it after 24 hours or when malformed. The draft is recovery state, not
canonical ranking data, so it stays outside the ranking database.

## Consequences

- A direct add flow that has not started ranking survives a session reset
  without showing an unrelated ranking view.

- Rankings and unfinished comparisons survive process restarts, session
  rotation, extension reload, and immutable-release deployment.
- A move or re-rank can remain provisional without exposing a partial ordering.
- Database corruption or an unsupported future schema fails closed instead of
  silently rebuilding and losing personal data.
- Operators must back up `places.db` with the supported backup operation while
  the bridge is running, or stop the instance before copying the database and
  any WAL files manually.
- SQLite is canonical for this feature; a JSON export is portable but does not
  preserve resumable interactions or comparison history.
