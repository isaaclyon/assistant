# Memory usage and decay plan

Status: approved, not implemented. Write the ADR with the implementation; it
relates to [ADR-0026](adr/0026-use-derived-fts-indexes-for-memory-and-session-search.md),
[ADR-0034](adr/0034-hybrid-semantic-memory-search.md), and
[ADR-0037](adr/0037-recall-memory-with-jev-before-each-turn.md).

## Problem

Memory search and Jev recall rank notes only by how well they match the
conversation. As the vault grows, the eight candidates Jev judges each turn
become a smaller share of it, and a stale list or plan competes equally with a
note the assistant uses every week. Nothing is failing today (39 notes, most
of them durable), so this change prepares ranking for growth.

The goal: notes that keep getting used stay near the top, and time-bound notes
that stop being used drift down a few places. Notes that should never age,
such as facts about people, never move.

## Approved scope

- **Usage points.** A note earns 1 point when recall injects it, 3 points when
  the agent reads the full note with `assistant_memory`, and 3 points at its
  latest edit (its `updated` timestamp). Each point loses half its value every
  90 days.
- **Decay labels.** Every note is `durable` or `fading`. The type sets the
  default: person, preference, recipe, and reference are `durable`; list,
  event, and purchase are `fading`. An optional note header field,
  `decay: durable` or `decay: fading`, overrides the default. The agent sets it
  when saving something time-bound, and the user can edit it in Obsidian.
- **Grace period.** A `fading` note keeps its rank for 30 days after creation.
- **Ranking.** After the grace period, a `fading` note drops up to three places
  in the result list: `round(3 * (1 - min(1, points / 3)))`. A note read within
  the last few weeks drops nothing. A never-used note drops three. Durable
  notes drop nothing. The same adjustment applies to the search tool and to
  recall candidates, in hybrid and keyword-only search.
- **Tuning data.** The recall log records each candidate's drop.

## Out of scope

- Wikilinks between notes, link suggestions, and following links during
  recall (separate issue).
- Shared freshness across household instances. Intended behavior: using a
  household-scope note on any instance keeps it fresh for all of them. Only
  `isaac` runs recall today, so this is recorded in the ADR and built when a
  second instance enables recall.
- Decay of individual lines or sections inside a note. Dated history belongs
  in Happenings ([ADR-0012](adr/0012-entity-happenings-in-markdown-notes.md)).
- Automatic archiving, any write to notes caused by usage, and showing a
  "fading" marker to the agent.

## Approach

**Usage storage.** The search index is disposable, and usage written to note
files would create a commit per read (ADR-0018). Usage therefore comes from
append-only logs in the instance state directory:

- Injections: the existing `memory-recall.jsonl` (candidates with result
  `injected`).
- Reads: a new `memory-usage.jsonl` (mode `0600`), one line per successful
  `assistant_memory` read with the time and note ID only. The memory extension
  finds the state directory through `PI_TELEGRAM_BRIDGE_STATE_DIR`.

The search extension keeps an in-memory tally per note ID, reads only lines
added since its last read, and rebuilds the tally from both logs after a
restart. Deleting or rebuilding the search index loses nothing. If a log
cannot be read, search ranks as it does today, with no drops.

**Ranking.** Search fuses the keyword and meaning-based rankings with
reciprocal rank fusion (RRF, k = 60). RRF scores near the top are very close
together, so multiplying a score by any meaningful penalty lets a note ranked
second in both lists pass one ranked first in both. A bounded drop in places
is predictable instead: a fully faded note that ranks first lands no lower than
fourth. Sort fused results by `position + drop`, with ties broken by the
original position, and apply this before trimming to the requested limit so
lower notes can move up.

**Likely files.**

- `.pi/skills/personal-memory/scripts/store.mjs`: optional `decay` managed
  key, validation, rendering; create and update accept it. No note migration.
- `.pi/extensions/memory.ts`: `decay` in `prepare_create` and update patches,
  a prompt guideline for time-bound notes, and the read log.
- `src/search-index-schema.ts`, `src/search-index.ts`: index schema 4 adds a
  nullable `decay` column to `memory_document` (additive migration).
- New `src/memory-usage.ts`: log parsing, tally, labels, and the drop formula,
  with an injected clock.
- `src/memory-semantic.ts`, `src/search-coordinator.ts`: apply drops after
  fusion and in keyword-only search.
- `src/memory-recall.ts`, `.pi/extensions/search.ts`: wire the tally and log
  each candidate's drop.
- Docs: new ADR, `docs/search-index.md`, `ARCHITECTURE.md`, the
  personal-memory skill, and `.pi/telegram/AGENTS.md`.

## Acceptance criteria

1. A `fading` note past its grace period with no usage ranks below an equally
   matched note that was read recently.
2. `durable` notes never change position.
3. A note marked `decay: fading` fades even when its type defaults to
   `durable`, and `decay: durable` stops a list or event from fading.
4. A `fading` note younger than 30 days does not drop.
5. A fully faded note that ranks first lands no lower than fourth.
6. Deleting and rebuilding the search index preserves usage scores.
7. If a usage log cannot be read, search and recall return today's ranking.
8. Reading or injecting a note never changes its Markdown file or creates a
   commit.
9. The recall log records each candidate's drop and no note text.
10. `npm run check` and `npm run build` pass. Tests use a fake clock and
    synthetic logs; no paid calls or live service restarts.

## Tuning after launch

Starting values: 1/3/3 points, 90-day half-life, 30-day grace, three-place
maximum drop. Review the recall log after a few weeks. One open question:
whether the agent reading a note right after recall injects it reflects a real
choice or a habit. If most reads follow injections, lower the read value for
those reads.
