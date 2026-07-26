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

A repo-local `search` extension exposes three bounded tools:

- `memory_search` for curated durable knowledge;
- `session_search` for original conversational evidence; and
- `search_index` for explicit status, refresh, and rebuild operations.

These are separate assistant choices. The personal-memory CLI continues to own
CRUD, lint, core compilation, full-note reads, and a compatibility scan search,
but tracked assistant guidance prefers `memory_search` whenever the indexed
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
