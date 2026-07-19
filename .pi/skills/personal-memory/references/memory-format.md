# Personal memory storage and protocol

Canonical memory is ordinary Markdown outside the repository. The default root
is `~/.local/share/pi-telegram-bridge/memory`; set `PI_TELEGRAM_MEMORY_DIR`
(absolute, or relative to the user home) to override it per invocation. The
directory can be opened directly as an Obsidian vault.

## Note format

One managed file per memory, named `<type-folder>/<uuid>.md`:

```markdown
---
id: "2f5f167d-7a18-4457-8de7-f2f801f1e934"
type: "preference"
title: "Coffee preference"
tags: ["coffee", "food"]
created: "2026-07-19T03:30:00.000Z"
updated: "2026-07-19T03:30:00.000Z"
---
Prefers light-roast coffee.
```

Type folders: `person`→`people`, `preference`→`preferences`, `event`→`events`,
`list`→`lists`, `recipe`→`recipes`, `purchase`→`purchases`,
`reference`→`references`. Unknown frontmatter keys (for example Obsidian
properties) are preserved verbatim on update; malformed managed keys cause a
safe refusal, never a rewrite. The `revision` returned by the CLI is
`sha256:<hex>` of the raw file and gates updates and deletes.

## CLI protocol

The subcommand is the only argv; the request is exactly one JSON object line on
stdin (max ~300 KiB). Success emits one line on stdout, failure one line on
stderr:

```json
{"schemaVersion":1,"ok":true,"data":{}}
```

```json
{"schemaVersion":1,"ok":false,"error":{"code":"INVALID_INPUT","message":"Request is invalid"}}
```

Exit codes: `0` success, `2` usage/validation, `3` expected operational failure
(`NOT_FOUND`, `REVISION_CONFLICT`, `DUPLICATE_ID`, `CONFIRMATION_REQUIRED`,
`UNSAFE_VAULT`, `UNSAFE_ENTRY`, `MALFORMED_NOTE`), `1` unexpected I/O failure.

## Requests

```json
// add — data: note metadata (no body)
{"type":"preference","title":"Coffee preference","tags":["coffee"],"body":"Prefers light-roast coffee."}

// read — data: metadata plus body
{"id":"2f5f167d-7a18-4457-8de7-f2f801f1e934"}

// update — patch keys: title, tags, body; data: updated note with body
{"id":"2f5f167d-7a18-4457-8de7-f2f801f1e934","ifRevision":"sha256:…","patch":{"body":"Prefers medium-roast coffee."}}

// delete — confirmId must equal id; data: {"id":…,"deleted":true}
{"id":"2f5f167d-7a18-4457-8de7-f2f801f1e934","ifRevision":"sha256:…","confirmId":"2f5f167d-7a18-4457-8de7-f2f801f1e934"}

// search — data: {results, truncated, scanTruncated, warnings, warningsTruncated}
{"query":"coffee preference","types":["preference"],"limit":10}

// list — data: {memories:[metadata…]} sorted by updated desc
{"types":["preference"]}
```

Search is bounded lexical matching: query ≤ 512 characters, all tokens must
match across title/tags/body, title matches outweigh tags outweigh body,
results capped at 50 (default 10), snippets at 240 characters. Warnings are
sanitized `{code, relativePath}` pairs; note contents never appear in errors.
