---
status: accepted
relates-to: ADR-0009, ADR-0011, ADR-0012
supersedes-in-part: ADR-0011
superseded-in-part-by: ADR-0015
---

# Compile schema-checked core memory from Markdown

## Context

The private Markdown vault remains the canonical personal-memory store, but
ADR-0011's dependency-free, single-line frontmatter parser cannot accept normal
Obsidian YAML or reliably identify selected Markdown blocks. A small subset of
facts and preferences also needs a deterministic, inspectable representation
before it can safely become bounded always-present context.

## Decision

Require `schema: 1` on managed notes and parse their frontmatter and bodies with
the pinned `yaml` and `marked` packages. Markdown remains authoritative. An
exact plain-text `#core` marker selects supported leaf blocks for a disposable
projection ordered by memory type, note title, source position, and ID. The
projection uses title-prefixed bullets, renders link labels without targets,
and has a hard 4,000-Unicode-code-point budget with no truncation.
Vault inspection is capped at 1,000 managed notes and 16 MiB; exceeding either
limit invalidates core rather than producing a partial projection.

Expose separate read-only `lint` and `core` CLI operations. Global lint reports
all bounded findings, while only errors that can affect the projection make
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
- Unversioned notes are invalid. No migration is provided because the real
  vault is empty or test-only at adoption time.
- `#core` remains ordinary user-owned note data. Runtime injection is not part
  of this phase and requires the explicit bridge boundary described above.
- Lifecycle statuses, generated projections, indexing, Git automation, and
  session provenance validation remain deferred until they unlock behavior.
