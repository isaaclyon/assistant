# ADR-0050: Incremental inbox heartbeats and silent review

Status: Accepted

## Context

Snapshot item comparison cannot reliably represent a paginated inbox: old messages
can disappear and reappear, and a changed thread can contain a new message. Email
triage also needs enough bounded content for judgment and a quiet second-stage veto.

## Decision

Add opt-in `checker.mode: "incremental"` for semantic-match jobs. The host sends
`{version: 1, cursor: null | object}` on stdin. These checkers emit version-2
observations with an opaque JSON `cursor` (32 KB maximum) and a bounded batch of
new items (64 KB total stdout). Their first observation must contain no items.
The checker owns cursor interpretation; the host owns persistence. Subsequent
items are all judged, without snapshot ID comparison. A failed read, invalid
observation, or failed judgment leaves the saved cursor unchanged. Matches and
the next cursor are saved atomically before prompt injection. Pending injection
is retried before any further read. Events must fit the existing 32 KB handoff
limit; oversized events fail before committing. Existing snapshot jobs retain
their version-1 protocol and 4 KB bound.

The reusable `gmail-inbox` checker uses the existing readonly Google transport
through a closed polling adapter. Account and timezone are job arguments. Each
poll reads up to three individual messages in a fixed delivery-time window,
retains pagination and message identities in its cursor, and advances the lower
bound only after finishing that window. It uses sanitized message bodies, real
internal delivery timestamps, bounded excerpts, and explicit truncation markers.
A two-minute indexing delay precedes the upper bound. Private user rules and
watch lifecycle data remain outside the repository.

A source- and version-checked install patch to the pinned Telegram dependency
suppresses an exact whitespace-trimmed `NO_REPLY` final response on proactive
turns. Queue cleanup and settlement still run. Human-requested literal replies
and ordinary alerts retain normal delivery. Watch prompts explicitly request
this response when the assistant vetoes a Jev match.

## Consequences

There is no full agent turn for an empty batch or a negative Jev judgment. Private
email processing by TypeSafe requires the user's agreement. First-run mail is
silently excluded; new requests can use configuration without deployment.

This is inbox polling, not a complete Gmail change feed. Mail archived before a
read, delayed search indexing beyond the grace period, and concurrent mailbox
changes during pagination can affect coverage. Backlogs take multiple scheduled
polls; cursor overflow (1,000 IDs), invalid pagination, oversized source responses,
and operational failures stop advancement rather than silently dropping a page.
Truncated text can miss evidence; assistant review can recover context for
positives but cannot recover Jev false negatives. Prompt handoff retries preserve
the existing delivery contract; this does not claim exactly-once Telegram delivery.
