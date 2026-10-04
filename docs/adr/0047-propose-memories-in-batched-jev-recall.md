---
status: accepted
relates-to: ADR-0035, ADR-0037, ADR-0046
supersedes-in-part: ADR-0037, ADR-0046
---

# Propose memory additions and edits in the recall batch

## Decision

For human Telegram turns on instances already opted into Jev memory recall,
reuse the bounded, privacy-filtered search results and one shared-state Jev
request. Ask independent Noul questions for recall and edit per candidate,
plus one overall addition question. A message can warrant all three actions.
Scheduled jobs and reminders retain recall-only behavior.

Proposal criteria require explicit useful assertions, confirmed plans, save
requests, or unambiguous acceptance of a concrete memory offer. Positive and
negative examples distinguish new facts, corrections, duplicates, questions,
hypotheticals, transient moods, quoted text, secrets, and assistant suggestions.
Recent conversation resolves references; it does not supply inferred facts.

Recall retains its 0.5 threshold and four-note budget. Proposals require 0.85,
with at most two edit targets and 2,000 edit snippet characters. These are
initial thresholds, not measured accuracy guarantees. Already recalled
candidates remain in shared state for duplicate checks and edit questions,
but cannot consume the recall budget or be recalled again at the same revision.
Empty search results still receive the addition question on human turns.
Search or canonical revalidation failure suppresses all outputs.

Jev returns probabilities only. Hidden memory-recall context labels edit and
addition suggestions separately from recalled facts. The main agent identifies
the exact fact from the user's message, reads edit targets, verifies duplicates,
and decides whether a concrete offer is worthwhile. Existing explicit-request
or explicit-acceptance requirements remain. This flow never writes memories.
Proposal-only target IDs are not marked as recalled in message details.

Existing decision logs add proposal probabilities and selected target IDs,
revisions, and skip reasons; no conversation or note text is logged. The same
canonical visibility/revision recheck applies to edits, and failures continue
the turn without context. No new capability or external data provider is added.

## Consequences

Human messages with no matching notes now incur one bounded Jev request.
Previously recalled snippets are judged again for edits on subsequent turns.
Similarity filtering and snippets can miss duplicates; the agent must check
the full notes before proposing or saving. Examples are covered structurally
in tests, while real classification quality requires later observation.
