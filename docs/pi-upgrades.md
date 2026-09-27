# Keeping Pi current

All four direct Pi packages use the same exact stable version in `package.json`.
Commit their lockfile together. The version-alignment test also checks nested
SDK copies installed by Pi's published shrinkwrap. Do not replace pins with
`latest`, caret ranges, or updates during service startup.

## Weekly updates

`.github/dependabot.yml` checks npm each Monday at 09:00 America/Denver. It
groups the four Pi packages into one PR, waits three days after publication,
and keeps at most one version-update PR open. PRs include upstream release
information and are assigned to the repository owner for review. The existing
pull-request CI runs with read-only permissions and no production credentials.
There is no automatic merge of dependency PRs.

Aim to review and deploy a compatible stable release within two weeks. A
relevant urgent security fix can be upgraded manually without waiting for the
weekly check or cooldown. A failed compatibility check needs a fix or an
explicitly documented deferral; do not bypass it to meet the target.

The Telegram fork, Codex conversion adapter, and retry extension remain separate
reviewed pins. Review their compatibility during each Pi update; a new Pi
release is not permission to float these dependencies or ignore patch guards.

## Upgrade procedure

1. Work in an isolated checkout. Read the changes since the installed release,
   especially session persistence, provider context, extension events, tools,
   and CLI flags. Use the candidate package's own docs and declarations.
2. Update all four Pi pins and regenerate `package-lock.json`. Check all five
   source/version-checked install patches still apply. Keep any fork adjustment
   in its own reviewed commit and pin that complete SHA.
3. Run `npm ci`, `npm run check`, and `npm run build`. For focused diagnosis,
   use `npm run test:pi-compat`.
4. Review the PR after CI passes. Merge through the normal deployment workflow
   during a quiet conversation window.
5. Observe the deployment's exact-release readiness checks and completion
   notification, then confirm an ordinary Telegram response. Keep the checkpoint
   until the upgrade is verified.

## Compatibility gates

`npm run check` includes:

- Host and repo-local extension type checking.
- Type checking the **installed, patched Telegram fork** against the candidate
  SDK. This catches incompatible Pi types even though Pi loads the fork at runtime.
- Exact version alignment of direct and nested Pi runtime packages.
- An offline real-host test using the pinned Telegram, Codex, and retry
  extensions. It resumes a synthetic legacy v3 JSONL session, verifies injected
  instructions and memory, retries a provider error, executes a synthetic tool,
  checks stream and settlement events, compacts, and replaces the session while
  retaining history. Network inference and summary generation are synthetic.
- A real bundled-CLI child test proving the subagent process still loads exactly
  the read-only tools and returns a final report with an offline provider.
- Existing queue/replay, `/new`, Jev routing, job acceptance/handoff, attachment,
  target-isolation, and deployment/recovery regressions.

Tests use disposable state and fake credentials. They do not start another
poller for a live bot or run migrations against production history. They cannot
prove live provider availability or Telegram client behavior; verify those after
deployment through normal operation.

## Recovery

The normal deployment takes a matching code/state checkpoint before candidate
startup. Follow the [fleet recovery procedure](household-fleet.md#recovery-checkpoints-and-failure-holds).
Once a candidate may have accepted work, do not automatically restore an older
snapshot or run old binaries against changed state. Preserve the new evidence
and repair forward or reconcile recovery explicitly.

## 0.80.10 → 0.87.1 review

- The coding-agent session format remains v3. New context-edit and usage entries
  are additive; session readers already ignore non-message records.
- SessionManager now owns finalized provider context. Host routing reads its
  branch and replacement uses the official runtime lifecycle.
- RPC/JSON streaming uses deltas; the background runner consumes final text.
- The existing adapter's context hook filters conversation messages and leaves
  system/tool restoration to Pi. Offline tests verify instructions and tools
  survive both retries and compaction.
- The Telegram fork needed `max` added to its thinking-level contract and menu.
- Pi's `agent_settled` boundary remains the correct final-delivery hook; retain
  the tested lifecycle patch.

Sources: [Pi changelog](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/CHANGELOG.md)
and [Dependabot options](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference).
