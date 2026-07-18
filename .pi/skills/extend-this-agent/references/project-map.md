# Telegram Agent Project Map

## Capability locations

- `.pi/skills/`: model guidance, one directory and `SKILL.md` per skill.
- `.pi/extensions/`: executable, repo-local Pi extensions; a single `.ts` file is the default.
- `src/`: the compiled, long-running Telegram bridge host.
- `tests/`: Vitest coverage for host behavior.
- `ARCHITECTURE.md` and `docs/adr/`: runtime boundaries and durable decisions.

The host deliberately rejects globally or ancestrally discovered skills and extensions. Add capabilities inside this repository; do not loosen that filter merely to reuse a global resource.

## Core source

- `src/daemon.ts`: process entrypoint and graceful shutdown.
- `src/host.ts`: Pi runtime construction, repo-local resource filtering, extension binding, session persistence, and Telegram ownership recovery. This is the main runtime boundary.
- `src/config.ts`: paths, environment configuration, secret-bearing config locations, and Telegram lock recovery rules.
- `src/inbox.ts`: SQLite-backed durable inbound-turn queue.
- `src/telegram-capabilities.ts`: narrow process-local contracts shared with the pinned `pi-telegram` fork.
- `src/package-paths.ts`: pinned extension entrypoint resolution.
- `src/lifecycle.ts`: shutdown latch and process signals.
- `src/service-unit.ts` and `src/install-service.ts`: systemd unit generation and installation.
- `src/setup.ts`: interactive Telegram setup launcher.

## Important constraints

- Keep `@llblab/pi-telegram` pinned. Changes to its host boundary require reading ADR-0002 and usually updating the fork separately.
- Preserve the dedicated session directory and same-cwd restart behavior.
- Never print Pi credentials or Telegram configuration.
- Extensions execute with the process's full permissions. Keep their inputs narrow, validate them, and avoid hidden network or filesystem side effects.
- Start long-lived extension resources from `session_start` (not the factory) and clean them up idempotently on `session_shutdown`.
- The host runs extensions in RPC mode. Do not assume an interactive terminal; guard TUI-only behavior and prefer RPC-compatible APIs.

## Pi extension references

- Read Pi's installed `docs/extensions.md` before implementing an unfamiliar API. Resolve it relative to the installed `@earendil-works/pi-coding-agent` package rather than copying documentation into this repo.
- Inspect the installed `examples/extensions/README.md` to choose a focused example. Particularly useful starting points are `hello.ts` (minimal typed tool), `rpc-demo.ts` (RPC-compatible UI), `permission-gate.ts` (event interception), `dynamic-resources/` (skills/resources), and `reload-runtime.ts` (safe reload flow).
- Use `defineTool` plus `Type` for typed custom tools. Use `StringEnum` from `@earendil-works/pi-ai` instead of unions of string literals when an enum must work with Google models.
- Persist branch-sensitive extension state in session entries or tool-result `details`, and reconstruct it from the current branch on `session_start` and relevant navigation events.
- Agent Skills format: <https://agentskills.io/specification>
- Local summaries: `.pi/extensions.md` and `.pi/skills.md`.
