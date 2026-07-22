---
status: accepted
relates-to: ADR-0005, ADR-0009, ADR-0011
supersedes-in-part: ADR-0011
---

# Commit agent-mediated memory mutations locally

## Context

The private Markdown vault is canonical and may also be edited directly in
Obsidian. Once that vault is a Git worktree, explicit agent-mediated mutations
benefit from an inspectable local history, but personal facts must not enter
commit messages or an unrelated parent repository. A filesystem write and a
Git commit also cannot be made atomic without replacing the simple file-based
boundary.

## Decision

Support opt-in local commits with `PI_TELEGRAM_MEMORY_GIT_AUTOCOMMIT=1`. Before
an `add`, `update`, `delete`, or `happening-add`, require the configured memory
vault to be the exact Git worktree root and require an empty Git index. After a
successful mutation, stage and commit only the affected managed note path with
a generic `memory: <action> <UUID>` message. Git children discard ambient
`GIT_*` routing and command-configuration variables, force an empty hooks path,
disable commit signing, and have a bounded runtime. Never push.

Preflight failure prevents the memory mutation. If staging or committing fails
after the canonical file changed, return mutation success with a sanitized
`GIT_COMMIT_FAILED` result rather than inviting an unsafe retry. The changed
path may remain staged for manual recovery. Other unstaged files remain outside
the commit.

The generated systemd unit reads the optional, user-owned
`~/.config/pi-telegram-bridge/environment` file after its base environment.
Store the vault path and opt-in there so regenerated units and deployments do
not reset them. Disabled mode performs no Git discovery or command.

Scope promotion uses the same preflight, revision check, single-path commit,
and sanitized failure semantics as any other update. The commit message names
only the note UUID and does not disclose the old/new scope, owner, title, or
body.

## Considered Options

- **Enable automatically for any containing repository:** rejected because a
  parent repository could accidentally acquire personal memory files.
- **Commit and push automatically:** rejected because publishing private
  history requires a separate explicit trust and failure boundary.
- **Roll back the file when commit fails:** rejected because racing editor
  changes and irreversible deletes make rollback less trustworthy than
  reporting the persisted, uncommitted state.

## Consequences

- Agent-mediated mutations gain local history without collecting unrelated
  Obsidian edits or changing the Git remote.
- A dirty index pauses automated memory writes until it is resolved.
- Forgetting removes the canonical note but does not remove it from Git history;
  history rewriting remains manual and outside this feature.
- Enabling or changing this setting requires updating the durable environment
  file and restarting the service, not regenerating the unit.
