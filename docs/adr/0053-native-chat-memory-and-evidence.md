---
status: accepted
relates-to: ADR-0015, ADR-0017, ADR-0018, ADR-0026, ADR-0035, ADR-0037, ADR-0038, ADR-0045, ADR-0047, ADR-0048, ADR-0052
---

# Bind native chat and memory to durable source authority

## Context

C2 supplies the native host, source bindings, ordinary operation protocol and
transport. C3 needs useful chat and canonical memory behavior within the approved
narrow profile. The deployed legacy runtime continues separately until C7.

## Decision

The `durable-chat-memory-test` profile selects seven native bundles: core-memory,
search, memory, reload, restart, skills and debug. It exposes five typed
memory/history tools and the personal-memory skill. The native configuration
explicitly selects a private vault, legacy archive roots, time zone, recall and
semantic flags, and provider key-file references. Enabled services require those
references. The host includes memory configuration in its compatibility identity.
All selected resource paths are validated before importing domain modules.
Provider function schemas use a flat object root; the memory service separately
validates its exact action union before any domain read, draft or effect. This
preserves the standard arguments while satisfying provider wire constraints.

### Canonical effects and approval

Reuse the Markdown store and its mutation lock. A trusted preparer fixes note ID,
timestamp, payload and exact pre/post revisions before persisting an operation.
The executor verifies the same plan under the lock and writes a private,
fsynced receipt under `<vault>/.operations/` before changing Markdown. A replay
recognizes exact resulting bytes; it never repeats an append or creates a
replacement note. A missing receipt or a changed note remains uncertain.
Receipt files contain identifiers and revisions, without note bodies, and remain
as deduplication evidence.

Optional local Git completion has its own operation trailer and result. Recovery
can recognize or finish that exact note-path commit without repeating Markdown.
A lost Git acknowledgement cannot justify repeating the note change. Unrelated
staged work prevents a new effect; uncertain Git requires inspection.

Create uses a durable duplicate-review draft. Identical update retries join the
persisted operation. Delete and household sharing require an authenticated
user-only callback bound to principal, chat, message and epoch. Telegram callback
data contains a short opaque operation handle; the approval secret stays in
native state. Consuming approval and creating the operation task are atomic.
New/reset/reload expire pending approvals and drafts; ordinary restart preserves
unexpired pending requests. The mixed read/write memory tool remains replay
unsafe; its separately owned operation task and receipt provide effect recovery.

### Request context and evidence

A native generation hook injects core memory, original-event date hints, recall
and proposals into requests. A conversation document retains deterministic
per-source hidden context across tool rounds and restart. Deduplication follows
the retained public context, so compaction and a new conversation allow recall
again. Hidden context never becomes a transcript entry. Existing scoped search,
semantic refresh/revalidation, usage decay and Jev decisions remain shared domain
code. A proposal cannot authorize a memory write.

Native history projects an explicit evidence allowlist from public storage.
System prompts, hidden context, thinking, controls, compaction summaries and
protected browser output are excluded. Native citations encode version, instance,
store identity and conversation in `sessionId`; `entryId` and source timestamp
remain exact. The store identity persists with the Harness. Archived JSONL keeps
its original anchors. Search, bounded context and canonical provenance lint use
the same principal-scoped resolver. The native inspection CLI supplies that
resolver while holding the normal exclusive writer lease without starting the
scheduler or Telegram poller.

### Telegram lifecycle

Best-effort previews consume visible assistant text only. Durable final delivery
continues using C2's ledger and ambiguity policy. Menu commands run outside the
model loop. Model/thinking choices and administrative command receipts persist;
the restored choice also configures future conversation epochs. Idle reload
replaces a compatible selected registry and closes its old resources. Restart
requests shutdown only after the upstream offset acknowledgement; a pending
restart notice is settled once after reopening. Missing send acknowledgements
remain uncertain. Opt-in debug messages are bounded, redacted and private-target
bound, and reset on process restart.

## Consequences

- Canonical Markdown/Git and archived JSONL remain supported stores. No historical
  uncertain operation is promoted into executable native work.
- A dedicated user checkpoint is required before C3 acceptance. Local tests alone
  do not establish real Jev/embedding authorization or Telegram usability.
- The native profile has no general shell/file/web, browser, Google, places,
  scheduling, child-agent or codemode capability. Their later checkpoints remain
  unchanged.
- Receipt retention and compatibility checks deliberately favor inspectable
  uncertainty over automatic repetition. Full Linux, fleet and activation
  acceptance remains C6/C7.

See the [C3 guide](../pi-durable-c3-chat-memory.md) for validation and operation.
