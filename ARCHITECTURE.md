# Architecture

## Boundaries

- **Host:** owns process lifetime, Pi runtime creation, persistent session selection, signal handling, and service installation.
- **Pi:** owns agent execution, model/tool state, extension lifecycle, and conversation persistence.
- **pi-telegram:** owns Telegram polling, pairing, routing, rendering, controls, and update-offset persistence.
- **systemd:** owns boot activation, restart policy, and logs.

The host loads a full-commit-pinned `isaaclyon/pi-telegram` fork through Pi's `DefaultResourceLoader` and binds extensions in RPC mode. The RPC binding includes Pi's official command-context session actions (`waitForIdle`, `newSession`, `fork`, tree navigation, session switching, and reload). The fork's narrow process-local host capability delegates Telegram `/new` to `AgentSessionRuntime.newSession()` without exposing the runtime or retaining stale extension contexts. The bridge repo is the agent's home base, so ancestor server guidance and local bridge architecture are loaded together; filesystem/tool access is not restricted to that cwd. The host does not copy extension source or emulate the TUI. See ADR-0002.

## State

| State | Location | Owner |
| --- | --- | --- |
| Pi session | `~/.local/state/pi-telegram-bridge/sessions` | Pi `SessionManager` |
| Pi credentials/settings | `~/.pi/agent` | Pi |
| Telegram token/pairing/offset | `~/.pi/agent/telegram.json` | pi-telegram |
| Telegram polling ownership | `~/.pi/agent/locks.json` | pi-telegram |
| Process logs | user journal | systemd |

## Startup

1. Resolve dedicated state and working-directory paths.
2. Continue the most recent session in the bridge-only session directory.
3. Build an `AgentSessionRuntime` with the upstream Telegram extension path.
4. Bind extensions in RPC mode, emitting `session_start`.
5. Let pi-telegram resume an owned/stale lock, or invoke `/telegram-connect` when no owner exists.
6. Monitor polling ownership every five seconds. A live external Pi owner is respected; when it exits, the host reconnects automatically.
7. Wait for SIGINT, SIGTERM, or an extension shutdown request.

## Shutdown

The host disposes `AgentSessionRuntime`, which emits `session_shutdown` before invalidating the session. This lets pi-telegram stop long polling and timers cleanly.

## Known limitation

Pi sessions and Telegram offsets are durable, but pi-telegram's accepted-turn queue is process memory. True at-least-once execution requires a transactional inbox outside the extension's current queue.
