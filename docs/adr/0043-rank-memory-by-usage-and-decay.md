---
status: accepted
relates-to: ADR-0012, ADR-0018, ADR-0020, ADR-0026, ADR-0034, ADR-0037
supersedes-in-part: ADR-0034
---

# Rank memory notes by usage and decay

## Context

Memory search and Jev recall rank notes only by how well they match the
conversation. As the vault grows, the eight candidates Jev judges each turn
become a smaller share of it, and a stale list competes equally with a note
the assistant uses every week. Some notes should never age (facts about
people, allergies, standing preferences); others are time-bound (lists, plans,
a how-to that may go stale). Nothing fails today, at 39 mostly durable notes,
so this change prepares ranking for growth. See `docs/memory-decay-plan.md`.

## Decision

**Labels.** Each note is `durable` or `fading`. Person, preference, recipe,
and reference notes default to `durable`; list, event, and purchase notes
default to `fading`. Unknown types are `durable`. An optional managed note
header, `decay: durable | fading`, overrides the default. The agent sets it
through `prepare_create` or an update patch (`null` clears it), and the user
can edit it in Obsidian. Existing notes are not migrated. A reference type mixes
lasting and perishable notes, so a type-only rule was not enough, and a new
note type would not have fixed mixed references.

**Points.** A note earns 1 point when recall injects it, 3 points when the
agent reads it with `assistant_memory`, and 3 points at its latest edit (the
`updated` header). Each point halves every 90 days.

**Drop.** A `fading` note keeps its place for 30 days after creation. After
that it drops `round(3 * (1 - min(1, points / 3)))` places. Results are sorted
by `position + drop`; on a tie the note with the smaller drop keeps the place,
so a drop of three lands exactly three places lower. Drops are applied after
rank fusion and before the result list is trimmed; keyword-only search fetches
three extra results so lower notes can move up. The search tool and recall use
the same drops. Duplicate checks before creation do not.

**Storage.** Usage is derived from append-only logs in the instance state
directory: injections from `memory-recall.jsonl`, and agent reads from a new
`memory-usage.jsonl` (mode `0600`) with the time and note ID only. The search
extension keeps an in-memory tally, parses only lines appended since its last
refresh, and rereads a replaced or truncated log. The `decay` header is copied
into index schema 4 as a nullable column. The migration clears the memory scan
cache so existing notes are reparsed.

**Failure.** A missing log means no usage. If a log cannot be read, results
keep their match order. A failed read-log write never fails the read.

**Tuning data.** The recall log records each candidate's `drop`.

## Considered options

- **Multiply the fused score by a decay factor:** rejected. Reciprocal rank
  fusion scores near the top are very close together, so any meaningful factor
  lets a note ranked second in both lists pass one ranked first in both. A
  factor large enough to matter at a floor of 0.6 made a faded note act as if
  it ranked around 40th. A bounded drop in places is predictable.
- **Store usage in the search index:** rejected. ADR-0026 makes the index
  disposable; a rebuild would erase the history.
- **Store usage in note headers:** rejected. Every read would rewrite the note
  and create a commit (ADR-0018).
- **Parse session files for reads:** rejected. A dedicated log is simpler and
  carries only the time and note ID.
- **A vector or graph database (Milvus, Neo4j):** rejected. Storage and
  retrieval speed are not the bottleneck at this size, and another service
  would need to stay in sync with the Markdown vault.

## Consequences

- An unused list drops one place after a month, two after three months, and
  three after about eight months. A read or edit in roughly the last three
  weeks restores its full rank. Durable notes never move.
- Search results can differ from pure match order; a fully faded note that
  ranks first lands no lower than fourth.
- Each instance counts its own usage. Intended later behavior for the household
  fleet (ADR-0020): use of a household-scope note on any instance keeps it fresh
  for all of them. Only one instance runs recall today, so this waits until a
  second instance enables recall.
- Whether the agent reading a note right after recall injects it is a real
  choice or a habit is unknown. If most reads follow injections, lower the
  read value for those reads. All constants are initial values to tune from
  the recall log.
- The logs have no rotation; the tally reads each log once per process and
  then only appended lines.
- Decay applies to whole notes. Dated history inside a note belongs in
  Happenings (ADR-0012). Usage never archives or edits a note.
- Wikilinks between notes and following links during recall are tracked
  separately (issue #166).
