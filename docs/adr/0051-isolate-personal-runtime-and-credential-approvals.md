---
status: accepted
relates-to: ADR-0020, ADR-0024, ADR-0045
---

# Isolate the personal runtime and credential approvals

Capability profiles and scoped environment names do not constrain arbitrary
shell execution under an administrative Unix identity. A credential approval
also provides no independent authority when the requesting runtime can read
the approving bot's token or forge its callbacks.

## Decision

Support an explicitly provisioned personal system service under a dedicated,
unprivileged identity. Its private home contains selected personal state and
credentials; executable releases, service configuration and network policy
remain administrator-owned. Startup verifies the actual process identities,
empty capabilities, no-new-privileges setting, selected path protections and
network namespace. A namespace denies access to host administrative listeners,
private networks and tailnet peers except administrator-selected services.
Private browser HTTPS proxies run outside that namespace under fixed policy.

A separate non-root broker owns the personal Telegram bot token, sole upstream
poller, durable update queue and approval ledger. The runtime reaches a closed
Unix-socket API using a surrogate token. The broker forwards paired ordinary
traffic, retains positive message/file ownership, reserves approval callbacks
and prevents runtime edits to approval messages. Mini App authentication uses
the broker without exposing the real token.

The broker alone holds a 1Password service account with source-read and
destination-read/write permissions. Approvals bind the requesting instance,
paired Telegram identity, message, item version, website and purpose. Once
releases one protected login operation. Always creates and verifies an
independent, minimal destination Login. Denial or expiry releases nothing.
Atomic claims and durable copy identities prevent callback/restart replay;
ambiguous delivery or creation requires reconciliation rather than retry.
Passwords travel through the protected browser host path and never become tool
results. These protections do not prevent a destination website or an already
authorized runtime from misusing credentials it legitimately receives.

The administrator owns a mixed-manager deployment policy. The coordinator
stops user and system writers, checkpoints application/state/configuration
across their identities, refreshes selected migration assets only while
quiescent, and persists the no-rewind barrier before candidate startup. Failure
holds every writer. Accepted runtime work, upstream offsets and consumed
approvals must survive recovery; restoring an older checkpoint after candidate
startup is refused. The personal manifest is self-only, preventing scheduler
delivery into a privileged builder.

## Rollout and limits

This is an opt-in deployment boundary. The ordinary user-manager fleet remains
available until an administrator completes migration and registers its routing
file. Provisioning and private task state remain outside the repository.
Synthetic Linux activation/recovery and process checks complement unit tests;
real Telegram choices, real synthetic vault items, private-browser delivery and
preserved configured capabilities are separate production acceptance gates.
See the [approved migration plan](../personal-runtime-isolation-plan.md) and
[fleet operations](../household-fleet.md#isolated-personal-deployment).
