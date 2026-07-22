---
status: accepted
relates-to: ADR-0009, ADR-0011, ADR-0012
supersedes-in-part: ADR-0011
superseded-in-part-by: ADR-0015, ADR-0016, ADR-0017
---

# Compile schema-checked core memory from Markdown

## Context

The private Markdown vault remains the canonical personal-memory store, but
ADR-0011's dependency-free, single-line frontmatter parser cannot accept normal
Obsidian YAML or reliably identify selected Markdown blocks. A small subset of
facts and preferences also needs a deterministic, inspectable representation
before it can safely become bounded always-present context.

## Decision

Require a supported managed-note schema (scope-aware writes use `schema: 2`)
and parse frontmatter and bodies with
the pinned `yaml` and `marked` packages. Markdown remains authoritative. An
exact plain-text `#core` marker selects supported leaf blocks for a disposable
projection ordered by memory type, note title, source position, and ID. The
projection uses title-prefixed bullets, renders link labels without targets,
and has a hard 4,000-Unicode-code-point budget with no truncation.
Vault inspection is capped at 1,000 managed notes and 16 MiB; exceeding either
limit invalidates core rather than producing a partial projection.

Expose separate read-only `lint` and `core` CLI operations. Lint and core apply
the host-bound principal/memory view before returning note-derived results.
Lint reports bounded findings for the effective view, while only errors that can affect the projection make
`core` unavailable. Do not cache or write a generated core file; read the vault
for each compilation. A later Telegram-only `before_agent_start` extension may
directly import the same renderer behind an explicit host-bound runtime marker.

## Considered Options

- **Keep custom parsers:** rejected because full YAML and Markdown block
  semantics are not a safe small regex grammar.
- **Generate `CORE_MEMORY.md`:** rejected for now because it introduces refresh
  and stale-state behavior without improving the small-vault read path.
- **Require the whole vault to lint clean before compiling core:** rejected
  because an unrelated broken link should not remove valid core context.

## Consequences

- Obsidian may rewrite managed YAML into any valid representation; CLI updates
  preserve its meaning and comments but may normalize frontmatter formatting.
- Unversioned notes are invalid. Schema-1 notes remain conservatively
  Isaac-personal and produce a bounded `LEGACY_SCOPE_UNMATERIALIZED` lint
  warning in Isaac's view. Reading the note and performing a revision-checked
  scope update materializes schema 2; it never becomes household-visible by
  inference.
- `#core` remains ordinary user-owned note data. Runtime injection is not part
  of this phase and requires the explicit bridge boundary described above.
- Generated projections, indexing, and Git automation remain deferred until
  they unlock behavior. Lifecycle behavior is defined by ADR-0016 and session
  provenance validation by ADR-0017.
