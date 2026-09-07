---
status: accepted
relates-to: ADR-0009, ADR-0011, ADR-0017, ADR-0020
---

# Use private derived FTS indexes for memory and session search

## Context

The bounded Markdown scan can retrieve durable personal memories, but it cannot
efficiently search growing vaults or original Pi/Telegram session evidence.
Session history and canonical Markdown have different provenance, lifecycle,
and privacy semantics, so one undifferentiated search result would obscure
which source supports an answer.

## Decision

Create one disposable SQLite/FTS5 database beneath each active instance's
private state directory using Node's built-in `node:sqlite`. Canonical Markdown
notes and append-only Pi session JSONL remain the only sources of truth.
Deleting the database loses no canonical information.

Keep memory and session documents in separate source and FTS tables. Memory
rebuilds reuse the existing managed-note parser and retain stable note ID,
relative path, revision, lifecycle, scope, owner, timestamps, tags, title, and
body. Memory visibility is applied in the SQL query before snippets or rows are
serialized.

Session refresh accepts only host-configured absolute roots for the active
instance/principal. A bounded streaming parser excludes thinking, tool
arguments, binary/base64 payloads, credential-shaped text, malformed entries,
and oversized content before storage. Incremental state commits source identity,
size, mtime, completed byte offset, and stable entry IDs atomically with the
derived rows. Rewritten, truncated, and deleted files reconcile stale rows.

Persist parser coverage, warnings, oversized-line discard state, and all seen
entry IDs separately from file size. Budget-limited files resume even without
new bytes. Bounded discovery rotates across sources and never deletes unvisited
files; failed root discovery retains stale state. Coalesce identical refreshes
and serialize each corpus across processes with a SQLite advisory lock.
Session rebuild replaces only successfully parsed sources, not the whole corpus
after a partial scan. Metadata checks across all discovered files distinguish a
per-pass processing budget from incomplete corpus coverage. Schema 2 preserves
schema-1 rows and checkpoints while widening session uniqueness to include the
principal and adding private memory staging.

Interactive search fails closed with no results on incomplete, failed, or
timed-out refreshes. Memory stages changed notes across bounded passes and
publishes only after all discovered metadata matches staged coverage. Incomplete
discovery preserves its previous snapshot but does not expose it as current. This trades
availability for privacy and honest coverage at the documented scan limits.

A repo-local `search` extension exposes three bounded tools:

- `assistant_memory_search` for curated durable knowledge;
- `assistant_session_search` for original conversational evidence; and
- `session_context` for a bounded before/after window around a session result;
- `search_index` for explicit status, refresh, and rebuild operations.

These are separate assistant choices. The personal-memory CLI continues to own
CRUD, lint, core compilation, full-note reads, and a compatibility scan search,
but tracked assistant guidance prefers `assistant_memory_search` whenever the indexed
tool is available. Search tools refresh on demand and never write canonical
sources.

## Consequences

- Exact and phrase search is faster and returns inspectable stable provenance.
- Memory and session evidence cannot be confused in one result contract.
- Each fleet instance has an isolated database and every query requires its
  trusted instance/principal context.
- Database corruption or deletion is recoverable through a full rebuild.
- Explicit refresh remains on the interactive request path initially. Live
  event hooks remain deferred until measurements show they are necessary and
  can never delay or fail an unrelated turn.
- The compatibility Markdown scan remains available for recovery and older
  callers, but it is no longer the assistant's preferred retrieval path.
