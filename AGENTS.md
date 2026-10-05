# Agent guidance

- Read `ARCHITECTURE.md` and `docs/adr/` before changing runtime boundaries.
- Keep `@llblab/pi-telegram` as a pinned dependency; do not vendor it without revisiting ADR-0001.
- Treat `~/.pi/agent/telegram.json` and Pi credential files as secrets; never print their contents.
- Preserve the dedicated bridge session directory and same-cwd restart behavior.
- Run `npm run check:changed` and `npm run build` after code changes. This keeps
  all type checks and ordinary tests, and skips browser integration tests for
  unrelated changes. Set `PI_TEST_BASE` to the comparison commit (default:
  `origin/main`). Use `npm run check` to force the complete suite. CI selects
  against the PR base or the previous main commit; missing history runs all tests.
- Name browser integration suites `tests/*-browser.test.ts` so changed-file
  selection discovers them. Keep fast browser unit tests in the ordinary suite.
  If a browser test loads a new asset/helper by filename rather than importing
  it, add its path to `scripts/browser-test-selection.mjs` and cover the rule.
- Upgrade the four Pi runtime packages together with exact pins. Review weekly
  grouped update PRs using `docs/pi-upgrades.md`; preserve the compatibility
  gates and source-checked install patches, and do not auto-merge updates.
- Do not enable or restart the live service during tests unless explicitly working on deployment.

## Durable capabilities and temporary tasks

- Keep reusable mechanisms in skills and source. Keep individual requests,
  products, people, URLs, baselines, deadlines, and task-specific state in
  private task configuration outside the repository.
- Recurring execution does not make a task durable infrastructure. Represent
  situational work under `<stateDir>/temporary/<task-kind>/<task-id>/`, with
  its purpose, creation date, end condition, and a retirement operation.
- Before adding a capability, ask whether a new instance of the same task
  could be configured without editing code or deploying. If not, separate
  the reusable mechanism from the task data. Use synthetic examples in tests.
- Do not turn a one-off workaround into a permanent adapter without evidence
  that it represents a reusable interface. Unsupported sources can remain
  temporary research tasks; they do not justify product-specific infrastructure.

## Git worktree placement

- Create new worktrees inside the repository's primary checkout at
  `.worktrees/<task-name>/`. Do not create sibling `assistant-*` directories or
  worktrees under `/tmp`.
- Inspect `git worktree list --porcelain` to locate the primary checkout. When
  already in a linked worktree, use an absolute path under the primary
  checkout's `.worktrees/`; do not nest worktrees inside the current worktree.
- From the primary checkout, for example:
  `git worktree add .worktrees/my-task -b feat/my-task`.
- Preserve existing worktrees and their uncommitted changes. Move or remove
  them only as part of an explicitly requested migration or appropriate
  post-merge cleanup.

## Extension & skill filtering (why the bridge can't see global Pi resources)

`src/host.ts` disables normal extension/skill discovery and passes Pi only the
pinned dependencies plus the resources selected by the instance's profile in
`.pi/capabilities.json`, canonicalized inside the release. This happens before
extension imports or factories execute; a selected resource whose symlink
escapes the release fails startup (`src/capabilities.ts`). This is
deliberate — the always-on bridge must not gain capabilities from `~/.pi/agent`,
`~/.agents`, or ancestor `.agents` dirs without going through git.

Consequence: global Pi extensions do **not** apply here. E.g. web access comes from
the global `pi-web-access` extension (`~/.pi/agent/settings.json`), which the bridge
drops. To give the bridge a capability, add the extension **repo-locally** (under
`.pi/extensions/`), register it in `.pi/capabilities.json`, and select it in each
profile that should load it. Don't loosen the filter.

## CLAUDE.md / AGENTS.md

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md`; both Claude Code and other
development agents read the same content. The always-on Telegram runtime does not
inherit this file; its single instruction source is `.pi/telegram/AGENTS.md` (see
ADR-0009).
