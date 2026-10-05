---
status: accepted
relates-to: ADR-0035
supersedes-in-part: ADR-0035
---

# Standardize the memory tool on familiar CRUD operations

## Decision

Keep the registered `assistant_memory` and `assistant_memory_search` names.
Memory management exposes create, read, update, list, delete, and share.
Creation accepts either a draft for duplicate review or its draftToken to
commit. Token expiry, session ownership, and retry behavior remain unchanged.

Updates require a revision and accept exact oldText/newText edits, Markdown
append, and metadata set. Remove the recently added custom bodyDiff language
and old model-facing patch format. Internal exact-text edits remain the shared
storage primitive. Append executes inside the same mutation lock and revision
check, after edits and before a single atomic write. It inserts one newline
only if the existing body is nonempty and lacks a trailing newline.

List returns bounded, ID-sorted metadata pages after scope/status filtering.
Cursors bind a digest of visible metadata and filters; a changed view requires
restarting. It scans the vault per page and introduces no persistent state.

All tool responses carry an operation status: saved, read, listed,
review_required, confirmation_required, conflict, or error. The existing ok
flag remains, but only saved indicates a successful create/update. Actual note
metadata stays in result, including its separate lifecycle status.
Delete/share retain user-only, version-bound Telegram callbacks.

## Migration and consequences

Deploy the schema and skill together. Retire prepare_create, request_delete,
request_share, ifRevision, bodyEdits, and bodyDiff from the model-facing schema.
Old calls fail rather than silently changing meaning. No Markdown migration is
needed. Existing sessions get the current tool schema; draft tokens still
expire across restart. CLI/store contracts remain available for maintenance.

Guidance owns note placement and organization. The tool owns validation,
revision checks, visibility filtering, and confirmation flow. These are
application guarantees, not a filesystem sandbox. Routine CRUD and historical
note edits use the tool; lint/core inspection remain maintenance operations.
