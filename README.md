# Pi Telegram Bridge Host

A small, systemd-supervised SDK host for a [commit-pinned `pi-telegram` fork](https://github.com/isaaclyon/pi-telegram/commit/a575e08b252bfd6e98be6d64e35c232bf3d1fa8b). It keeps one persistent Pi session available through a private Telegram bot and adds a narrow host-backed Telegram `/new` lifecycle bridge.

## Runtime shape

```text
systemd user service
  └── this Node.js host
        └── Pi AgentSessionRuntime (persistent session)
              ├── @llblab/pi-telegram (Telegram transport and UI)
              └── @howaboua/pi-codex-conversion (Codex tools/prompt adapter)
```

The Pi runtime uses this repository as its working directory by default, while its tools remain free to work elsewhere on the server when requested. The host disables hierarchical AGENTS discovery and loads only `.pi/telegram/AGENTS.md` for the Telegram runtime; the root `AGENTS.md` remains developer guidance. Conversation sessions are isolated under `~/.local/state/pi-telegram-bridge/sessions`.

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

The Telegram `/restart` command gracefully restarts the bridge and sends a confirmation after the service is back online. The service automatically restarts after failures. Pi conversation history, Telegram configuration, pairing, and Telegram update offsets persist across restarts. The extension reclaims its stale same-working-directory ownership lock when the host returns. Telegram `/new` starts a fresh session in the same thread only when Pi and the Telegram queue are idle; otherwise it reports why replacement is unsafe.

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
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | Pi credentials, settings, and Telegram config |
| `PI_TELEGRAM_CODEX_CONFIG` | `<stateDir>/pi-codex-conversion.json` | Telegram-only Codex conversion settings |
| `PI_BIN` | `pi` | Pi executable used only by `telegram:setup` |
| `PI_TELEGRAM_MEMORY_DIR` | `~/.local/share/pi-telegram-bridge/memory` | Personal memory vault (absolute, or relative to the user home) |

Re-run `npm run service:install` after changing these variables so the generated unit captures the new paths. The exception is `PI_TELEGRAM_MEMORY_DIR`: the memory CLI reads it on each invocation, so no service regeneration is needed.

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

All access goes through the tracked skill-local CLI, which takes one JSON
request line on stdin and returns one bounded JSON line:

```bash
node .pi/skills/personal-memory/scripts/memory.mjs search <<'EOF'
{"query":"coffee","limit":5}
EOF
```

The quoted heredoc closes stdin automatically and keeps note content out of
argv and the process list; avoid `printf '<json>' | …`, which does not.

Subcommands: `add`, `read`, `update`, `delete`, `search`, `list`,
`happening-add`, `happenings`, `lint`, `core`. `lint` validates the whole vault;
`core` previews a deterministic, title-prefixed projection of Markdown leaf
blocks marked `#core`, capped at 4,000 Unicode code points without truncation.
The always-on bridge recompiles and appends that projection to the system prompt
before every Telegram agent turn; ordinary Pi sessions in this repository do
not receive it. See
[`.pi/skills/personal-memory/references/memory-format.md`](.pi/skills/personal-memory/references/memory-format.md)
for the protocol and note format, and [ADR-0011](docs/adr/0011-store-personal-memory-in-a-private-markdown-vault.md)
and [ADR-0014](docs/adr/0014-compile-schema-checked-core-memory-from-markdown.md)
and [ADR-0015](docs/adr/0015-inject-core-memory-only-in-the-bridge-runtime.md)
for the architecture decisions.

Boundaries to know:

- Memories are stored only on explicit request; secrets (credentials, tokens,
  card numbers) are refused.
- "Forget" permanently deletes the canonical note after a separate
  confirmation. It does not erase Telegram/Pi conversation history, filesystem
  backups, or third-party backups.
- Backups of the vault are the user's responsibility; it is an ordinary
  directory of Markdown files.

## Security and durability boundary

The bot controls a Pi process with the current user's filesystem and command permissions. Keep the bot token private and pair only the intended Telegram account.

This host provides process restart and persistent Pi sessions. Accepted inbound turns are also made crash-durable by a SQLite inbox at `<stateDir>/inbox.db` (`src/inbox.ts`): a turn is persisted the instant it is accepted, removed once Pi owns it, and replayed on startup, giving at-least-once execution across a host crash. Idempotency is keyed on a stable per-turn identity (chat plus source message id). The host and the pinned fork rendezvous on a shared process-global registry (`src/telegram-capabilities.ts`) — the same pattern as the session-replacement capability — so the compiled host never imports the source-only fork; binding is inert against a fork build that does not read it. Durable *outbound* delivery remains out of scope for ordinary assistant replies, but `/restart` has a small durable startup acknowledgment so operators can tell whether the process returned successfully. See [ADR-0003](docs/adr/0003-durable-inbound-inbox.md) and [ADR-0008](docs/adr/0008-restart-completion-notification.md).

## Development

```bash
npm run typecheck
npm test
npm run build
```
