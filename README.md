# Pi Telegram Bridge Host

A systemd-supervised SDK host for a [commit-pinned `pi-telegram` fork](https://github.com/isaaclyon/pi-telegram/commit/d9877050370219d69b56bcc3a510d45905101c03). It supports a compatibility singleton or a manifest-defined household fleet whose bots share one immutable capability release while keeping conversations, workspaces, credentials, and memory views distinct.

## Runtime shape

```text
one systemd user service per instance
  └── this Node.js host (shared exact release, selected instance)
        └── Pi AgentSessionRuntime (instance-persistent session)
              ├── @llblab/pi-telegram (private or household-group surface)
              └── @howaboua/pi-codex-conversion (Codex tools/prompt adapter)
```

The compatibility runtime uses this repository as its working directory. Fleet instances use separate mutable workspaces, but all extension, skill, and instruction code is selected from the shared immutable release through `.pi/capabilities.json`. The host disables hierarchical discovery; the root `AGENTS.md` remains developer guidance. Fleet conversations and inboxes live under `~/.local/state/pi-telegram-bridge/instances/<id>`.

## Initial setup

Requirements:

- Pi credentials/model already configured in `~/.pi/agent`.
- A Telegram bot token from [@BotFather](https://t.me/BotFather).

Install and verify dependencies:

```bash
npm ci
npm run check
```

Open the one-time interactive setup session:

```bash
npm run telegram:setup
```

Inside Pi:

1. Run `/telegram-setup` and enter the bot token.
2. Send `/start` to the bot from your Telegram account to pair it.
3. Confirm the bot responds, then exit Pi.

Install and start the systemd user service:

```bash
npm run service:install
```

User lingering is required for the service to run without an active login. It is already enabled on this server; verify with:

```bash
loginctl show-user "$USER" -p Linger
```

## Operations

```bash
systemctl --user status pi-telegram-bridge.service
systemctl --user restart pi-telegram-bridge.service
systemctl --user stop pi-telegram-bridge.service
journalctl --user -u pi-telegram-bridge.service -f
```

For a configured fleet, use `pi-telegram-bridge-<id>.service` or the glob
`pi-telegram-bridge-*.service`. The complete production setup, credential
namespaces, migration procedure, rollback behavior, and smoke matrix are in
[docs/household-fleet.md](docs/household-fleet.md). Production identity values
belong in a mode-`0600` external manifest; start from the tracked
[example](docs/examples/instances.example.json).

The Telegram `/restart` command gracefully restarts the bridge and sends a confirmation after the service is back online. The service automatically restarts after failures. Pi conversation history, Telegram configuration, pairing, and Telegram update offsets persist across restarts. The extension reclaims its stale same-working-directory ownership lock when the host returns. Telegram `/new` starts a fresh session in the same thread only when Pi and the Telegram queue are idle; otherwise it reports why replacement is unsafe. The engineering-only Builder Bot also exposes `/deploy` in Telegram autocomplete; it injects the tracked GitHub finish-line prompt so publishing work is driven through review, CI, and merge.

The `background_subagents` tool launches explicitly listed read-only research
tasks in isolated Pi processes and returns batch/job IDs immediately. Children
can inspect configured repository roots and public web content but receive no
shell, file mutation, Telegram, memory-write, scheduling, deployment, or nested
delegation capability. Completed batches are retained for seven days with
bounded output, then trigger one parent synthesis response in the originating
Telegram chat/topic.

The `message-link` skill creates private HTTPS review links for proposed text
messages. The page validates the recipient in the browser, keeps the draft
editable, and opens Messages only after a tap; sending remains separate. It is
served through tailnet-only Tailscale Serve and never puts recipient or body in
an HTTP request. Setup, health, and lifecycle details are in
[docs/messages-link.md](docs/messages-link.md).

## Deploying updates

Pull requests run `.github/workflows/deploy.yml` checks on GitHub-hosted CI. Merges to `main` rerun those checks, then the `assistant-production` self-hosted runner on `lyon-server` deploys the green commit and verifies the systemd user service. The single runner and a shared deployment lock serialize activation; superseded queued revisions exit successfully instead of rolling production backward. A failed check prevents deployment. The runner itself is managed by `github-actions-assistant.service`; check it with `systemctl --user status github-actions-assistant.service` on the server.

### Manual fallback

To ship a new commit to the box running the service, push to `origin/main`, then from a machine with SSH access:

```bash
npm run deploy
```

`scripts/deploy.sh` connects over SSH and invokes the same exact-SHA, immutable-release, locked deployment path used by Actions. It deploys only commits on `origin/main`, preserves tracked live edits by refusing to overwrite them, and applies the same rollback and readiness checks. The target is overridable:

| Variable | Default |
| --- | --- |
| `DEPLOY_HOST` | `lyon-server` |
| `DEPLOY_PATH` | `/home/isaaclyon/projects/assistant` |

The script sources nvm on the remote before invoking `node`/`npm`, since the nvm-managed toolchain is not on a non-interactive SSH `PATH`.

## Configuration

Optional environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PI_TELEGRAM_BRIDGE_CWD` | process working directory (this repo under systemd) | Pi home base and context root |
| `PI_TELEGRAM_BRIDGE_STATE_DIR` | `~/.local/state/pi-telegram-bridge` | Dedicated session state |
| `PI_TELEGRAM_BRIDGE_INSTANCE_MANIFEST` | unset | Enables fleet mode using a private manifest |
| `PI_TELEGRAM_BRIDGE_INSTANCE_ID` | unset | Stable instance selected by a fleet unit |
| `PI_TELEGRAM_BRIDGE_RESOURCE_ROOT` | release directory | Shared immutable capability/code root |
| `PI_TELEGRAM_BRIDGE_STATE_ROOT` | `~/.local/state/pi-telegram-bridge` | Parent for per-instance state |
| `PI_TELEGRAM_BRIDGE_CONFIG_ROOT` | `~/.config/pi-telegram-bridge` | Private manifest and credential environment root |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | Pi credentials, settings, and Telegram config |
| `PI_TELEGRAM_CODEX_CONFIG` | `<stateDir>/pi-codex-conversion.json` | Telegram-only Codex conversion settings |
| `PI_BIN` | `pi` | Pi executable used only by `telegram:setup` |
| `PI_TELEGRAM_MEMORY_DIR` | `~/.local/share/pi-telegram-bridge/memory` | Personal memory vault (absolute, or relative to the user home) |
| `PI_TELEGRAM_MEMORY_GIT_AUTOCOMMIT` | `0` | Set to `1` to commit agent-mediated memory mutations locally |

The service reads an optional durable environment file at
`~/.config/pi-telegram-bridge/environment`. Put persistent memory overrides
there so deployments retain them:

```text
PI_TELEGRAM_MEMORY_DIR=/home/isaaclyon/.local/share/pi-telegram-bridge/memory
PI_TELEGRAM_MEMORY_GIT_AUTOCOMMIT=1
```

Keep the file mode `0600` and restart the service after changing it. Shell
invocations of the memory CLI may still set these variables directly.

The Codex adapter defaults to normal mode for the bridge's `openai-codex` model, exposing `exec_command`, `write_stdin`, `apply_patch`, image viewing, and web search. Image generation is disabled. Its settings are independent of normal Pi sessions. The pinned extension receives this separate path through the version-checked patch in `scripts/patch-codex-conversion.mjs`; update that patch deliberately when changing the extension version.

## Personal memory

The assistant stores explicitly requested personal memories as plain Markdown
in `~/.local/share/pi-telegram-bridge/memory` (override with
`PI_TELEGRAM_MEMORY_DIR`). Supported V1 domains: people, preferences, events,
lists, recipes, purchases, and references. The vault lives outside the
checkout and releases, so it survives deployments; managed directories are
created mode 0700 and notes mode 0600. Open the directory directly in Obsidian
to browse or edit notes — human titles are in frontmatter, filenames are
UUIDs. Managed notes require `schema: 1` and accept normal YAML frontmatter;
CLI updates preserve its meaning and comments but may normalize formatting.
Each note is `personal` (owned by Isaac or Emma) or `household`. Personal bots
see only their own personal notes plus household notes; Shared Bot sees only
household notes; Builder sees none. Promotion to household is explicit and
revision-checked. Lifecycle status is `active`, `superseded`, or `archived`; normal queries and
core memory use active notes unless inactive statuses are explicitly requested.
Legacy notes without status remain active and gain the field on their next CLI
mutation.

When `PI_TELEGRAM_MEMORY_GIT_AUTOCOMMIT=1`, the vault must itself be the Git
worktree root and have no staged changes. Successful agent-mediated mutations
create a local commit containing only the affected note, with no automatic
push. Other unstaged Obsidian edits are left alone. A post-write Git failure is
reported separately because the canonical note has already changed. Deleting a
note does not erase it from Git history.

The always-on assistant uses separate indexed `assistant_memory_search` and
`assistant_session_search` tools for retrieval. Their private per-instance SQLite/FTS5
database is disposable and rebuildable from canonical Markdown and session
JSONL. The tracked skill-local CLI continues to own full-note reads, mutations,
list/happenings, lint, and core operations; it takes one JSON request line on
stdin and returns one bounded JSON line:

```bash
node .pi/skills/personal-memory/scripts/memory.mjs read <<'EOF'
{"id":"2f5f167d-7a18-4457-8de7-f2f801f1e934"}
EOF
```

The quoted heredoc closes stdin automatically and keeps note content out of
argv and the process list; avoid `printf '<json>' | …`, which does not.

Subcommands: `add`, `read`, `update`, `delete`, compatibility `search`, `list`,
`happening-add`, `happenings`, `lint`, `core`. `lint` validates the whole vault,
including reserved `[^source]` footnotes against bridge session IDs, entry IDs,
and timestamps. `core` previews a deterministic, title-prefixed projection of Markdown leaf
blocks marked `#core`, capped at 4,000 Unicode code points without truncation.
The always-on bridge recompiles and appends that projection to the system prompt
before every Telegram agent turn; ordinary Pi sessions in this repository do
not receive it. See
[`.pi/skills/personal-memory/references/memory-format.md`](.pi/skills/personal-memory/references/memory-format.md)
for the protocol and note format, and
[ADR-0011](docs/adr/0011-store-personal-memory-in-a-private-markdown-vault.md),
[ADR-0014](docs/adr/0014-compile-schema-checked-core-memory-from-markdown.md),
[ADR-0015](docs/adr/0015-inject-core-memory-only-in-the-bridge-runtime.md),
[ADR-0016](docs/adr/0016-filter-personal-memory-by-lifecycle-status.md),
[ADR-0017](docs/adr/0017-validate-personal-memory-session-provenance.md), and
[ADR-0018](docs/adr/0018-commit-agent-mediated-memory-mutations-locally.md),
[ADR-0026](docs/adr/0026-use-derived-fts-indexes-for-memory-and-session-search.md),
and the [search-index runbook](docs/search-index.md)
for the architecture decisions.

Boundaries to know:

- Memories are stored only on explicit request; secrets (credentials, tokens,
  card numbers) are refused.
- "Forget" permanently deletes the canonical note after a separate
  confirmation. It does not erase Telegram/Pi conversation history, filesystem
  backups, Git history, or third-party backups.
- Backups of the vault are the user's responsibility; it is an ordinary
  directory of Markdown files.

## Security and durability boundary

Each bot controls a Pi process with the current user's filesystem and command permissions. The fleet's memory, credential, conversation, and capability boundaries are semantic controls under one Unix identity, not hostile-user OS isolation. Keep tokens private and configure only the intended Telegram actors and exact household group.

This host provides process restart and persistent Pi sessions. Accepted inbound turns are also made crash-durable by a SQLite inbox at `<stateDir>/inbox.db` (`src/inbox.ts`): a turn is persisted the instant it is accepted, removed once Pi owns it, and replayed on startup, giving at-least-once execution across a host crash. Idempotency is keyed on a stable per-turn identity (chat plus source message id). The host and the pinned fork rendezvous on a shared process-global registry (`src/telegram-capabilities.ts`) — the same pattern as the session-replacement capability — so the compiled host never imports the source-only fork; binding is inert against a fork build that does not read it. Durable *outbound* delivery remains out of scope for ordinary assistant replies, but `/restart` has a small durable startup acknowledgment so operators can tell whether the process returned successfully. See [ADR-0003](docs/adr/0003-durable-inbound-inbox.md) and [ADR-0008](docs/adr/0008-restart-completion-notification.md).

## Development

```bash
npm run typecheck
npm test
npm run build
```
