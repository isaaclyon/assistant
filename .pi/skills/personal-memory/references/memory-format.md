# Personal memory storage and protocol

Canonical memory is ordinary Markdown outside the repository. The default root
is `~/.local/share/pi-telegram-bridge/memory`; set
`PI_TELEGRAM_MEMORY_DIR` to override it for an invocation.

The CLI accepts a subcommand in `argv` and one JSON request line on standard
input. It returns one versioned JSON envelope on standard output for success or
standard error for failure:

```json
{"schemaVersion":1,"ok":true,"data":{}}
```

```json
{"schemaVersion":1,"ok":false,"error":{"code":"INVALID_INPUT","message":"Request is invalid"}}
```

The finalized note format and command requests are defined by the implementation
plan at `.pi/plans/2026-07-18-personal-memory/plan.md`.

