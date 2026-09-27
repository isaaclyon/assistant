---
status: accepted
relates-to: ADR-0011, ADR-0020, ADR-0026
supersedes-in-part: ADR-0026
---

# Add hosted semantic retrieval to personal memory search

## Context

Keyword retrieval misses memories expressed differently from a question.
Personal-memory search should find paraphrases while preserving exact names,
stable provenance, privacy filtering, and the existing canonical Markdown vault.
The user approved hosted OpenAI embeddings for this first semantic-search step.

## Decision

Keep one memory-search tool and the existing per-instance derived SQLite
database. Combine FTS/BM25 results with an exact cosine scan of cached OpenAI
`text-embedding-3-small` vectors at 1,536 dimensions. Rank fusion uses the
positions in each list rather than comparing BM25 and cosine values directly.
The highest-scoring section represents each semantic note candidate; the
final list contains distinct note IDs and preserves revisions and metadata.

Configuration is one private API-key file pointer,
`PI_TELEGRAM_OPENAI_API_KEY_FILE`, selected per instance. It explicitly enables
the external embedding data path. The transport uses a fixed endpoint, validates
the response shape and vectors, bounds input/response sizes, rejects redirects,
and has a 2.5-second network timeout without retries. Errors expose no payloads.

The search extension refreshes canonical notes before selecting any embedding
input. SQL applies the trusted principal/view, lifecycle, and type filters before
note text reaches OpenAI. Embeddings cover bounded title/tag/body sections, with
headings used as section boundaries and UTF-8-safe splits for long sections.
Schema 3 stores vectors by note ID, revision, content hash, and model/chunking
version; snapshot publication removes obsolete revisions. Late embedding writes
are accepted only for a still-indexed revision. No canonical files are changed.

Each search makes at most one embedding batch containing the query and 32
missing sections. Explicit memory index maintenance can warm the same bounded
batch. Large vaults report partial semantic coverage and progress across calls.
After inference, the extension refreshes canonical visibility again before
selecting results, and holds its database handle until the entire operation ends.
Current keyword results remain available on embedding failures. Canonical
refresh failure retains ADR-0026's fail-closed behavior.

## Consequences

- Paraphrases can enter the candidate list while exact keyword matches remain
  a separate ranking signal. Tests cover mechanics with synthetic vectors;
  relevance and latency on personal queries still need empirical evaluation.
- Warm searches require one query-embedding request and local retrieval. Cold
  indexing adds paid note embeddings in bounded batches. There is no worker,
  vector service, new dependency, or model-selection configuration surface.
- The vector scan is linear in eligible sections and deliberately targets a
  modest personal vault. A dedicated approximate index needs measured evidence
  that this scan is too slow.
- Missing configuration keeps keyword-only behavior. Configured provider/key
  failures are distinguishable from partial coverage and an empty result.
- Scores order candidates; they are not calibrated relevance probabilities.
  Applying a preference to the current situation remains the assistant's task.
- Conversation history, automatic memory retention, and Jev assessment are
  outside this change.
