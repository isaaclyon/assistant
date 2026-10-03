---
status: accepted
relates-to: ADR-0020, ADR-0033, ADR-0034, ADR-0037
supersedes-in-part: ADR-0034
---

# Keep operational feature flags in instance configuration

## Decision

Use the existing private per-instance environment file for optional behavior.
A small typed registry owns each flag's enabled value and default; consumers,
environment-file preflight, and startup use the same validator. Invalid and
empty values fail validation. No remote flag service, runtime toggle store, or
new capability-loading path is introduced. Changes require an instance restart.

Keep `PI_TELEGRAM_MEMORY_RECALL=jev|off` and
`PI_TELEGRAM_SESSION_ROUTING=jev|off`, both off when unset. Add
`PI_TELEGRAM_MEMORY_SEMANTIC=on|off`; unset preserves existing key-gated
embedding behavior. Explicit `off` suppresses embedding requests for automatic
recall, explicit search, and index warming, without deleting the key or cache.
Keyword search and applicable date retrieval remain available. A flag cannot
grant memory visibility or load capabilities outside the selected profile.

Automatic recall continues to search first, deduplicate revisions, and judge
the remaining candidates in one Jev request. There is no new classifier before
search. Capture optional provider-reported input tokens in the existing private
recall log so cost can be evaluated alongside latency and relevance. Missing or
invalid accounting does not invalidate otherwise usable judgments and is never
treated as zero cost. Logs retain no conversation or note text; current provider
rates belong in estimation documentation rather than runtime billing logic.

## Consequences

Existing instance settings keep their behavior. Operators can disable external
embedding calls independently of recall and routing. Deployment retains the
settings, and testing requires no live service changes. Cost measurement covers
reported recall judgments only, not embeddings, other Jev use, or assistant
inference. Further flags are added when an actual optional behavior needs one.
