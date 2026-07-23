# Architecture

## Boundaries

- **Host:** owns instance selection, process lifetime, Pi runtime creation, persistent session selection, signal handling, and service installation.
- **Pi:** owns agent execution, model/tool state, extension lifecycle, and conversation persistence.
- **pi-telegram:** owns Telegram polling, pairing, routing, rendering, controls, and update-offset persistence.
- **systemd:** owns one unit per instance, boot activation, restart policy, and logs.
- **GitHub Actions:** owns post-merge validation and serialized production deployment through the server's repository-scoped runner.

The host loads a full-commit-pinned `isaaclyon/pi-telegram` fork through Pi's `DefaultResourceLoader` and binds extensions in RPC mode. A version- and source-checked postinstall patch replaces raw tool-call status labels with deterministic, privacy-safe activity descriptions; see [ADR-0007](docs/adr/0007-patch-telegram-tool-activity-labels.md). The RPC binding includes Pi's official command-context session actions (`waitForIdle`, `newSession`, `fork`, tree navigation, session switching, and reload). The fork's narrow process-local host capability delegates Telegram `/new` to `AgentSessionRuntime.newSession()` without exposing the runtime or retaining stale extension contexts. In fleet mode, the host separates mutable `workspaceCwd` from immutable `resourceRoot`, disables hierarchical discovery, and supplies only the selected profile from `.pi/capabilities.json`; see [ADR-0009](docs/adr/0009-isolate-telegram-agent-instructions.md) and [ADR-0020](docs/adr/0020-run-a-household-bot-fleet-from-one-release.md). Canonicalized resources must remain inside the release, and symlink escapes are rejected. Global Pi/Agents directories and workspace-local capabilities never execute in the bridge. Filesystem tool access itself is not restricted to the cwd.

The host explicitly loads the pinned, repo-installed Codex conversion and retry dependencies; ordinary Pi sessions opened in this repo do not auto-discover them. The retry extension classifies transient Codex websocket/backend failures and stalled streams for Pi's built-in retry policy. A version-checked install patch makes `pi-telegram` finalize the active turn on Pi's `agent_settled` event so retries keep their Telegram destination. Another patch gives the Codex extension a bridge-only settings path while preserving the shared Pi agent directory required by credentials and Telegram ownership. See ADR-0002, ADR-0004, and ADR-0013.

## State

| State | Location | Owner |
| --- | --- | --- |
| Pi session | `~/.local/state/pi-telegram-bridge/sessions` | Pi `SessionManager` |
| Pi credentials/settings | `~/.pi/agent` | Pi |
| Telegram Codex settings | `~/.local/state/pi-telegram-bridge/pi-codex-conversion.json` | Codex conversion extension |
| Telegram token/pairing/offset | `~/.pi/agent/telegram.json` | pi-telegram |
| Telegram polling ownership | `~/.pi/agent/locks.json` | pi-telegram |
| Bridge environment overrides | `~/.config/pi-telegram-bridge/environment` | User/systemd |
| Scheduled job definitions | `<stateDir>/jobs.json` | Agent/user |
| Scheduled job run state | `<stateDir>/jobs-state.json` | Host |
| Heartbeat observations | `<stateDir>/checkers/*.json` | Host |
| Background subagent batches and temporary sessions | `<stateDir>/subagents/` | Host |
| Personal memory vault | `~/.local/share/pi-telegram-bridge/memory` (override: `PI_TELEGRAM_MEMORY_DIR`) | `personal-memory` skill CLI |
| Process logs | user journal | systemd |

Fleet mode replaces singleton state rows with per-instance paths under
`<stateRoot>/instances/<id>` for sessions, SQLite inbox, Codex settings,
restart marker, checkers, job handoffs, and `runtime.json`. Telegram bot tokens,
pairing, offsets, and locks remain in named profiles in the private Pi agent
directory. Per-instance mode-`0600` environment files live under
`<configRoot>/instances/<id>.env`; the strict mode-`0600` instance manifest is
`<configRoot>/instances.json` by default.

Stateful heartbeat jobs separate their cron trigger, tracked TypeScript checker,
host-evaluated rule, and agent-prompt reaction. Checkers emit bounded structured
observations and never own mutable state. The host resolves checker IDs inside its
immutable release and executes them directly with Node, while atomically retaining
only the latest observation and temporal markers. See
[ADR-0019](docs/adr/0019-stateful-heartbeat-observations.md).

Background read-only delegation runs isolated Pi child processes with discovery
and built-in tools disabled. A child-only extension exposes canonicalized
repository inspection and public-web retrieval; the host persists bounded batch
state, owns timeout/cancellation/retention, and injects one target-scoped parent
synthesis turn after all jobs become terminal. See
[ADR-0021](docs/adr/0021-bounded-read-only-background-subagents.md).

In fleet mode, exactly one `jobsRole: coordinator` process owns cron, at,
heartbeat, and webhook trigger evaluation plus mutable run state. Version-3 jobs
name a stable target instance or `both-personal`. Before execution, the
coordinator writes an idempotent dispatch record and mode-`0600` handoff into
each recipient's state tree. The target drains its own handoffs into its own Pi
runtime, so capabilities, memory, credentials, and Telegram destination come
from the recipient rather than the coordinator. Per-recipient `pending` and
`enqueued` states prevent retrying completed fan-out recipients; a file left in
`processing` is reported as uncertain for operator review. External Telegram
send remains non-durable.

The memory vault is user-owned plain Markdown outside the checkout and
releases, so it survives deployment cleanup and can be opened directly in
Obsidian. Only the tracked skill-local CLI
(`.pi/skills/personal-memory/scripts/memory.mjs`) mutates it and exposes
schema-checked lint and bounded `#core` preview operations. Core output is
disposable derived state compiled directly from notes. A repo-local extension
appends it to the system prompt at each `before_agent_start`, but only while the
host's token-guarded process-local runtime marker is bound; ordinary Pi sessions
in this repository do not receive it. Compilation errors are logged by Pi and
the turn continues without core memory. There is no generated file, memory
daemon, database, or cache. Any future full-text index must be derived and
disposable, rebuilt from the Markdown. Every note has a `personal` scope with a
trusted owner or a `household` scope without an owner. Host-bound principal/view
values filter every read, search, list, core compilation, and mutation: Isaac
and Emma each see their own plus household; the household sees only household;
engineering sees none. Notes have active, superseded, or
archived lifecycle status. Normal retrieval and core compilation select active
notes; inactive notes remain available to
explicitly filtered queries and stable-ID reads. See
[ADR-0011](docs/adr/0011-store-personal-memory-in-a-private-markdown-vault.md)
and [ADR-0014](docs/adr/0014-compile-schema-checked-core-memory-from-markdown.md)
and [ADR-0015](docs/adr/0015-inject-core-memory-only-in-the-bridge-runtime.md)
and [ADR-0016](docs/adr/0016-filter-personal-memory-by-lifecycle-status.md).
Vault lint also validates reserved source footnotes against the bridge's
append-only Pi session IDs, entry IDs, and timestamps without reading session
message content into its report. This validation is not part of per-turn core
compilation; see
[ADR-0017](docs/adr/0017-validate-personal-memory-session-provenance.md).
When explicitly enabled, the CLI requires the vault itself to be a clean-index
Git worktree and commits only the note changed by each agent-mediated mutation.
The bridge reads this opt-in from a user-owned environment file outside release
deployment, and Git children discard ambient repository-routing variables,
hooks, signing, and unbounded execution. It never pushes; see
[ADR-0018](docs/adr/0018-commit-agent-mediated-memory-mutations-locally.md).

## Startup

1. Load the private instance manifest (or compatibility singleton), validate its invariants, and resolve separate release, workspace, config, and state paths.
2. Continue the most recent session in the bridge-only session directory.
3. Point Codex conversion at its bridge-only settings file.
4. Resolve the instance's default-deny capability profile from the immutable release and build an `AgentSessionRuntime` with the pinned dependencies.
5. Bind the process-local bridge runtime marker, then bind extensions in RPC mode, emitting `session_start`.
6. Bind exact Telegram surface/actor policy, then let pi-telegram resume the selected named profile lock or connect it when no owner exists.
7. Compile and append core memory before each agent start.
8. Recover bounded background-subagent state and bind the parent management tool.
9. Monitor polling ownership every five seconds. A live external Pi owner is respected; when it exits, the host reconnects automatically.
10. Wait for SIGINT, SIGTERM, or an extension shutdown request.

## Deployment

Pushes to `main` run checks on a GitHub-hosted runner. After they pass, the `assistant-production` self-hosted runner builds one immutable release for the exact merged SHA. If the external instance manifest exists, it preflights every instance and the job graph, installs all units, stops the compatibility singleton, and activates instances sequentially. Readiness requires exact instance ID, full release SHA, and stable systemd PID from private runtime metadata. Any failure restores every changed unit. Mutable state/workspaces and separate builder worktrees are preserved. Without a manifest, the compatibility singleton deployment remains available. See ADR-0005 and [the fleet runbook](docs/household-fleet.md).

Before activating a release with jobs schema version 2, deployment validates the
external jobs file and referenced compiled checkers from the immutable release.
The host has bounded read-only compatibility for version-1 cron, at, and webhook
jobs; it never rewrites them. Legacy shell-command heartbeats require manual
conversion and block deployment.

## Shutdown

The host disposes `AgentSessionRuntime`, which emits `session_shutdown` before invalidating the session. This lets pi-telegram stop long polling and timers cleanly.
Daemon shutdown gives that graceful disposal a bounded ten-second window. If an extension or transport teardown remains pending, the daemon forces the requested exit code so systemd can stop or restart the service instead of leaving a live process that no longer polls Telegram.

## Known limitation

Inbound turns are crash-durable through the bridge inbox, but outbound Telegram replies are not queued durably. A failed send leaves the generated answer in Pi's persistent session for recovery or re-asking.
