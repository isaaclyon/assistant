# Agent guidance

- Read `ARCHITECTURE.md` and `docs/adr/` before changing runtime boundaries.
- Keep `@llblab/pi-telegram` as a pinned dependency; do not vendor it without revisiting ADR-0001.
- Treat `~/.pi/agent/telegram.json` and Pi credential files as secrets; never print their contents.
- Preserve the dedicated bridge session directory and same-cwd restart behavior.
- Run `npm run check` and `npm run build` after code changes.
- Do not enable or restart the live service during tests unless explicitly working on deployment.
