# Pi Telegram Bridge Host

A small, systemd-supervised SDK host for [`@llblab/pi-telegram`](https://github.com/llblab/pi-telegram). It keeps one persistent Pi session available through a private Telegram bot without vendoring or modifying the upstream extension.

## Runtime shape

```text
systemd user service
  └── this Node.js host
        └── Pi AgentSessionRuntime (persistent session)
              └── @llblab/pi-telegram (Telegram transport and UI)
```

The Pi runtime uses this repository as its working directory by default. Pi therefore loads both the server-level `/home/isaaclyon/AGENTS.md` and this repo's local architecture/agent guidance, while its tools remain free to work elsewhere on the server. Conversation sessions are isolated under `~/.local/state/pi-telegram-bridge/sessions`.

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

The service automatically restarts after failures. Pi conversation history, Telegram configuration, pairing, and Telegram update offsets persist across restarts. The upstream extension reclaims its stale same-working-directory ownership lock when the host returns.

## Configuration

Optional environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PI_TELEGRAM_BRIDGE_CWD` | process working directory (this repo under systemd) | Pi home base and context root |
| `PI_TELEGRAM_BRIDGE_STATE_DIR` | `~/.local/state/pi-telegram-bridge` | Dedicated session state |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | Pi credentials, settings, and Telegram config |
| `PI_BIN` | `pi` | Pi executable used only by `telegram:setup` |

Re-run `npm run service:install` after changing these variables so the generated unit captures the new paths.

## Security and durability boundary

The bot controls a Pi process with the current user's filesystem and command permissions. Keep the bot token private and pair only the intended Telegram account.

This host provides process restart and persistent Pi sessions, but `pi-telegram` keeps accepted queued turns in memory. A host crash after Telegram records an update but before the queued turn runs can lose that turn. A durable SQLite inbox/outbox is the next step if at-least-once prompt execution is required.

## Development

```bash
npm run typecheck
npm test
npm run build
```
