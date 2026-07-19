---
status: accepted
relates-to: ADR-0011
---

# Store entity happenings inside Markdown notes

## Context

Personal memories need to retain meaningful dated occurrences—such as vehicle
maintenance or a household move—without creating a separate note for every
occurrence or confusing history with an operational change log. The canonical
store is an Obsidian-compatible Markdown vault, so the representation must stay
readable and editable outside the CLI while remaining strict enough for global
queries.

## Decision

Allow any managed memory note to contain at most one `## Happenings` section.
Each entry is a top-level Markdown bullet in this form:

```markdown
- YYYY-MM-DD — Happening text.
```

Dates are date-only, entries are chronological, and the owning note supplies
the entity. The `happening-add` CLI operation inserts entries with revision
checking; the `happenings` operation scans Markdown and supports global text
and inclusive date-range queries. Existing notes are not migrated, and stable
facts remain separate from historical happenings. Markdown remains the source
of truth; query results are derived at read time.

## Consequences

- Obsidian users can read and edit happenings as ordinary Markdown.
- A global query can return dated happenings with their owning entity without
  requiring one file per occurrence.
- Strict formatting makes malformed or manually out-of-order sections visible
  instead of silently misinterpreting them.
- Date-only entries support calendar queries but intentionally do not represent
  time of day or timezone.
- A future schema revision can add date precision or richer fields only after
  a concrete need is established.
