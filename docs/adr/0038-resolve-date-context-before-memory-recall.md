---
status: accepted
relates-to: ADR-0002, ADR-0026, ADR-0033, ADR-0037
---

# Resolve date context before memory recall

## Decision

Use exactly pinned `chrono-node` 2.10.1 for local English natural-language
date parsing. A small shared module adds inclusive calendar intervals for
weekends, weeks, months, and years. No network request or model is needed.
Date hints preserve the original message; they are interpretations, not
confirmed plans or authorization to store personal memory.

The host always binds the fork's existing prompt-preparation callback,
independently of idle rotation or Jev routing. After any session replacement,
it resolves the bounded human text using the original `sentAtMs` persisted
in the durable inbox and the instance process's IANA timezone (the same
source as Telegram's time display). It does not use the optional `[time]`
line, server UTC date, or dequeue time. Legacy rows without a sent timestamp
receive no date hints. Grouped turns use the fork's first-message timestamp.

A token-owned process-local handoff connects the compiled host to the
source-loaded search extension. It is consumed once by a matching Telegram
prompt at `before_agent_start`. A different human prompt drops it; job prompts
cannot consume it. The host releases the binding at teardown. Quoted reply
and forwarded context, attachment/output metadata, code, and URLs are excluded.
Prompts that incorporate aborted-message history do not match and receive no
hints rather than assigning one timestamp to several messages.

Parsing is bounded to 16,384 characters and eight ranges plus eight unresolved
phrases. Dates are `YYYY-MM-DD`, with inclusive ends. Calendar arithmetic uses
a UTC surrogate of the sender's wall clock. Chrono receives the same wall-clock
fields in a local surrogate because its relative-date merge refiners drop
timezone overrides. Only its calendar components are read; hints deliberately
describe dates, not exact appointment instants. Weekends
are Friday–Sunday. Next/upcoming weekend starts on the first Friday strictly
after the reference date; this weekend is the current Monday-based week's
Friday–Sunday. Weeks are Monday–Sunday. Conventions accompany the hints.
Ambiguous weekday and numeric-date wording is labeled. Recognized dependent
expressions such as "two days after we arrive" remain unresolved for the agent.
The first version supports English self-contained dates, not arbitrary
conversation-dependent reasoning, recurring schedules, or holiday calendars.

The search extension supplies these hints even with recall disabled, no
memory view, or a failed vault/provider. A hidden `date-context` custom message
holds the context when no memory is recalled; otherwise it accompanies the
existing `memory-recall` message and its note-identity details. The system
prompt remains unchanged. Hints persist in session history but do not become
durable personal memories or user-authored session-search evidence.

## Date-aware recall

For opted-in recall, the same resolved ranges go to candidate retrieval and
Jev's conversation state. In addition to hybrid search, scan currently visible
active note sections for explicit dates with years and overlapping intervals.
This reuses the visibility-filtered semantic store after canonical refresh;
created/updated timestamps and provenance footnotes do not count as events.
No schema migration or canonical-note rewrite is needed. Relative dates in
old notes are never resolved against the current clock. Saving guidance asks
the agent to write absolute ISO intervals for explicitly authorized plans.

Interleave date and content candidates within the existing eight-note budget,
deduplicate by note ID, and give overlapping candidates snippets containing
their dates. Query-word overlap ranks the date matches, so a matching place
helps prioritize a trip. Jev still judges relevance, now with the reference
and ranges; temporal coincidence alone is insufficient. Existing post-inference
canonical refresh, scope/status filtering, revision revalidation, injection
limits, and content-free recall logs apply unchanged.

## Limits

This is bounded retrieval, not a guarantee to surface every relevant event.
Dates separated across note sections, dates without years, and unsupported
phrases can be missed. A cancelled plan can remain a candidate until corrected
or rejected by the relevance judge. Date scanning is linear in visible note
sections, matching the existing personal-vault semantic scan; a persistent
temporal index is deferred until measurements warrant one. Parser failures
omit hints and leave the human turn available.

Reference: [Chrono](https://github.com/wanasit/chrono).
