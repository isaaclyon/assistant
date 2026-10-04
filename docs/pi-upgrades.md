# Keeping Pi current

## GPT-6.1 Sol support

The guarded Codex conversion install patch backports GPT-6.1 Sol's catalog
entry and GPT-6 request-path recognition from upstream 3.0.40 into our pinned
3.0.39 adapter. This enables Responses Lite and native reasoning changes,
with upstream's 272K context window, 128K output limit, pricing, and low through
max reasoning levels. Off and minimal are unavailable. The existing fast-mode
setting applies through the ordinary Codex request options.

This avoids importing the adapter's unrelated context-management changes;
newer 3.0.43+ releases also require Pi 1.0. Remove the backport when upgrading
to an adapter with native support. Offline catalog and request-path tests cover
registration; account-level availability still depends on the Codex service.

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

The Telegram fork, Codex conversion adapter, web extension, and retry extension remain separate
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
- Actual Codex request serialization from transcript contexts,
  including instruction sections and tool additions/removals. The real-host test
  checks outgoing instructions and tool schemas after retry, compaction, and
  session replacement.
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
- Pi now carries instructions and tools in transcript system messages. Adapter
  2.2.13 silently dropped them. Codex conversion 3.0.39 natively supports this
  format; no request-serialization patch is needed. Tests inspect the actual
  outgoing request after retries, compaction, and session replacement.
- The Telegram fork needed `max` added to its thinking-level contract and menu.
- Pi's `agent_settled` boundary remains the correct final-delivery hook; retain
  the tested lifecycle patch.

Sources: [Pi changelog](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/CHANGELOG.md)
and [Dependabot options](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference).

## Extension refresh after the tool-access regression

- Pin Codex conversion 3.0.39 and retry 0.31.0. Review the installed adapter's
  `CHANGELOG.md` and retry's `README.md` against the Pi 0.87.1 runtime.
- Retarget the guarded bridge-only config-path patch to the adapter's new
  `config-store.js` module. Keep per-instance configuration and credentials.
- Codex conversion 3 split web access into a separate package. Explicitly load
  pinned `@howaboua/pi-codex-web-run` 0.0.4 and fail startup if it cannot load.
  The real-host compatibility test requires `web_run` alongside shell/patch tools.
  Image generation remains uninstalled. Default execution stays normal; context
  management and LAN voice are not enabled by this upgrade.
- Keep the custom Telegram fork at its latest reviewed commit. Upstream 0.51.5
  changes the runtime integration substantially and requires a separate migration
  preserving household routing, durable inbox, session replacement, and patches.
