# Architecture

## Boundaries

- **Host:** owns process lifetime, Pi runtime creation, persistent session selection, signal handling, and service installation.
- **Pi:** owns agent execution, model/tool state, extension lifecycle, and conversation persistence.
- **pi-telegram:** owns Telegram polling, pairing, routing, rendering, controls, and update-offset persistence.
- **systemd:** owns boot activation, restart policy, and logs.
- **GitHub Actions:** owns post-merge validation and serialized production deployment through the server's repository-scoped runner.

The host loads a full-commit-pinned `isaaclyon/pi-telegram` fork through Pi's `DefaultResourceLoader` and binds extensions in RPC mode. A version- and source-checked postinstall patch replaces raw tool-call status labels with deterministic, privacy-safe activity descriptions; see [ADR-0007](docs/adr/0007-patch-telegram-tool-activity-labels.md). The RPC binding includes Pi's official command-context session actions (`waitForIdle`, `newSession`, `fork`, tree navigation, session switching, and reload). The fork's narrow process-local host capability delegates Telegram `/new` to `AgentSessionRuntime.newSession()` without exposing the runtime or retaining stale extension contexts. The bridge repo is the agent's home base, so ancestor server guidance and local bridge architecture are loaded together; filesystem/tool access is not restricted to that cwd. Extensions and skills discovered outside the bridge repo cwd (global `~/.pi/agent`, `~/.agents`, ancestor `.agents` dirs) are filtered out and logged, so the agent's capabilities are exactly what the repo ships.

The host explicitly loads the pinned, repo-installed Codex conversion dependency; ordinary Pi sessions opened in this repo do not auto-discover it. A version-checked install patch gives that extension a bridge-only settings path while preserving the shared Pi agent directory required by credentials and Telegram ownership. See ADR-0002 and ADR-0004.

## State

| State | Location | Owner |
| --- | --- | --- |
| Pi session | `~/.local/state/pi-telegram-bridge/sessions` | Pi `SessionManager` |
| Pi credentials/settings | `~/.pi/agent` | Pi |
| Telegram Codex settings | `~/.local/state/pi-telegram-bridge/pi-codex-conversion.json` | Codex conversion extension |
| Telegram token/pairing/offset | `~/.pi/agent/telegram.json` | pi-telegram |
| Telegram polling ownership | `~/.pi/agent/locks.json` | pi-telegram |
| Process logs | user journal | systemd |

## Startup

1. Resolve dedicated state and working-directory paths.
2. Continue the most recent session in the bridge-only session directory.
3. Point Codex conversion at its bridge-only settings file.
4. Build an `AgentSessionRuntime` with the upstream Telegram extension path and repo-local Codex extension.
5. Bind extensions in RPC mode, emitting `session_start`.
6. Let pi-telegram resume an owned/stale lock, or invoke `/telegram-connect` when no owner exists.
7. Monitor polling ownership every five seconds. A live external Pi owner is respected; when it exits, the host reconnects automatically.
8. Wait for SIGINT, SIGTERM, or an extension shutdown request.

## Deployment

Pushes to `main` run checks on a GitHub-hosted runner. After they pass, the `assistant-production` self-hosted runner builds an immutable release for the exact merged SHA, updates the canonical agent checkout, removes untracked and ignored project settings plus all repo-local extension/skill locations (`.pi` and `.agents`), points systemd at the release, and requires both the application-ready signal and a stable PID. Activation failure restores the previous unit. See ADR-0005.

## Shutdown

The host disposes `AgentSessionRuntime`, which emits `session_shutdown` before invalidating the session. This lets pi-telegram stop long polling and timers cleanly.
Daemon shutdown gives that graceful disposal a bounded ten-second window. If an extension or transport teardown remains pending, the daemon forces the requested exit code so systemd can stop or restart the service instead of leaving a live process that no longer polls Telegram.

## Known limitation

Inbound turns are crash-durable through the bridge inbox, but outbound Telegram replies are not queued durably. A failed send leaves the generated answer in Pi's persistent session for recovery or re-asking.
