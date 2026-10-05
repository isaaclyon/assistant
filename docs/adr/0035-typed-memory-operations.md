---
status: accepted
relates-to: ADR-0011, ADR-0018, ADR-0020, ADR-0034
supersedes-in-part: ADR-0011
---

# Expose typed memory operations with user-only confirmation

## Context

Canonical Markdown storage already has revision checks, serialized mutations,
scope enforcement, and optional Git commits. Shell-mediated CRUD makes small
edits unnecessarily broad and leaves confirmation dependent on instructions:
an agent can supply a matching `confirmId` itself. Hybrid search also gives us a
ready way to suggest existing memories before creating another note.

## Decision

Add one repo-local `assistant_memory` tool with typed read, prepare/create,
update, request-delete, and request-share operations. Select its extension in
the two personal profiles and household profile, not Builder. The tool calls
the same executor as the CLI, preserving the mutation lock across Git preflight,
revision check, file replacement, and optional commit. Markdown remains the
only canonical store; no new service or dependency is introduced.

Creation first validates a draft and retrieves up to five related notes through
current hybrid search. The agent decides whether an existing note covers the
fact. A session-local token binds the exact draft and its eventual creation
result, so retries and concurrent calls with that token cannot create another
note. This is bounded session-level idempotency, not a durable transaction log.
Incomplete canonical search prevents preparation; unavailable embeddings fall
back to current keyword suggestions. A missing first-ever vault may be safely
initialized, while a missing populated indexed vault fails closed.

Targeted updates use exact expected/replacement text pairs plus a required file
revision. Each expected text must occur exactly once; edits apply sequentially
in memory before a single file replacement. Missing or ambiguous text fails
without writing. The typed tool also accepts bounded headerless diff hunks (`bodyDiff`):
space-prefixed context, minus-prefixed removals, and plus-prefixed additions.
The application converts them to the same exact-text edits before execution;
it rejects malformed or unanchored hunks and mixed edit formats. This keeps
the existing lock, revision, visibility, and all-or-nothing write checks.
Metadata changes remain field patches. The typed update does
not expose full-body replacement or scope changes.

Deletion and personal-to-household sharing use the existing Telegram section
API to show version-bound previews. Random tokens remain inside the section and
application; they are never returned as model-callable approval arguments.
The transport authorizes the actor, and the application binds the callback to
the presenting chat, exact operation, ID, and revision. Tokens expire after ten
minutes, are consumed before mutation, and disappear on session reset/reload.
A failed delivery revokes the pending token. A changed revision requires a new
preview. Cancellation writes nothing. The direct callback reports the result,
and delivery failure never replays a completed mutation.

The shared executor rejects CLI deletion and personal-to-household promotion
with `CONFIRMATION_REQUIRED`, even with a matching `confirmId`. Only the trusted
callback supplies the executor's in-process approval capability. Ordinary CLI
reads/edits, auxiliary operations, lint, and core inspection remain available.

## Consequences

- Users keep Markdown/Obsidian ownership, revisions, provenance, and Git history.
- Small corrections preserve unrelated body content and fail visibly on ambiguity.
- The assistant must inspect related candidates; similarity alone never merges,
  overwrites, or prevents a deliberately distinct note.
- Confirmation drafts and creation results are capped at 32 entries each and
  ten minutes. Restart requires preparing again. There is no new durable state.
- Scope sharing always discloses the whole note; the preview says so explicitly.
- Supported tool/CLI paths enforce consent, but this is not an OS sandbox:
  trusted code and the user retain direct access to the vault and internal store.
- Multi-note relationship transactions and automatic retention remain outside
  this change. Cooperative locks still cannot exclude arbitrary external editor
  writes between the final revision check and file replacement.
