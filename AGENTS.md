# Agent guidance

- Read `ARCHITECTURE.md` and `docs/adr/` before changing runtime boundaries.
- Keep `@llblab/pi-telegram` as a pinned dependency; do not vendor it without revisiting ADR-0001.
- Treat `~/.pi/agent/telegram.json` and Pi credential files as secrets; never print their contents.
- Preserve the dedicated bridge session directory and same-cwd restart behavior.
- Run `npm run check` and `npm run build` after code changes.
- Do not enable or restart the live service during tests unless explicitly working on deployment.

## Extension & skill filtering (why the bridge can't see global Pi resources)

`src/host.ts` filters extensions/skills to repo-local paths only: anything whose
resolved path isn't under the bridge repo cwd (or the pinned telegram extension)
is dropped with an `Ignoring non-repo <thing>: ...` warning. This is deliberate —
the always-on bridge must not gain capabilities from `~/.pi/agent`, `~/.agents`,
or ancestor `.agents` dirs without going through git.

Consequence: global Pi extensions do **not** apply here. E.g. web access comes from
the global `pi-web-access` extension (`~/.pi/agent/settings.json`), which the bridge
drops. To give the bridge a capability, add the extension **repo-locally** (under
`.pi/extensions/`) so it resolves inside cwd — don't loosen the filter.

## CLAUDE.md / AGENTS.md

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md`; both Claude Code and other
agents read the same content.
