# Memory and session search index

The bridge keeps a disposable SQLite/FTS5 search database at
`<stateDir>/search-index.db`. Canonical personal-memory Markdown and Pi session
JSONL are never modified by search operations and remain the only sources of
truth.

## Assistant tools

- `memory_search` searches curated durable notes. It refreshes the memory
  corpus from canonical Markdown, applies the host-bound memory view in SQL,
  and returns stable note IDs, revisions, metadata, ranking, and bounded
  snippets.
- `session_search` searches original conversation evidence. It incrementally
  refreshes only `PI_TELEGRAM_BRIDGE_SESSION_DIR` for the active
  instance/principal and returns stable session ID, entry ID, timestamp, role,
  project, source path/offset, ranking, and a bounded snippet.
- `session_context` expands one `session_search` result into a bounded window
  of nearby turns. It requires the returned session and entry IDs, accepts
  `before`, `after`, and `maxChars` bounds, and never returns an unbounded
  conversation.
- `search_index` reports counts and per-corpus last attempt/success timestamps,
  or explicitly refreshes/rebuilds `memory`, `session`, or `all`.

The tracked Telegram instructions prefer these indexed tools. The
`personal-memory` CLI continues to own note reads and mutations, lint, core
compilation, list/happenings, and a compatibility scan search.

Interactive memory and session searches give their on-demand refresh 1.5
seconds. If refresh fails or exceeds that budget, the tool queries the last
successful index and returns `index.status: "stale"` with a
`refresh_failed` or `refresh_timeout` warning. Explicit `search_index`
maintenance waits for completion and is the operator path for larger rebuilds.

## Refresh and recovery

Memory refresh is an eager transactional rebuild at the current vault scale.
Malformed, unsafe, oversized, and duplicate-ID notes are excluded with bounded
content-free warnings. Failure before replacement preserves the last usable
memory corpus.

Session refresh records device/inode, size, mtime, completed byte offset, and
stable entry IDs per source file. Unchanged files are skipped, append-only
files resume at the committed offset, and rewritten, truncated, or deleted
files reconcile their rows. Source state and FTS rows commit in one SQLite
transaction. An explicit full session rebuild parses bounded configured inputs
first, skips malformed entries with sanitized findings, and replaces all
documents and source checkpoints for the active identity in one transaction.

If the database is deleted, the next search or explicit rebuild recreates it
from canonical sources. If an incompatible schema is encountered, remove only
the derived `<stateDir>/search-index.db` while the bridge is stopped, then run
an explicit rebuild after restart. Never remove the Markdown vault or session
JSONL as an index-recovery step.

## Privacy and failure behavior

Each instance owns its own database. Memory queries require the trusted
principal/memory-view pair. Session ingestion uses the active instance's single
host-bound session directory, not the broader multi-instance roots used by
memory provenance lint.

Thinking blocks, tool-call arguments, binary/base64 content, credential-shaped
text, malformed entries, and oversized content are excluded before session
rows are stored. Warnings and operational errors contain reason codes and safe
source locators, never note bodies, session text, or tool payloads. Search
failure does not fail an unrelated Telegram turn.
