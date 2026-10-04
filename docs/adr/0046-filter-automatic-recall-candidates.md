---
status: accepted
relates-to: ADR-0034, ADR-0037, ADR-0038
supersedes-in-part: ADR-0037
---

# Filter weak candidates before automatic memory recall

## Decision

Apply a generous candidate filter to automatic recall only, before per-query
rank fusion and interleaving. Semantic sections require cosine similarity
at least 0.18. Lexical retrieval uses quoted content tokens joined with OR,
excluding a small English common-word list. A meaningful keyword match remains
eligible even below the semantic floor; names, numbers, and non-English tokens
remain eligible. BM25 is corpus-dependent, so it has no numeric cutoff.

Explicit assistant_memory_search retains its existing retrieval behavior.
Date-overlap candidates remain independently eligible under ADR-0038.
Recent conversation queries still support short follow-ups. All visibility,
canonical refresh, revision, deduplication, and eight-candidate limits remain.
Jev still applies the final 0.5 relevance threshold. If retrieval yields zero
candidates, the existing recall path skips Jev and logs no_candidates.
Embedding failures use the same content-word lexical filter.

## Evidence and limits

A live text-embedding-3-small evaluation used synthetic notes, not private
memories, with the production model and 1,536 dimensions. Against five notes
covering dining, an allergy, gift interests, travel, and shopping:

- "what day is today": highest similarity 0.177.
- "how many teaspoons in a tablespoon": highest similarity 0.031.
- "somewhere we can hear each other" versus quiet dining: 0.198.
- "book dinner Friday" versus quiet dining: 0.419; versus shellfish allergy: 0.193.
- A birthday gift query versus the recipient's interests: 0.565.
- "when is our trip" versus a travel plan: 0.482.

The 0.18 floor rejects the unrelated examples while retaining these indirect
matches. This small sample supports an initial permissive floor, not a
calibrated relevance probability or a guarantee of recall. Weak matches can
still qualify, and useful matches below the floor can be missed unless lexical,
temporal, or another conversation query retrieves them. Common-word filtering
is English-focused and intentionally conservative. Jev remains necessary.

Regression tests verify the semantic boundary, weak-match rejection, keyword
rescue, common-word-only fallback, follow-up context, and unchanged explicit
search. Existing tests cover privacy and skipping judgment for zero candidates.
