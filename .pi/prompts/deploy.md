---
name: "deploy"
description: "Publish completed local changes to GitHub and drive the pull request to a usable finish line. This is part of completing coding work when the change is ready to ship; do not wait for a separate deploy or merge request. Includes proactive merge-conflict checks, CI monitoring, failed-check triage, fixes, re-pushes, merging, post-merge deployment monitoring, and final status reporting."
---

# GitHub Finish-Line Publish

## Operating posture

Act like the user asked for the change to get all the way to production, not
merely for a PR to be opened, whenever the implementation is complete and
validated.

- Keep ownership of the flow after opening the PR: watch mergeability, watch CI, fix failures you can safely fix, push follow-up commits, and re-check.
- Be automatic about mechanical waiting, triage, publishing, merging, and
  normal post-merge deployment monitoring. Assume all existing dirty changes
  belong to the work intentionally undertaken in this session. Stage them by
  default; exclude only changes that are clearly half-baked or unsafe to
  publish (especially secrets), and explain each exclusion.
- Continue until the PR is green and mergeable, merged if possible to merge, or blocked by something that needs the user or an external system.
- Explain practical blockers in plain language, including why the blocker needs user input.

## Prerequisites

- Require GitHub CLI `gh`. Check `gh --version`. If missing, ask the user to install `gh` and stop.
- Require authenticated `gh` session. Run `gh auth status`. If not authenticated, ask the user to run `gh auth login` (and re-run `gh auth status`) before continuing.
- Require a local git repository with an accessible GitHub remote.
- Inspect `git worktree list --porcelain` before choosing or cleaning branches.
  A default branch already checked out in another worktree cannot also be
  checked out in the current worktree.

## Naming conventions

- Branch: `{conventional commit prefix}/{description}` when starting from main/master/default.
- Commit: `{description}` (terse).
- PR title: `(conventional commit prefix) {description}` summarizing the full diff.

## Workflow

1. Confirm intended scope.
   - Run `git status -sb` and inspect the diff before staging.
   - Treat dirty changes as in scope unless they are clearly half-baked,
     or unsafe to publish (especially secrets). Do not ask merely because the
     worktree is dirty.
   - Use `git add -A` when the worktree is ready; otherwise stage the complete
     inferred scope and leave out only clearly excluded changes.
2. Pick the branch strategy.
   - If on main/master/default, create a branch: `git checkout -b "{conventional commit prefix}/{description}"`.
   - Otherwise stay on the current branch.
3. Run relevant local checks before publishing when practical.
   - Use the repo's normal test, lint, typecheck, dbt, or build commands.
   - If checks fail due to missing dependencies or tools, install what is needed and rerun once.
4. Commit intentionally.
   - Stage only intended files.
   - Commit tersely with the description: `git commit -m "{conventional commit prefix} {description}"`.
5. Push with tracking: `git push -u origin $(git branch --show-current)`.
   - If push is rejected because the remote branch moved, fetch and integrate the remote branch before retrying.
   - Avoid force-push unless the branch is clearly agent-owned and force-with-lease is the safest option.
6. Open or update the PR.
   - Prefer an existing PR for the current branch when one exists: `gh pr view --json url,number,state`.
   - Otherwise create one: `GH_PROMPT_DISABLED=1 GIT_TERMINAL_PROMPT=0 gh pr create --fill --head $(git branch --show-current)`.
   - Write the PR body to a temp file with real newlines and pass it with `--body-file`; do not paste escaped `\n` markdown.
   - PR description must cover what changed, why it changed, user or developer impact, root cause for fixes, and checks used to validate.
7. Drive the PR to green.
   - Check mergeability after the PR exists: `gh pr view --json mergeable,mergeStateStatus,baseRefName,headRefName,url`.
   - Watch checks: `gh pr checks --watch --interval 10`.
   - If checks are pending for a long time, keep monitoring. If the environment supports thread heartbeats or scheduled follow-up, create a temporary heartbeat to continue watching and delete it once the PR is green, merged, or blocked.

## Merge-conflict handling

- Proactively check whether the branch is behind or conflicted after the PR opens and after each push.
- Fetch the base branch before resolving: `git fetch origin <base-branch>`.
- Prefer merging `origin/<base-branch>` into an already-published PR branch unless the repository clearly prefers rebasing. Merging avoids rewriting remote history, which is safer when the branch may be visible to others.
- If conflicts appear, inspect each conflicted file, resolve according to the intended behavior, run the relevant checks, commit the conflict resolution, push, then re-check mergeability.
- If the conflict is a business/product decision rather than a mechanical code conflict, stop and ask the user with a short explanation of the choices and why the agent cannot safely decide.

## Failed-CI handling

- When CI fails, do not stop at reporting failure.
- Identify the failing job and useful logs:
  - Start with `gh pr checks`.
  - Use `gh run view <run-id> --log-failed` or the run URL when logs are needed.
- Decide whether the failure is code, test, dependency, infrastructure, permissions, or flaky.
- For code/test/dependency failures that are in scope, fix locally, run the targeted failing check plus any nearby relevant checks, commit, push, and watch CI again.
- For likely flaky failures, rerun the failed job once if GitHub permissions allow it, then keep watching.
- Stop only when the PR is green, the failure is external or permission-gated, or the fix would require a product decision outside the requested scope.

## Merge handling

- Merge only when CI passes, no conflicts appear, and the implementation is
  not clearly half-baked. Once true, merge without asking for another approval.
- Use the repository's normal merge style when obvious; otherwise prefer the least surprising GitHub default.
- After merge, verify the PR's `mergedAt` and merge commit through `gh pr view`.
  If a push-to-default-branch workflow performs deployment or other required
  validation, find the run for that exact merge SHA and watch it to completion.
  Treat a failed post-merge deployment as an active blocker and triage it using
  the failed-CI workflow above.

## Post-merge branch and worktree cleanup

- Cleanup begins only after GitHub confirms the PR is merged. Never delete an
  unmerged branch, remove a worktree, discard local changes, or clean a branch
  whose scope is uncertain.
- Check `gh repo view --json deleteBranchOnMerge`. When
  `deleteBranchOnMerge` is enabled, GitHub owns future remote head-branch
  deletion. Otherwise, delete only the just-merged remote head branch with
  `git push origin --delete <branch>` after confirming the merge.
- Run `git fetch --prune` so deleted remote branches disappear locally.
- If the current clean worktree still has the merged feature branch checked
  out, inspect `git worktree list --porcelain`:
  - when the base branch is checked out elsewhere, run
    `git switch --detach origin/<base>`, then `git branch -d <feature>`;
  - otherwise switch to the base branch, fast-forward it, then delete the local
    feature branch with `git branch -d <feature>`.
- A cleanup failure does not undo a successful merge. Diagnose it, avoid
  force-deleting work, and report any branch or worktree intentionally left in
  place.

## Final report

Report the branch, commit(s), PR URL, merge commit, PR and post-merge CI/deploy
results, cleanup performed, fixes pushed after opening the PR, and anything
still blocked.
