---
status: accepted
---

# Deploy merged revisions from a production self-hosted runner

## Context

Manual deployment leaves merged bridge changes unapplied and depends on a developer machine's SSH alias and credentials. The private repository needs a merge-triggered deployment path without exposing the server's SSH key to GitHub-hosted workers.

## Decision

Run checks on a GitHub-hosted runner for every push to `main`, then deploy the green commit with a repository-scoped self-hosted runner installed as the production user on `lyon-server`. The main-only `production` environment, single runner, and shared lock serialize activation without GitHub canceling older pending runs; a revision already superseded in production exits successfully. The deploy builds one immutable release before activation. When the private fleet manifest exists, it preflights all instances and jobs, quiesces every bridge unit, captures a paired state/application-binary snapshot, runs offline recovery migration, installs all per-instance units, and activates instances sequentially. Readiness binds the exact instance ID, full release SHA, and stable service PID. ADR-0030 replaces automatic unit-only rollback with a disabled-fleet hold and explicit recovery; candidate startup permanently forbids rewinding its pre-start snapshot. Workspaces and separate builder worktrees are never reset or cleaned. Without a manifest, the singleton uses the same recovery barrier.

After the complete fleet is ready and the canonical checkout has advanced, send
one fixed deployment-complete notification through the manifest's engineering
instance Telegram profile. A notification failure fails the workflow after
activation without rolling back healthy services; this keeps missing operator
feedback visible while avoiding an availability regression solely because the
Bot API was unavailable.

## Consequences

- A merge deploys automatically only after checks pass.
- No production SSH private key is stored in GitHub.
- Failed builds leave the running release untouched. Failed activation preserves its private checkpoint and disables the fleet for explicit recovery; it never rolls back binaries alone.
- One reviewed release centrally controls every bot's capabilities; deployment cannot create mixed application versions inside the fleet.
- Merged workflow code executes with the production user's permissions, so repository access and branch ownership remain security boundaries.
- The production runner must remain online; an offline runner leaves deployment queued rather than bypassing checks.
- Successful fleet deployments produce one engineering-instance notification; they do
  not notify every bot or conversation independently.
