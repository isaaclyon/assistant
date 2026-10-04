# Memory recall diagnostics

Automatic recall and proposals append one record per qualifying turn to the
instance's private `memory-recall.jsonl`. Existing outcomes, timings, candidate
decisions, and optional Jev usage remain unchanged. A failed attempt now adds
`failure` with safe fields:

- `stage`: index opening, initial canonical refresh, embedding preparation,
  post-embedding refresh, candidate search, revalidation refresh, or revision
  lookup. Generic dependency failures use search, judge, or revalidate; other
  unexpected exceptions use unexpected.
- `reason`: exception, refresh_timeout, refresh_failed, or refresh_incomplete.
- `errorType`, `code`, `sqliteCode`: recognized exception types and a small
  allowlist of system/domain/SQLite codes when available. Arbitrary names or
  codes are omitted or classified as unknown.
- Incomplete refresh adds distinct warning categories (`IO_ERROR`,
  `UNSAFE_ENTRY`, `MALFORMED_NOTE`, `DUPLICATE_ID`) and scan/warning truncation
  flags. Warning paths and note counts are excluded.

For example, candidate_search with INVALID_INPUT points to generated search
requests, while initial_refresh with refresh_failed and SQLITE_BUSY points to
database contention. refresh_incomplete with IO_ERROR indicates canonical
discovery/read coverage was incomplete; it does not identify the unreadable
file. refresh_timeout means the interactive budget expired; the underlying
tracked refresh may still complete afterward.

Never log raw error messages, stacks, paths, query text, note text, keys, or
provider response bodies to get more detail. Unknown exceptions intentionally
retain only the stage and category. Embedding provider failure that falls back
successfully to keyword search remains a successful recall attempt.

## Generated query limit

Recall filters content words and expands them into quoted FTS terms joined
with OR. The generated expression must fit the indexed search's 512-code-unit
limit too. Keep only complete terms that fit; skip oversized terms and continue
considering shorter ones. The original bounded conversation queries still go
to embeddings unchanged. Explicit memory search keeps its existing behavior.

This fixes a reproduced INVALID_INPUT failure where an otherwise valid recent
message expanded beyond the limit and aborted the whole recall batch after
embedding. Old search_failed records have no underlying diagnostics, so this
reproduction cannot prove the cause of any particular historical failure.

Failures still suppress recall and proposals and let the agent turn continue.
This change does not alter canonical refresh, privacy, approval, or timeout
requirements.
