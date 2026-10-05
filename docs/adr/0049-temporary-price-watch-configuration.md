---
status: accepted
relates-to: ADR-0019, ADR-0032
---

# Keep situational watches in temporary private task data

Recurring work does not make a user's current shopping list durable
infrastructure. Reusable skills and adapters must not enumerate individual
products, URLs, recipients, baselines, or personal purposes.

## Decision

The watch-prices skill owns price-watch setup, verification, and retirement.
The scheduling skill owns scheduling and publication acknowledgement.
Reusable Shopify, Product JSON-LD, and Steam package adapters accept a bounded
source configuration. Product-specific checker code and constants are removed.
Network access resolves and pins public IPv4 addresses, rejects redirects and
private/reserved addresses, and bounds response size and time. IPv6-only sources
are unsupported. No credentials, browser state, or arbitrary executable paths
are accepted.

Individual watches live at the coordinator's private
`temporary/price-watches/<id>/watch.json`, with baseline evidence, creation time,
and an explicit end condition. A helper validates and publishes the watch's
generic heartbeat projection through the existing jobs helper. Manifests and
the scheduler publication are not a cross-file transaction: a prepared/pending
manifest is not proof of scheduling; the exact jobs publication must be accepted.
Use the helper to republish after failure, rather than rolling back other jobs.

Retirement removes the job, verifies host acceptance, then moves its manifest
to `temporary/price-watches/retired/`. No arbitrary expiration is inferred from
the directory name. Purchase/cancellation/end conditions require agent action;
date-based retirement needs an explicit scheduled reminder. Retired manifests
remain private audit data until requested cleanup.

The existing scheduler ledger and observation lifecycle remain unchanged.
Changing checker arguments resets the observation episode; migrations preserve
price baselines and schedules but require fresh confirmation observations.
Before deploying removal of a product-specific checker file, migrate its job to
the reusable checker ID and validated configuration. Perform this away from its
scheduled observation time and verify the new release before its next run.

This is the general rule for situational work: store task instances in temporary
private data with a lifecycle, and keep only reusable mechanisms in the release.
