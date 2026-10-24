---
status: accepted
relates-to: ADR-0030, ADR-0051, ADR-0052, ADR-0054
---

# Delegate schedule definition management without coordinator ownership

## Context

A recipient engineering bot can design technical jobs but must not gain direct
access to an isolated personal coordinator's state or credentials. Granting a
coordinator role, sharing its private directory, or discovering its paths from a
global manifest would conflate management authority with runtime ownership.

## Decision

Add an opt-in Unix-socket definition-management interface inside the existing
native coordinator lifetime lease. Private operator configuration grants each
client a distinct random bearer key, a non-overlapping job-ID prefix and an
explicit subset of the coordinator's existing recipient targets. Separate
mode-0600 copies of the key belong to the server and client identities. Socket
traversal is separately provisioned through a dedicated group; there is no TCP
listener, shared state directory or automatic privilege/service change.

A non-coordinator with general tools can select `scheduleClient`. Its existing
release-owned jobs helper forwards definition requests using only the host's
explicit client configuration. The shell receives paths/UID, never key bytes.
The client checks the socket and directory owner against the pinned server UID.
The server maps the key to its own grant; client-selected scopes, paths and
credentials are not request fields. Recovery operations remain self-local.

The first interface manages cron and one-time prompt definitions only. It
supports filtered/paginated list, single-job inspection, create/update and
removal. Heartbeat selection, webhook secrets, watch manifests and recipient
recovery are not delegated. A grant permits submitting prompts to its named
recipients; their existing action-approval rules still apply. It is not a
sandbox for prompt contents or a guarantee of harmless recipient behavior.

Mutations verify prefix, old and new targets/types and an expected job revision
inside the same canonical definition mutation lock. Creation expects null;
updates/removal expect the exact revision returned by inspection. Delegated
writes never prune unrelated definitions. Responses omit private paths,
unrelated prompts/state and raw exceptions. Publication acknowledgement remains
bound to the exact saved bytes; accepted publication does not prove execution.

The client never retries. On a lost response, inspect first; missing receipts do
not prove no effect. Current job revision and publication state support
reconciliation, but there is no exactly-once request ledger. Removal of a job is
not proof of cancellation of already admitted work. Keys/grants are fixed for a
coordinator lifetime; revocation requires its controlled restart.

## Deployment and compatibility

Configuration is off by default. Grant provisioning, group access, key copies,
pinned configurations and service activation require administrator action.
Adding/removing client or coordinator control authority participates in native
runtime compatibility signatures. `scheduleUpgradeFrom` supplies the exact private
predecessor config path and digest, checked against the administrator's installed
map and pin. Only schedule client/control settings may differ; all other authority
and tool contracts remain fixed. Schema-1/2 signatures are reconstructed rather
than supplied by the operator. With all native work and delivery settled, startup
updates metadata/instructions atomically while retaining conversations and receipts.
Pending, uncertain or incompatible work remains held. This does not provide a
generic signature bypass or turn an instruction-only upgrade into an authority
migration. The isolated unit gains write access only to its instance-specific
socket directory under `/run/pi-telegram-schedules`, not a shared state directory.
The existing personal coordinator remains self-targeted: this interface does
not introduce cross-UID recipient handoffs or a path back into a privileged bot.

See [the operations guide](../delegated-schedules.md) for the schema and limits.
