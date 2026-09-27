# Writable Calendar plan

Status: implemented; see [ADR-0036](adr/0036-guarded-calendar-writes.md) and
[runtime setup](google-workspace.md). Enabling writes requires per-instance
configuration and a Calendar OAuth grant.

## Approved scope

- Create, edit/reschedule, and delete individual events in Personal and Things
  to Do. Default new events to Personal when no calendar is named.
- Execute clear creation and edit requests immediately. Ask for clarification
  when the event, calendar, date, or time is materially ambiguous.
- Require a direct user confirmation button before deletion.
- Exclude invitations, RSVP responses, recurring-series changes, and calendar
  sharing/settings. Leave Gmail and Contacts read-only.

## Recommended approach

Extend the existing typed `google_workspace` tool with event read, create,
update, and request-delete operations. Reuse the existing Google transport and
Telegram section mechanism used for memory deletion. This keeps account
selection and calendar reads/writes in one flow without another service or
dependency. A separate calendar-write tool would isolate registration but
duplicate selection and validation; it is unnecessary for this scope.

Resolve Personal and Things to Do to stable calendar IDs during setup and bind
the write allowlist to the intended account and instance. Display names alone
must not authorize writes. Require Google editor/owner permission as well as
the local allowlist. Other instances receive no write access by default.

Keep the existing read-only invocation path for reads. Only the explicit
calendar mutation adapters may use write-capable invocations; never expose a
generic command or a model-controlled read-only switch. Check existing OAuth
grants and arrange user authorization if Calendar write permission is missing.

Support titles, timed or all-day start/end values, time zones, descriptions,
and locations. Updates patch only requested fields. Read the target event
before an edit or deletion. Reject attendee-bearing events and recurring
events/instances in this first version so excluded invitation and recurrence
behavior cannot happen incidentally. Moving between calendars is deferred.

Deletion uses a preview showing calendar, title, and date/time. Reuse the
memory confirmation pattern: actor/chat binding, short expiry, one-use token,
and no model-callable approval. Recheck the target against the preview before
deleting; a changed event requires a fresh preview. Verify whether the client
supports conditional writes before promising atomic protection against changes
made in Google Calendar between the recheck and mutation.

Creation retries must not duplicate events. Inspect the installed client's
support for caller-supplied event IDs and use a stable operation identity when
available. After an ambiguous write outcome, reconcile by reading the event;
never blindly replay a mutation or report unverified success. Do not add a
general job queue or transaction subsystem for this feature.

## Likely implementation locations

- `.pi/extensions/google-workspace.ts`: typed operations and confirmation UI.
- `.pi/lib/google-operations.ts`: validated requests and normalized results.
- `.pi/lib/google-transport.ts`: narrow write execution and safe errors.
- Existing Google extension/transport tests: mutation and failure coverage.
- `.pi/skills/google-calendar/SKILL.md`, `docs/google-workspace.md`, and an ADR
  amending ADR-0027: actual supported behavior and authorization setup.

## Acceptance criteria

1. A clear request creates a timed or all-day event in Personal by default,
   or Things to Do when named, and returns the verified saved event.
2. An edit changes only requested fields on the identified event and preserves
   unrelated details. Time-zone and daylight-saving cases are tested.
3. Requesting deletion makes no change before the user's button click.
   Cancelled, expired, replayed, wrong-chat, and changed-event confirmations
   cannot delete an event.
4. Writes to other calendars/accounts and excluded event types are rejected
   before mutation. Existing read-only operations retain their restrictions.
5. Repeated creation attempts do not create duplicates. Transport ambiguity
   produces reconciliation or an explicit unresolved result, not false success.
6. Missing Google authorization produces an actionable setup outcome.
7. Regression tests, `npm run check`, and `npm run build` pass. Deployment
   readiness is checked. Any live write test uses an explicitly identified
   disposable event; deletion still follows the approved confirmation flow.

## Verified client constraints

gogcli 0.34.1's Discovery adapter accepts caller-supplied event IDs. Its
first-class create command does not. The implementation uses fixed internal
Discovery methods and normalized public results. Neither adapter exposes
conditional-write headers; version rechecks are best effort, with a remaining
race between the read and mutation. This limitation was reported during
implementation and is recorded in ADR-0036.
