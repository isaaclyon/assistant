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
