---
status: accepted
relates-to: ADR-0011, ADR-0014, ADR-0015
supersedes-in-part: ADR-0014
---

# Filter personal memory by lifecycle status

## Context

Hard deletion is appropriate when the user asks to forget something, but stale
or historical knowledge sometimes needs to remain inspectable without taking
part in ordinary recall or always-present core context. Existing schema-1 notes
also predate lifecycle metadata and must remain usable without a destructive
vault migration.

## Decision

Give every managed note one of three statuses: `active`, `superseded`, or
`archived`. New notes default to `active`; schema-1 notes without the field are
read as active and gain the field on their next CLI mutation. Status is mutable
with the existing revision-checked update operation and does not encode a
structured supersession target; ordinary Markdown links retain that role.

Normal list, lexical search, and happenings queries select only active notes.
Callers may explicitly request one or more statuses to inspect history. Direct
reads by stable ID work for every status. Only active notes contribute `#core`
blocks, while lint continues to report defects in inactive notes without those
blocks affecting core validity.

## Consequences

- Inactive knowledge remains canonical and inspectable but cannot silently
  influence normal recall or the Telegram system prompt.
- Historical lookup must request inactive statuses explicitly.
- Lifecycle changes are reversible and distinct from confirmed hard deletion.
- Missing status remains a bounded schema-1 compatibility rule rather than
  requiring an eager rewrite of the private vault.
