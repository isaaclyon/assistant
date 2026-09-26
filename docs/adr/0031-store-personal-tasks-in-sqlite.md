---
status: accepted
relates-to: ADR-0009, ADR-0020
---

# Store personal tasks in per-instance SQLite

## Context

The personal task manager needs durable CRUD, deterministic status transitions,
date-based views, and searchable closed tasks. It must survive process restart
and immutable-release deployment without adding a service or exposing a raw
database interface to the model. Notifications, recurrence, and check-ins are
separate later features.

## Decision

Store tasks in `<stateDir>/tasks.db` using Node's built-in `node:sqlite` API.
The file is mode `0600`, uses WAL with full synchronous commits, and has a
`PRAGMA user_version` migration sequence. The first schema stores title, open /
completed / cancelled status, assignee label, optional start and due dates,
notes, and lifecycle timestamps, with indexes for actionable views.

Expose only the typed `tasks` Pi operation set through the personal Isaac
capability profile. The service owns validation and deterministic transitions;
the skill normalizes natural-language dates to `YYYY-MM-DD` and chooses bounded
views. Future-start tasks and closed tasks are excluded from normal actionable
views, while search includes closed and future tasks. Permanent deletion uses a
short-lived, one-use, operation-bound confirmation token.

## Consequences

- Task state is isolated with the assistant instance and survives restart and
  deployment.
- No arbitrary SQL, notification, recurrence, or assignee notification surface
  is exposed.
- Date views are reproducible from an explicit `as_of` date; the skill is
  responsible for local-time interpretation before calling the typed tool.
- Reminder, snooze, check-in, and recurring behavior can be added later without
  changing the core status model.
