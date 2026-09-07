# Memory and session search index

The bridge keeps a disposable SQLite/FTS5 search database at
`<stateDir>/search-index.db`. Canonical personal-memory Markdown and Pi session
JSONL are never modified by search operations and remain the only sources of
truth.

## Assistant tools

- `assistant_memory_search` searches curated durable notes. It refreshes the memory
  corpus from canonical Markdown, applies the host-bound memory view in SQL,
  and returns stable note IDs, revisions, metadata, ranking, and bounded
  snippets.
- `assistant_session_search` searches original conversation evidence. It incrementally
  refreshes only `PI_TELEGRAM_BRIDGE_SESSION_DIR` for the active
  instance/principal and returns stable session ID, entry ID, timestamp, role,
  project, source path/offset, ranking, and a bounded snippet.
- `session_context` expands one `assistant_session_search` result into a bounded window
  of nearby turns. It requires the returned session and entry IDs, accepts
  `before`, `after`, and `maxChars` bounds, and never returns an unbounded
  conversation.
- `search_index` reports counts and per-corpus last attempt/success timestamps,
  or explicitly refreshes/rebuilds `memory`, `session`, or `all`.

The tracked Telegram instructions prefer these indexed tools. The
`personal-memory` CLI continues to own note reads and mutations, lint, core
compilation, list/happenings, and a compatibility scan search.

Interactive memory and session searches give their on-demand refresh 1.5
seconds. If refresh fails, exceeds that budget, or reports incomplete coverage,
the tool returns no results and a stale/partial status with a bounded warning.
It never serves an old privacy view as current. Explicit `search_index`
maintenance waits for completion; repeated refreshes resume bounded memory and session
scans. Concurrent identical refreshes coalesce, and per-corpus SQLite advisory
locks serialize refreshes across handles and processes.

## Refresh and recovery

Memory refresh stages parsed notes privately and publishes a transactional snapshot
only after all discovered sources have current coverage.
Malformed, unsafe, oversized, and duplicate-ID notes are excluded with bounded
content-free warnings. Failure before replacement preserves the last usable
memory corpus without serving it as current. Incomplete discovery, I/O errors,
and unprocessed notes prevent replacement. The default budget allows 10,000
changed notes per pass. Staging survives restart and unchanged notes reuse their
parsed document or exclusion warning. Each pass checks all source metadata
(including ctime) and rechecks it before publication; edits invalidate staged
visibility. Deleted notes and duplicate IDs reconcile across the whole snapshot.

Session refresh records device/inode, size, mtime, completed byte offset, and
stable entry IDs (including excluded entries), coverage, and warning state per
source file. Complete unchanged files are skipped, append-only
files resume at the committed offset, and rewritten, truncated, or deleted
files reconcile their rows. Source state and FTS rows commit in one SQLite
transaction. Budget exhaustion is not EOF: unchanged budget-limited files resume
at their checkpoint, including when skipping an oversized line across passes.
Context lookup starts near indexed offsets rather than scanning from byte zero.
Full rebuild forces bounded per-source replacement, preserving unvisited sources.
Parsing rotates across the file budget (10,000 by default). Metadata discovery
checks all files, so coverage becomes complete once every current source has a
clean checkpoint, even across several bounded passes. New or changed unvisited
files invalidate coverage. Failed root discovery never means an empty root.
Only fully discovered roots authorize deletion; deconfigured roots lose their
indexed rows. Source identity and prefix checks reject observed concurrent edits,
but unchanged detection is metadata-based, not protection against deliberately
metadata-preserving rewrites.

Schema 2 migrates schema 1, retaining existing rows and checkpoints, widening
session identity uniqueness to include the principal, and reparsing sources that
lack coverage state. The database remains disposable.

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
