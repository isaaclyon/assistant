---
status: accepted
relates-to: ADR-0027
---

# Cache and meter Google Places requests before outbound execution

## Context

Google Places uses API-key billing rather than the Workspace OAuth boundary.
Agent retries and concurrent turns must not bypass a local monthly ceiling, and
repeated identity lookups should not incur avoidable requests. The model must
not receive the API key, accounting state, or an override surface.

## Decision

Keep `places_search` and `places_details` inside the closed
`google_workspace` tool. Identity requests use gogcli's reviewed `maps places`
commands, whose fixed field mask contains only place identity, display name,
formatted address, and Google Maps URI. An explicit `rich_details` profile uses
a repo-owned fixed HTTPS request because the pinned gogcli does not support a
custom Places field mask. It allows only rating/count, regular hours, national
phone, website, price level, and at most three reviews with the attribution,
source links, translation metadata, and France visit date needed for compliant
display. No raw command, URL, field mask, status, reset, or override input is
exposed.

Store cache entries and monthly outbound-attempt counts in
`<stateDir>/google-places.db`. A `BEGIN IMMEDIATE` transaction rechecks an
eligible cache entry and, on a miss, reserves one attempt for the operation's
estimated SKU before the child process starts. The reservation remains counted
when the outbound command fails. Usage keys use UTC billing month and roll over
without rewriting prior rows. A zero limit blocks every cache miss.

Text-search matches use a 24-hour TTL because the best match for a query can
change. Details identity/address results use a 30-day TTL. Rich details use a
separate SKU accounting key, with its own copy of the configured details limit,
and are never written to the SQLite cache; every allowed request is fetched
live. Identity plus rich details can therefore consume up to twice the numeric
details setting. This avoids persisting Google review and place content that is
subject to Google Maps Platform caching restrictions.

Read the API key just in time from a separate mode-`0600` file configured by
`PI_TELEGRAM_GOOGLE_PLACES_API_KEY_FILE`, then pass it only in the gog child
environment. Configure independent conservative monthly limits for text search
and details. Missing or invalid configuration fails closed.

## Consequences

- Eligible identical requests avoid outbound cost and do not increment usage.
- Rich details are opt-in, independently counted, and never served from cache.
- Concurrent cache misses cannot exceed a configured SKU limit through this
  gateway, including across processes sharing the instance database.
- Local accounting is deliberately conservative and may exceed provider-side
  successful billable requests because failed attempts remain reserved.
- Operators can inspect the private database out of band, but the agent has no
  usage, reset, override, or configuration operation.
