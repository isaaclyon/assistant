---
status: accepted
relates-to: ADR-0027, ADR-0035
---

# Guard individual Calendar changes behind typed operations

## Context

The user approved creating, editing/rescheduling, and deleting individual
events in Personal and Things to Do. Creation and edits should act on clear
requests; deletion requires a direct user confirmation. Invitations, RSVP,
recurrence, calendar settings, and other accounts/calendars are excluded.

## Decision

Extend `google_workspace` with four closed operations. An external JSON
allowlist binds the host instance, exact account address, and two stable
calendar IDs. Every operation checks Google editor/owner access. Ordinary
Workspace reads keep their existing read-only adapters; only the internal
Calendar event adapter chooses write-capable invocations. It owns the API,
version, methods, scope, query parameters, and allowed body fields. No model
input selects a raw method or safety flag. Gmail and Contacts remain read-only.

Use gogcli 0.34.1's Discovery adapter for fixed Calendar v3 methods. Its
first-class create command lacks caller-supplied IDs. Hash a stable operation
key with the account/calendar into a Google event ID and store a draft
fingerprint as a private extended property. Repeated creates reuse that ID,
including across process restarts, and reject conflicting content. After an
ambiguous write, read once to reconcile rather than blindly retrying. Empty
successful output is accepted only for the owned DELETE adapter's HTTP 204.

Update only explicitly requested fields. Reject events with attendees,
incomplete attendee lists, invitations, recurrence or recurrence-instance
markers, and special event types. Validate dates, exclusive all-day ends,
explicit timed offsets, IANA time zones, and daylight-saving transitions.

The extension presents deletion through the existing Telegram section registry
and host actor policy. Bind a ten-minute, one-use token to the rendered chat
and previewed event version. No approval operation or token is returned to the
model. Cancel, failed presentation, session shutdown, expiry, and successful
consumption invalidate the token. Recheck the event before deletion. A failed
Telegram result delivery never replays the mutation.

## Consequences

- Writes require explicit per-instance configuration and interactive Calendar
  OAuth authorization; capability installation alone does not enable them.
- The existing gog credential storage and bounded child-process transport are
  reused. Normalized bounded results mark remote data as untrusted.
- One Calendar change runs at a time within an instance. Pending confirmations
  are bounded, session-local state; restarts require a fresh preview.
- Neither reviewed gog adapter exposes `If-Match`. Version checks catch changes
  before the final read but cannot prevent a concurrent external change between
  that read and the write. This is a known best-effort check, not atomic
  concurrency protection. Conditional API headers would close this gap.
- Failed reconciliation remains explicitly unresolved. A generic failed read
  is never evidence of successful deletion. No real user events are needed for
  automated validation.

## Native C4 addendum

The isolated `durable-mutations-test` profile selects the combined native Google
bundle. Earlier read-only profiles retain their original schema and selection.
The native host persists write claims and deletion previews in the Harness;
`CalendarWrites` continues to own field validation, allowlisted targets, Google
permission checks, stable creation IDs and best-effort event version checks.
The reusable `prepareDelete`/`executePreparedDelete` seam carries the original
account, stable calendar ID, event ID and etag without relying on a process-local
token. Legacy Telegram confirmations keep their existing session-local behavior.

A native preview is bound to the authenticated principal, actor, private chat,
acknowledged message, conversation epoch and ten-minute expiry. The model sees
no approval handle. Confirm and Cancel are mutually exclusive. A valid pending
preview survives ordinary restart; reset and reload invalidate its authority.
An uncertain preview send has no acknowledged message binding and cannot delete.

Native execution keys its claim by the stable Harness task identity before
transport. Provider-supplied tool-call IDs may repeat across invocations and do
not identify journal entries. Recovery of an unrecorded result only reads the
remote state; it cannot issue the mutation again. Shutdown aborts active Google
transports while polling drains, before closing the Harness; cancelled claims
remain available for read-only recovery. A stable
creation ID and draft fingerprint can prove the intended event exists. An update
can prove the requested fields are present, without proving which writer set
them. A returned deletion tombstone proves deletion; a failed read does not.
Unproven outcomes remain explicitly uncertain and require inspection. Native
call receipts remain retained, including unknown claims: pruning one while its
Harness task can replay would turn an old call into a fresh mutation. Completed
receipts discard the original input. C6 must measure this storage and prove a
safe task/receipt retirement policy before cutover. These rules do not strengthen
the underlying client's non-atomic revision check.

See the [C4 guide](../pi-durable-c4-tools.md#guarded-mutation-integration-slice)
for the selected profile and synthetic acceptance boundaries. Production
activation and private-state migration remain later checkpoints.
