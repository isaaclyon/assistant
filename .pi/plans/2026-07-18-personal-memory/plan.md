## Understanding
- Build V1 durable personal memory without changing the always-on host into a memory service: private Markdown remains authoritative, and a self-contained repo-local skill owns conversational policy plus dependency-free `.mjs` scripts for safe CRUD/search.
- The runtime currently loads only canonicalized repo-local skills and exactly `.pi/telegram/AGENTS.md` (`src/host.ts:128-163,185-210`; ADR-0009). That instruction file currently denies durable memory (`.pi/telegram/AGENTS.md:40-44`), so the new contract must deliberately replace that statement while retaining the ban on tracked user facts.
- The implementation should add no daemon, event emitter, database, extension, external integration, or Obsidian dependency. A future SQLite FTS5 index may be derived and disposable, but is not part of V1.

## Relevant Context
- `ARCHITECTURE.md:3-24,37-39`: defines ownership/state/deployment boundaries; the memory vault needs a new state-table entry but must remain outside the checkout and immutable releases.
- `scripts/deploy-local.sh:126-163`: the canonical checkout remains the Pi cwd and tracked repo-local skills are restored during deployment. The CLI scripts therefore belong inside the tracked skill and must not depend on release-local `dist/`.
- `src/host.ts:128-163,185-210`: repo-local skills already load safely; no host resource-filter changes are needed.
- `src/config.ts:17-60,63-134`: use its home-relative override resolution and 0700-directory/0600-file/temp+rename conventions.
- `.pi/skills/personal-memory/scripts/` is the executable boundary. Use dependency-free Node ESM with JSDoc where useful and test the modules directly with Vitest; no service-unit or host configuration wiring is required.
- `.pi/skills/extend-this-agent/SKILL.md:10-16,31-40`: a skill plus command-backed CLI is the smallest approved mechanism; do not add an extension.
- `.pi/skills/manage-ynab/SKILL.md:29-39,57-73,140-142`: follow its explicit-write, shell-quoting, concise-output, destructive-confirmation, and privacy-safe error conventions.
- ADR-0003 keeps SQLite scoped to the inbound queue; ADR-0005 explains release deployment; ADR-0009 owns Telegram instructions; ADR-0010 confirms schedulers/webhooks are unrelated.

## Assumptions / Open Questions
- **No blocking questions.** Use the following conservative V1 defaults:
  - Persist only after the user explicitly asks to remember/save something or explicitly accepts an offer to remember it. Do not silently retain incidental statements, infer behavior, or derive preferences.
  - Supported kinds are `person`, `preference`, `event`, `list`, `recipe`, `purchase`, and `reference`. A wishlist is a `list`; do not add domain-specific schemas beyond kind/title/tags/body.
  - `type` is immutable in V1. Reclassification is rare and can be handled by creating the corrected note and, after confirmation, forgetting the old one.
  - “Forget” permanently removes the canonical note after a separate confirmation; V1 has no application trash or restore. Clearly state that this does not erase Telegram/Pi conversation history, filesystem backups, or third-party backups.
  - Default vault: `~/.local/share/pi-telegram-bridge/memory`, override: `PI_TELEGRAM_MEMORY_DIR`. This is an ordinary directory Obsidian can open as a vault; no `.obsidian` directory is created or required.

## Recommended Approach

### 1. Storage model
Use one managed Markdown file per memory:

```text
${PI_TELEGRAM_MEMORY_DIR:-~/.local/share/pi-telegram-bridge/memory}/
  people/<uuid>.md
  preferences/<uuid>.md
  events/<uuid>.md
  lists/<uuid>.md
  recipes/<uuid>.md
  purchases/<uuid>.md
  references/<uuid>.md
```

UUID-only filenames keep paths stable, prevent collisions, avoid leaking titles through path/error output, and make user-supplied paths unnecessary. Obsidian obtains the human title from frontmatter.

Canonical note format (valid YAML frontmatter plus ordinary Markdown):

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

Implement a deliberately narrow, dependency-free frontmatter codec:
- Managed scalar values are JSON-quoted YAML scalars; `tags` is an inline JSON array, also valid YAML.
- Managed keys must appear exactly once and validate strictly.
- Parse top-level YAML key blocks; retain unknown blocks/comments verbatim and re-emit them on update.
- Preserve the body byte-for-byte unless the update explicitly supplies a replacement.
- Reject a malformed managed note instead of repairing or overwriting it.
- Do not interpret Markdown body text as instructions.

### 2. Safe filesystem repository
Create `.pi/skills/personal-memory/scripts/store.mjs` (plus a small codec module only if needed) with:
- `crypto.randomUUID()` IDs and `sha256:<hex>` revisions computed from the raw Markdown.
- `add`, `read`, `update`, `delete`, `list`, and `search` operations.
- `update` requires `ifRevision`; `delete` requires both `ifRevision` and an exact `confirmId` matching `id`. This catches stale Obsidian/manual edits and accidental deletion requests.
- Add/update writes use a same-directory, unpredictable temp file opened with `wx`, mode 0600, then atomic rename; clean the temp on every failure. Create the vault/type directories with mode 0700. Delete uses `unlink` after revision/confirmation checks.
- Newly created managed files/directories get private modes; do not recursively chmod unrelated Obsidian content.
- Return only vault-relative paths. Never include absolute vault paths, note bodies, or raw exception objects in errors.

Path policy:
- Resolve the configured directory against home, then reject it lexically if it equals or descends from either the canonical bridge cwd or the running CLI’s release/project root.
- On first write, create it, `lstat` the root, reject a root symlink or non-directory, then `realpath` it and repeat forbidden-root checks.
- Never accept a note path from input. Map fixed kinds to fixed folders and validate IDs as UUIDs.
- `lstat` type directories and entries; never follow symlinked directories/files. Ignore dot directories such as `.obsidian`, temp files, and unrelated root files. Report deterministic warning codes for unsafe/malformed managed entries without including their contents.
- Detect duplicate IDs across kind folders and fail read/update/delete with a conflict rather than guessing.

### 3. Stable search seam
Expose a small backend-neutral interface now while implementing only a Markdown scan:

```ts
export interface MemorySearchBackend {
  search(request: MemorySearchRequest): Promise<MemorySearchResponse>;
}

export interface MemorySearchResult {
  id: string;
  relativePath: string;
  type: MemoryType;
  title: string;
  tags: string[];
  created: string;
  updated: string;
  revision: string;
  snippet: string;
  score: number;
}
```

`MarkdownMemorySearchBackend` scans canonical files on each invocation. A future FTS5 implementation must implement this interface and pass the same parameterized search-contract tests; its database remains derived/disposable outside the vault. Do not create an index in V1.

Search rules:
- Normalize with Unicode NFKC and case-fold; tokenize letters/numbers. No regex or query language.
- Require each query token to occur across title/tags/body; apply documented integer weights (title > tags > body) plus an exact-phrase bonus. Scores are backend-local relevance values, not a durable ranking formula.
- Deterministic order: score descending, `updated` descending, ID ascending. List order: `updated` descending, ID ascending.
- Bound query length (512 characters), request size (~300 KiB), note size (256 KiB), candidate files (10,000), default result count (10), maximum result count (50), and snippets (240 characters). Set `truncated: true` when a bound omits candidates/results.
- Skip malformed/unsafe notes and return sorted `{relativePath, code}` warnings; never emit raw parser/I/O text.

Stable search response example:

```json
{"schemaVersion":1,"ok":true,"data":{"results":[{"id":"2f5f167d-7a18-4457-8de7-f2f801f1e934","relativePath":"preferences/2f5f167d-7a18-4457-8de7-f2f801f1e934.md","type":"preference","title":"Coffee preference","tags":["coffee","food"],"created":"2026-07-19T03:30:00.000Z","updated":"2026-07-19T03:30:00.000Z","revision":"sha256:…","snippet":"Prefers light-roast coffee.","score":23}],"truncated":false,"warnings":[]}}
```

### 4. CLI protocol and skill-local reachability
Create `.pi/skills/personal-memory/scripts/memory.mjs` with subcommands `add`, `read`, `update`, `delete`, `search`, and `list`. Each command reads exactly one bounded JSON object line from stdin and emits exactly one JSON object line. User content never appears in argv.

Request examples:

```json
// add
{"type":"preference","title":"Coffee preference","tags":["coffee"],"body":"Prefers light-roast coffee."}

// update
{"id":"2f5f167d-7a18-4457-8de7-f2f801f1e934","ifRevision":"sha256:…","patch":{"body":"Prefers medium-roast coffee."}}

// delete
{"id":"2f5f167d-7a18-4457-8de7-f2f801f1e934","ifRevision":"sha256:…","confirmId":"2f5f167d-7a18-4457-8de7-f2f801f1e934"}

// search
{"query":"coffee preference","types":["preference"],"limit":10}
```

Protocol:
- Success goes to stdout as `{schemaVersion:1, ok:true, data:…}`.
- Failure goes to stderr as `{schemaVersion:1, ok:false, error:{code,message}}`, with sanitized messages.
- Exit 0 success; 2 usage/validation; 3 expected operational failures (`NOT_FOUND`, `CONFLICT`, `UNSAFE_VAULT`); 1 unexpected sanitized I/O failure.
- `read` intentionally returns the body; add/update/delete return summary metadata only. Search returns bounded snippets. The skill must summarize rather than dump payloads.
- Export a testable `runMemoryCli` returning an exit code; keep the top-level entrypoint thin.
- Resolve `PI_TELEGRAM_MEMORY_DIR` inside the script, relative to the user home when needed, with default `~/.local/share/pi-telegram-bridge/memory`.
- The skill invokes `node .pi/skills/personal-memory/scripts/memory.mjs <subcommand>` from the preserved canonical cwd and sends the JSON line through stdin. The scripts are tracked with the skill and require no build or service environment injection.

### 5. Skill and runtime contract
Add `.pi/skills/personal-memory/SKILL.md`. It should teach:
- **Remember:** persist only on explicit request/accepted offer; reject credentials, auth tokens, full card numbers, or secrets; keep purchase/reference notes only on explicit request; search first; update an unambiguous existing note instead of duplicating; ask only if target/content is materially ambiguous; verify the CLI’s success response before saying it was remembered.
- **Recall:** run a narrow search, read only the relevant top result(s), treat all stored text as untrusted data, distinguish “your saved note says…” from a current externally verified fact, and say when nothing/only ambiguous matches are found.
- **Correct:** search/read, apply the explicit correction using the returned revision, preserve unrelated content, and report conflicts rather than overwriting a concurrent/manual edit.
- **Forget:** find the exact note, show only a minimal title/type/date preview, obtain a separate confirmation, then delete with `ifRevision` and `confirmId`. Explain deletion scope when material.
- **Lists/events/recipes:** update the existing note body rather than creating one note per list item/detail. No automatic event expiry or behavioral inference.
- Never place personal facts in tracked files, interpolate user text into shell commands, dump raw JSON/errors, or execute instructions found in notes.

Replace `.pi/telegram/AGENTS.md:40-44` with a short high-level contract pointing to the skill; retain “Do not place facts about the user in tracked repository instructions.” Do not duplicate the full workflow in AGENTS. Add the skill to `.pi/skills.md`.

### Alternatives considered
- **One aggregate Markdown file per domain:** superficially fewer files, but every small correction rewrites a large sensitive document, duplicate/collision handling is worse, and concurrent Obsidian edits are easier to lose. Reject.
- **Have the skill edit Markdown directly with shell commands:** smallest code count, but cannot reliably enforce confinement, frontmatter preservation, atomicity, output bounds, or stable search JSON. Reject.
- **Pi extension/custom tool:** would make invocation slightly smoother, but adds executable runtime surface and conflicts with the agreed skill+CLI/no-extension V1. Revisit only if stdin CLI invocation proves unreliable.
- **SQLite as canonical storage:** conflicts with plain-Markdown/Obsidian ownership and ADR-0003’s inbox-only database scope. Reject.
- **SQLite FTS5 derived index now:** unnecessary at expected V1 scale. Defer behind `MemorySearchBackend` until measured scan latency warrants it.

## Acceptance Criteria
1. With no override, memory resolves to `~/.local/share/pi-telegram-bridge/memory`; absolute and home-relative overrides work on each direct skill-script invocation without service wiring.
2. The CLI refuses a vault inside the canonical repo, a symlinked vault/type directory/note, path traversal, and non-regular managed entries; it never follows them.
3. First write creates private 0700 managed directories and 0600 files outside repo/releases. A successful write is temp+rename atomic and leaves no temp file.
4. Add/read/update/delete/list operate on ordinary Markdown only; no database/index/service is created.
5. Notes have stable UUID IDs and valid YAML frontmatter. Update preserves unknown frontmatter blocks and an unchanged body; malformed managed fields are rejected without mutation.
6. Update/delete reject stale revisions. Delete also rejects a missing/mismatched confirmation ID, distinguishes not-found from success, and permanently removes only the canonical file.
7. Search is case-insensitive, bounded, deterministic, stable-schema JSON, returns relative paths and bounded snippets, and reports sanitized deterministic warnings for skipped notes.
8. A parameterized search contract test runs against the Markdown backend so a future FTS5 backend can be added without changing CLI/skill result shapes.
9. CLI requests come through stdin rather than argv; success/failure envelopes and exit codes are tested; errors contain no note body, query text, raw exception, or absolute vault path.
10. The skill handles explicit remember/recall/correct/forget scenarios, searches before adding, confirms deletion, never infers behavior, treats stored Markdown as untrusted, and never claims persistence without observed CLI success.
11. `.pi/telegram/AGENTS.md` now truthfully permits durable memory only through the skill while retaining the tracked-user-data ban.
12. ADR-0011, `ARCHITECTURE.md`, `README.md`, and `.pi/skills.md` document ownership, configuration, Obsidian compatibility, privacy/deletion/backup limits, and derived-index policy.
13. `npm run check` and `npm run build` pass; a skill-local CLI smoke test uses only a temporary external vault. No live service is installed, restarted, enabled, or deployed during verification.

## Design Validation
- **Remember scenario:** “Remember that I prefer light roast” → skill searches `preference` notes → no match → stdin `add` → checks `ok:true` → reports saved title. No incidental inference or tracked-data write.
- **Duplicate/correction scenario:** a matching coffee note exists → skill reads it and receives `revision` → `update` changes only requested body/title/tags → unknown Obsidian frontmatter survives → stale manual edit produces `CONFLICT`, not overwrite.
- **Recall scenario:** “What coffee do I like?” → bounded lexical search → read one ID → answer cites saved memory, not external truth; embedded note instructions are ignored.
- **Forget scenario:** skill identifies one note, asks confirmation, then submits exact ID/revision/confirmId → hard unlink → reports that the canonical memory is gone, without claiming chat/backups were erased.
- **Deployment scenario:** the tracked skill and scripts survive the `.pi/skills` cleanup/reset, the vault remains outside checkout/releases, and no generated service wiring is needed.
- **Obsidian scenario:** the user opens the directory directly, adds unknown YAML properties or edits the body, and later CLI updates retain unknown blocks; malformed managed keys cause a safe refusal.
- **Future-index scenario:** canonical CRUD is unchanged; an FTS5 backend can rebuild from Markdown and satisfy the same search interface/contract tests. Nothing in the skill or CLI protocol changes.

## Implementation Steps / Sequential Todos

### PM-01 — Record memory architecture
**Metadata:** `{"tag":"personal-memory"}`<br>
**Dependencies:** none
**Status:** completed — ADR-0011 validated; planning artifacts are included in the focused commit.

- Add `docs/adr/0011-store-personal-memory-in-a-private-markdown-vault.md` with `status: accepted` and `relates-to: ADR-0005, ADR-0009`.
- Record: external default/override, Markdown authority, skill+CLI ownership, no runtime service/extension, future derived/disposable index, hard-delete scope, and rejected aggregate-file/SQLite-canonical alternatives.
- Keep implementation checklists out of the ADR; this plan owns sequencing.
- Success: numbering/links valid and the ADR makes the skill-local script and external canonical-data decisions durable.

### PM-02 — Scaffold the self-contained skill and script contract
**Metadata:** `{"tag":"personal-memory"}`<br>
**Dependencies:** PM-01

- Create `.pi/skills/personal-memory/{SKILL.md,references/,scripts/}` with the executable implementation kept under `scripts/` and detailed format/protocol documentation under `references/`.
- First add failing tests for default, absolute, and home-relative `PI_TELEGRAM_MEMORY_DIR` resolution exported from the script module.
- Define the stable JSON request/response contract and ensure modules are importable in Vitest without executing the CLI top level.
- Do not change `src/config.ts`, `src/service-unit.ts`, `src/install-service.ts`, or package scripts; the tracked skill path is the production execution path.
- Success: path-resolution tests pass and a minimal CLI help/invalid-input invocation runs directly from `.pi/skills/personal-memory/scripts/memory.mjs` without a build.

### PM-03 — Build the safe Markdown repository
**Metadata:** `{"tag":"personal-memory"}`<br>
**Dependencies:** PM-02

- Add failing `tests/memory.test.ts` cases for note creation/round-trip, stable UUID/path, modes, unknown-frontmatter/body preservation, malformed known fields, stale revision, duplicate ID, delete confirmation/not-found, temp cleanup, repo/release confinement, traversal rejection, and symlink/special-file refusal.
- Implement fixed `MemoryType`→folder mapping, canonical frontmatter codec, SHA-256 revision, and safe root discovery in `.pi/skills/personal-memory/scripts/store.mjs`.
- Implement CRUD/list with input bounds and atomic writes. Example API:

```ts
await store.update({
  id,
  ifRevision,
  patch: { body: "Corrected body" },
});
await store.delete({ id, ifRevision, confirmId: id });
```

- Ensure all error objects use stable codes and sanitized messages; do not include content or absolute paths.
- Success: repository tests are green, no `.db` is produced, and failed mutations leave the prior note intact.

### PM-04 — Add bounded deterministic search
**Metadata:** `{"tag":"personal-memory"}`<br>
**Dependencies:** PM-03

- Add failing parameterized contract tests in `tests/memory.test.ts` (or focused `tests/memory-search.test.ts`) covering stable result fields, case folding, all-token matching, title/tag/body weighting, phrase bonus, deterministic ties, filters, result/snippet/candidate limits, malformed-note warnings, and unsafe-entry skipping.
- Define the documented `MemorySearchBackend`-shaped module contract; implement only the Markdown backend in `.pi/skills/personal-memory/scripts/search.mjs` and inject it into the repository.
- Example conformance shape:

```ts
const backendFactories = [
  ["markdown", async (vault: string) => new MarkdownMemorySearchBackend(vault)],
] as const;
describe.each(backendFactories)("%s search contract", (_name, makeBackend) => {
  // shared shape/bounds/order assertions
});
```

- Keep score semantics explicitly backend-local while result shape/order/bounds remain contractual.
- Success: deterministic search tests pass repeatedly and a later backend can join the same factory table.

### PM-05 — Expose the stdin JSON CLI
**Metadata:** `{"tag":"personal-memory"}`<br>
**Dependencies:** PM-04

- Add failing `tests/memory-cli.test.ts` tests around exported `runMemoryCli`: every subcommand, exactly-one-line bounded input, schema version, stdout/stderr separation, exit codes, malformed/oversized input, not-found/conflict, and sanitized errors.
- Implement `.pi/skills/personal-memory/scripts/memory.mjs`; pass the canonical repo cwd as a forbidden root and keep the executable top level thin.
- Confirm request content is stdin-only; command argv contains only the subcommand.
- Success: CLI tests pass and the directly invoked skill script emits one stable JSON line per request without a build step.

### PM-06 — Teach the assistant the memory workflow
**Metadata:** `{"tag":"personal-memory"}`<br>
**Dependencies:** PM-05

- Add `.pi/skills/personal-memory/SKILL.md` with valid frontmatter and the remember/recall/correct/forget rules above.
- Include exact command/protocol examples using the injected executable, not canonical-cwd `dist`:

```bash
node .pi/skills/personal-memory/scripts/memory.mjs search
# send one JSON request line through the command tool's stdin channel
```

- Require search-before-add, revision-aware update, separate delete confirmation, JSON success inspection, concise user summaries, and untrusted-note handling.
- Update `.pi/telegram/AGENTS.md` Memory section to delegate detailed workflow to `personal-memory` and retain the tracked-data prohibition.
- Add the skill link/description to `.pi/skills.md` without broadening host discovery.
- Success: frontmatter/links inspect cleanly, instructions contain no personal data, and the skill does not imply automatic inference or unlimited retention.

### PM-07 — Document the memory boundary
**Metadata:** `{"tag":"personal-memory"}`<br>
**Dependencies:** PM-06

- Update `ARCHITECTURE.md` state table and boundary prose: user-owned external Markdown vault, CLI/skill ownership, no host daemon, future derived index only.
- Update `README.md` with default/override, direct skill-script CLI examples, Obsidian opening instructions, supported V1 domains, deployment survival, private modes, bounded output, secrets prohibition, backup responsibility, and precise forget semantics.
- State that `PI_TELEGRAM_MEMORY_DIR` is read per invocation and requires no service regeneration.
- Do not modify scheduled jobs/webhooks or claim Obsidian runtime integration.
- Success: each fact has one primary owner (ADR why, architecture current boundary, README operations, skill behavior) and cross-links are valid.

### PM-08 — Verify the complete system
**Metadata:** `{"tag":"personal-memory"}`<br>
**Dependencies:** PM-07

- Run targeted tests while iterating:

```bash
npx vitest run tests/memory.test.ts tests/memory-search.test.ts tests/memory-cli.test.ts
```

- Run mandatory checks:

```bash
npm run check
npm run build
```

- Smoke-test the skill-local CLI only against a temporary external vault, with synthetic data:

```bash
vault="$(mktemp -d)"
trap 'rm -rf "$vault"' EXIT
printf '%s\n' '{"type":"preference","title":"Synthetic test","tags":["test"],"body":"Prefers tea."}' \
  | PI_TELEGRAM_MEMORY_DIR="$vault" node .pi/skills/personal-memory/scripts/memory.mjs add
printf '%s\n' '{"query":"tea","limit":5}' \
  | PI_TELEGRAM_MEMORY_DIR="$vault" node .pi/skills/personal-memory/scripts/memory.mjs search
```

- Inspect edited-file diagnostics (`lens_diagnostics mode=all` when available), Markdown links/frontmatter, and `git diff` for accidental personal data or dependency changes.
- Do **not** run `service:install`, restart/enable the live service, or deploy.
- Mark complete only when all tests/build/smoke checks pass.

## Verification
- Minimum implementation evidence is the targeted Vitest suite, full `npm run check`, full `npm run build`, and skill-local CLI smoke test above.
- Explicitly inspect filesystem modes, absence of database/index files, absence of leftover temp files, deterministic repeated search output, and sanitized failures.
- Verify no service-unit, host lifecycle, dependency, or build-output wiring was introduced.
- Verify no test or fixture contains real personal information and no live service operation occurred.

## Premortem
| Likely failure | Early signal | Mitigation in this plan |
| --- | --- | --- |
| Skill works in development but production cannot locate scripts | tracked skill script is absent after deployment | Keep scripts inside the tracked repo-local skill and invoke them from the preserved canonical cwd; verify deployment cleanup behavior. |
| Vault is accidentally placed in repo/release and cleaned or committed | Resolved path begins with cwd/release; `git status` shows notes | External default, lexical + canonical forbidden-root checks, UUID-only paths, deployment docs. |
| Silent duplicate/conflicting memories make recall unreliable | Multiple close search hits for the same person/list/preference | Skill searches before add, updates a clear match, asks when ambiguous; CLI detects duplicate IDs. |
| Obsidian/manual edits are overwritten or corrupted | Revision changed or managed frontmatter no longer parses | SHA-256 `ifRevision`, unknown-block/body preservation, strict refusal on malformed managed fields. |
| Symlink/special-file traversal exposes unrelated home files | A managed directory or `.md` entry is not a regular file | `lstat` every boundary, reject root/type symlinks, never accept paths, realpath confinement, sanitized warning. |
| Personal content leaks through process lists or logs | User text appears in command argv/raw errors | One-line stdin requests, UUID filenames, relative paths, bounded snippets, sanitized errors, concise skill responses. |
| User believes “forget” erases every historical copy | User asks whether Telegram/chat backups are also gone | Hard-delete canonical note, but skill/README explicitly state session/Telegram/filesystem-backup limits. |
| Linear scan becomes slow | Candidate cap/truncation appears or measured latency grows | Deterministic bounds plus `MemorySearchBackend`; add disposable FTS5 only after evidence. |
| Narrow YAML parser mishandles arbitrary manual YAML | Managed key uses unsupported multiline/alias syntax | Canonical JSON-compatible YAML for managed keys, preserve unknown blocks opaquely, reject rather than rewrite malformed managed data. |
| Assistant starts silently profiling the user | Notes appear without an explicit remember request/accepted offer | Explicit-consent rule in both runtime contract and skill; no confidence/inference engine or behavior-derived writes. |

## Risks
- Revision checking narrows but cannot make an atomic compare-and-swap against a simultaneous external Obsidian writer; V1 assumes one CLI writer and relies on a short check/write window. Document this rather than adding locks/event sourcing.
- Hard deletion cannot control Pi session history or external backups. This must remain explicit in user-facing behavior.
- The dependency-free frontmatter parser intentionally supports a canonical managed subset, not full YAML. Safe refusal is preferable to adding a YAML dependency or corrupting manual edits.
- Search quality is lexical only. That is acceptable for the bounded initial domains; embeddings/ontology/confidence are deliberately out of scope.
