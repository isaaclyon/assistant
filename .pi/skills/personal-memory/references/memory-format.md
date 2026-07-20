# Personal memory storage and protocol

Canonical memory is ordinary Markdown outside the repository. The default root
is `~/.local/share/pi-telegram-bridge/memory`; set `PI_TELEGRAM_MEMORY_DIR`
(absolute, or relative to the user home) to override it per invocation. The
directory can be opened directly as an Obsidian vault.

Set `PI_TELEGRAM_MEMORY_GIT_AUTOCOMMIT=1` to create local commits after
agent-mediated mutations. The vault must be the exact Git worktree root and its
index must be clean before mutation. Commits contain only the affected managed
note path, use a generic UUID-based message, skip hooks, and are never pushed.
The bridge service loads persistent values from
`~/.config/pi-telegram-bridge/environment`; this user-owned file survives
deployment. Git execution ignores ambient `GIT_*` routing, hooks, and signing
configuration and is time-bounded.

## Note format

One managed file per memory, named `<type-folder>/<uuid>.md`:

```markdown
---
schema: 1
id: "2f5f167d-7a18-4457-8de7-f2f801f1e934"
type: "preference"
status: "active"
title: "Coffee preference"
tags: ["coffee", "food"]
created: "2026-07-19T03:30:00.000Z"
updated: "2026-07-19T03:30:00.000Z"
---
Prefers light-roast coffee.
```

`schema`, `id`, `type`, `title`, `tags`, `created`, and `updated` are required.
`status` is `active`, `superseded`, or `archived`. New notes include it and
default to `active`; existing schema-1 notes without it are treated as active
and gain the field on their next CLI mutation.
Frontmatter may use any valid YAML representation, including block sequences
written by Obsidian. Unknown properties and comments retain their meaning on
CLI updates, though frontmatter formatting may be normalized. Invalid or
unsupported schemas are reported and never rewritten.

## Happenings section

Any managed note may include at most one strict, chronological Happenings
section. Entries are ordinary Markdown list items with a date-only ISO date and
an em dash:

```markdown
## Happenings

- 2026-07-18 — Pearl got new tires.
- 2026-07-19 — We drove Pearl to the mountains.
```

The section is historical context for its owning note, not an audit log. The
CLI validates the section and preserves it as Markdown. `happening-add` adds a
dated entry to an existing note with revision checking; `happenings` scans the
vault and can filter globally by `from`, `to`, `query`, `types`, and `limit`.

Type folders: `person`→`people`, `preference`→`preferences`, `event`→`events`,
`list`→`lists`, `recipe`→`recipes`, `purchase`→`purchases`,
`reference`→`references`. Unknown frontmatter keys (for example Obsidian
properties) are preserved semantically on update; malformed managed keys cause a
safe refusal, never a rewrite. Canonical note links use the stable target ID,
for example `[[2f5f167d-7a18-4457-8de7-f2f801f1e934|Coffee preference]]`.
The `revision` returned by the CLI is
`sha256:<hex>` of the raw file and gates updates and deletes.

## Session provenance

Use reserved footnote labels `source` or `source-<alphanumeric>` when a claim is
backed by a Pi/Telegram session entry. The definition is one exact line:

```markdown
A source-backed claim.[^source]

[^source]: Pi session `019abcde-session`, entry `a1b2c3d4`, `2026-07-19T03:30:00.000Z`.
```

The session ID and entry ID are stable machine anchors; the timestamp is for
human inspection and must exactly match the entry's canonical ISO timestamp.
`lint` resolves the append-only JSONL under
`<PI_TELEGRAM_BRIDGE_STATE_DIR>/sessions` (default
`~/.local/state/pi-telegram-bridge/sessions`) and reports malformed definitions,
missing definitions, unresolved sessions or entries, and timestamp mismatches.
Findings expose only an error code and note-relative path. Ordinary footnote
labels are not interpreted as Pi provenance.

Source validation runs only during `lint`. It does not run while compiling core
memory, does not use or expose message content, and never rewrites either notes
or sessions. It scans only referenced session files, with a shared 64 MiB and
100,000-entry limit per lint run; a limit breach or duplicate referenced entry
ID is a sanitized lint error. Provenance failures make the vault lint-invalid
but do not invalidate an otherwise valid core projection.

## Core memory

Add the exact plain-text marker `#core` to a paragraph, heading, list-item text,
or blockquote text to select that leaf block for bounded core memory. Markers in
frontmatter, fenced or inline code, and links do not select a block. A tagged
heading selects only the heading; footnote definitions are ignored, and tagged
container blocks never pull in untagged nested content.

The compiler strips marker and footnote-reference text, renders links as their
display labels, prefixes each block with its note title, and orders blocks by
the fixed type order, title, source position, and ID. The exact suffix starts
with `## Core Memory`; all generated text and newlines count toward a hard
4,000-Unicode-code-point budget. It warns at 3,600 and never truncates.
Only active notes contribute selected blocks; lint findings in inactive notes
are still reported but do not invalidate core.
Inspection is also bounded to 1,000 managed notes and 16 MiB of note data; an
oversized vault fails core compilation instead of returning a partial result.

`lint` reports the whole vault, including reserved session-provenance
footnotes. Only malformed core-bearing notes, invalid
links inside selected blocks, duplicate IDs that affect selected blocks, empty
selected blocks, and budget failures make `core` unavailable. Unrelated lint
errors do not disable a valid projection. `UNSAFE_ENTRY` and
`VAULT_LIMIT_EXCEEDED` failures always invalidate core.

Before each agent start, the always-on Telegram bridge recompiles and appends
the exact valid projection to its system prompt. The repo-local extension is a
no-op unless the host's process-local runtime marker is bound, so ordinary Pi
sessions opened in this repository do not receive personal core memory. Empty
core adds nothing. A compilation failure is logged by Pi and the turn continues
without core memory; no partial projection, generated file, or cache is used.
Changes take effect on the next agent start.

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
`UNSAFE_VAULT`, `UNSAFE_ENTRY`, `MALFORMED_NOTE`, `CORE_INVALID`,
`GIT_AUTOCOMMIT_UNAVAILABLE`), `1`
unexpected I/O failure. A completed `lint` emits an `ok:true` report on stdout;
when its `valid` field is false it exits `3` for automation.

With Git auto-commit enabled, successful `add`, `update`, `delete`, and
`happening-add` responses include `git:{committed:true}`. A failure after the
file mutation remains an `ok:true` response with
`git:{committed:false,code:"GIT_COMMIT_FAILED"}`; the canonical change exists
and must not be retried. `GIT_AUTOCOMMIT_UNAVAILABLE` exits `3` before mutation
when the vault is not its exact worktree root, the index is dirty, or Git cannot
be inspected. Forgetting does not remove prior content from Git history.

## Requests

```json
// add — status defaults to active; data: note metadata (no body)
{"type":"preference","status":"active","title":"Coffee preference","tags":["coffee"],"body":"Prefers light-roast coffee."}

// read — data: metadata plus body
{"id":"2f5f167d-7a18-4457-8de7-f2f801f1e934"}

// update — patch keys: status, title, tags, body; data: updated note with body
{"id":"2f5f167d-7a18-4457-8de7-f2f801f1e934","ifRevision":"sha256:…","patch":{"status":"superseded"}}

// delete — confirmId must equal id; data: {"id":…,"deleted":true}
{"id":"2f5f167d-7a18-4457-8de7-f2f801f1e934","ifRevision":"sha256:…","confirmId":"2f5f167d-7a18-4457-8de7-f2f801f1e934"}

// search — data: {results, truncated, scanTruncated, warnings, warningsTruncated}
{"query":"coffee preference","types":["preference"],"statuses":["active"],"limit":10}

// list — data: {memories:[metadata…]} sorted by updated desc
{"types":["preference"],"statuses":["active"]}

// happening-add — data: updated note plus the added happening
{"id":"2f5f167d-7a18-4457-8de7-f2f801f1e934","ifRevision":"sha256:…","date":"2026-07-19","text":"Pearl got new tires."}

// happenings — data: {results, truncated, scanTruncated, warnings, warningsTruncated}
{"from":"2026-01-01","to":"2026-12-31","query":"tires","statuses":["active"],"limit":50}

// lint — data: {valid, errors, warnings, truncated, core}; exits 3 when invalid
{}

// core — data: {text, characters, budget, warning, contributors}
{}
```

Search is bounded lexical matching: query ≤ 512 characters, all tokens must
match across title/tags/body, title matches outweigh tags outweigh body,
results capped at 50 (default 10), snippets at 240 characters. Warnings are
sanitized `{code, relativePath}` pairs; note contents never appear in errors.
Search, list, and happenings default to `statuses:["active"]`; pass explicit
statuses to inspect superseded or archived notes. Direct reads by ID work for
all statuses.
