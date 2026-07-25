---
status: accepted
---

# Deploy merged revisions from a production self-hosted runner

## Context

Manual deployment leaves merged bridge changes unapplied and depends on a developer machine's SSH alias and credentials. The private repository needs a merge-triggered deployment path without exposing the server's SSH key to GitHub-hosted workers.

## Decision

Run checks on a GitHub-hosted runner for every push to `main`, then deploy the green commit with a repository-scoped self-hosted runner installed as the production user on `lyon-server`. The main-only `production` environment, single runner, and shared lock serialize activation without GitHub canceling older pending runs; a revision already superseded in production exits successfully. The deploy builds one immutable release before activation. When the private fleet manifest exists, it preflights all instances and jobs, installs all per-instance units, stops the compatibility singleton, and activates instances sequentially. Readiness binds the exact instance ID, full release SHA, and stable service PID. Any failure restores every changed unit. Mutable instance state, workspaces, and separate builder worktrees are never reset or cleaned. Without a manifest, the compatibility singleton path retains its prior behavior.

After the complete fleet is ready and the canonical checkout has advanced, send
one fixed deployment-complete notification through the manifest's jobs
coordinator Telegram profile. A notification failure fails the workflow after
activation without rolling back healthy services; this keeps missing operator
feedback visible while avoiding an availability regression solely because the
Bot API was unavailable.

## Consequences

- A merge deploys automatically only after checks pass.
- No production SSH private key is stored in GitHub.
- Failed builds leave the running release untouched, and failed fleet activation restores every previous service unit.
- One reviewed release centrally controls every bot's capabilities; deployment cannot create mixed application versions inside the fleet.
- Merged workflow code executes with the production user's permissions, so repository access and branch ownership remain security boundaries.
- The production runner must remain online; an offline runner leaves deployment queued rather than bypassing checks.
- Successful fleet deployments produce one coordinator notification; they do
  not notify every bot or conversation independently.
