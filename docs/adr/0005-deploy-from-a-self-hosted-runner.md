---
status: accepted
---

# Deploy merged revisions from a production self-hosted runner

## Context

Manual deployment leaves merged bridge changes unapplied and depends on a developer machine's SSH alias and credentials. The private repository needs a merge-triggered deployment path without exposing the server's SSH key to GitHub-hosted workers.

## Decision

Run checks on a GitHub-hosted runner for every push to `master`, then deploy the green commit with a repository-scoped self-hosted runner installed as the production user on `lyon-server`. The master-only `production` environment, single runner, and shared lock serialize activation without GitHub canceling older pending runs; a revision already superseded in production exits successfully. The deploy builds an immutable release before stopping the old service and updating the clean canonical agent checkout, removes untracked/ignored project settings and every repo-local extension/skill discovery location, points systemd at the release, restarts it, and requires the application-ready signal from one stable service PID. Activation failure restores the previous checkout and unit.

## Consequences

- A merge deploys automatically only after checks pass.
- No production SSH private key is stored in GitHub.
- Failed builds leave the running release untouched, and failed activation restores the previous service unit.
- Merged workflow code executes with the production user's permissions, so repository access and branch ownership remain security boundaries.
- The production runner must remain online; an offline runner leaves deployment queued rather than bypassing checks.
