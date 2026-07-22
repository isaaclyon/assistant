---
status: accepted
relates-to: ADR-0005, ADR-0009
superseded-in-part-by: ADR-0014, ADR-0018
---

# Store personal memory in a private Markdown vault

## Context

The bridge needs durable personal memory without turning its always-on host into
another data service or putting user facts in the repository. The host already
keeps its canonical working directory and deploys immutable releases, while its
runtime resource filter makes a tracked repo-local skill the deliberate place
for assistant behavior. The memory store must therefore remain outside the
checkout and release, while still being an ordinary directory that a user can
open with Obsidian.

## Decision

Use a private, user-owned Markdown vault as the canonical memory store. Its
default location is `~/.local/share/pi-telegram-bridge/memory`; each invocation
may override it with `PI_TELEGRAM_MEMORY_DIR`, resolved relative to the user's
home when needed. The `personal-memory` repo-local skill owns conversational
policy, and dependency-free `.mjs` scripts under that skill own bounded,
revision-aware CRUD and search through a stdin JSON-line CLI. No compiled CLI,
host configuration, runtime service, event emitter, or Pi extension is part of
this boundary.

Markdown remains authoritative. A future search index may be added behind the
search seam, but it must be derived and disposable rather than another source of
truth. Forgetting a memory hard-deletes the confirmed canonical note; it does
not claim to erase Pi or Telegram conversation history, filesystem snapshots,
or third-party backups.

Each managed note declares either `scope: personal` with a trusted `owner`, or
`scope: household` with no owner. The host binds principal and memory view from
the validated instance identity; chat input cannot choose an owner. Isaac and
Emma personal views include their own personal notes plus household notes, the
household view includes only household notes, and engineering has no memory
view. Promotion to household is explicit and revision-checked. Legacy notes
without scope fail safely to Isaac-personal rather than becoming shared.

## Considered Options

- **One aggregate Markdown file per domain:** rejected because small corrections
  would rewrite larger sensitive documents, and duplicate or concurrent-edit
  handling would be harder.
- **SQLite as canonical storage:** rejected because it would give up plain
  Markdown/Obsidian ownership and conflict with ADR-0003's inbox-only database
  scope.
- **A host service or Pi extension:** rejected for V1 because a tracked skill
  plus command-backed CLI is sufficient and avoids adding runtime lifecycle and
  executable surface. A derived SQLite FTS5 index can be revisited only when
  measured search latency justifies it.

## Consequences

- The vault survives repository cleanup, immutable-release deployment, and
  checkout resets because it is external to the project.
- Users can inspect and edit ordinary Markdown with Obsidian, while the skill
  and scripts enforce the memory consent, privacy, bounded-output, and safe
  mutation contract.
- Memory isolation is semantic enforcement under the shared service account;
  it does not claim hostile-user filesystem isolation.
- V1 search is a bounded Markdown scan; future indexes must be rebuildable from
  the vault and disposable without changing the canonical CRUD contract.
- Hard deletion has a deliberately limited scope, and users remain responsible
  for the privacy and retention of their filesystem and backup copies.
