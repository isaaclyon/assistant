---
status: accepted
relates-to: ADR-0011, ADR-0014
supersedes-in-part: ADR-0014
---

# Validate personal-memory session provenance during lint

## Context

Memory notes may preserve a claim-level link to the Pi conversation that
supplied the evidence. A human-readable timestamp alone is not a stable machine
anchor, while validating every session during each core-memory compilation
would add unrelated work to every Telegram turn.

## Decision

Reserve Markdown footnote labels `source` and `source-<alphanumeric>` for Pi
session provenance. Their definitions use one exact, inspectable form:

```markdown
[^source]: Pi session `<session-id>`, entry `<entry-id>`, `<timestamp>`.
```

The timestamp is canonical ISO-8601 UTC and must exactly match the referenced
entry. Vault lint resolves the bridge session directory from
`PI_TELEGRAM_BRIDGE_STATE_DIR` (defaulting to the bridge's normal state
directory), then verifies the session header, entry ID, and timestamp. Missing,
malformed, or stale anchors produce sanitized note-path findings. Ordinary
footnotes are outside this contract.

Session validation reads only files named for referenced session IDs and has a
shared 64 MiB/100,000-entry scan budget per lint run. Exceeding either limit
fails provenance validation with a sanitized finding. A duplicate referenced
entry ID makes that session invalid rather than choosing one timestamp.

Provenance findings do not invalidate core memory, and core compilation does
not scan sessions. Markdown remains canonical; lint never rewrites a source
footnote or the append-only Pi session JSONL.

## Considered Options

- **Validate syntax only:** rejected because a well-formed but stale locator is
  not useful provenance.
- **Validate every footnote:** rejected because ordinary citations and notes do
  not necessarily refer to Pi sessions.
- **Validate during core compilation:** rejected because provenance metadata is
  stripped from core output and should not add per-turn session I/O.

## Consequences

- Source-backed claims can retain a stable session ID plus entry ID while the
  timestamp remains useful for manual inspection.
- Moving or deleting bridge session history makes lint fail until the source
  anchor is corrected or removed, but does not suppress otherwise valid core
  memory.
- This validation does not index or search session text; those remain separate
  future retrieval capabilities.
