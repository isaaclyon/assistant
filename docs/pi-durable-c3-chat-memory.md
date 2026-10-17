# C3 native chat and memory

Status: **implemented; dedicated live user checkpoint pending.** The isolated
`feat/durable-c3` tree extends C2's native foundation. Local validation and review
are recorded below. Production continues using its legacy release. C3 acceptance
requires the separate test-bot try specified by the roadmap. Commands and source
paths below belong to the native tree; the legacy checkout retains this guide as
checkpoint evidence.

## Selected surface

`durable-chat-memory-test` selects seven native bundles: core-memory, search,
memory, reload, restart, skills and debug. Its five model tools are
`assistant_memory`, `assistant_memory_search`, `assistant_session_search`,
`session_context` and `search_index`. It loads the personal-memory skill and
profile-specific instructions after canonical release-path validation.

Private ungrouped text, visible assistant previews, durable final delivery and
user-only buttons use the pinned fork's compiled native transport. `/menu`,
`/model`, `/thinking`, `/new`, `/abort`, `/stop`, `/compact`, `/reload`, `/restart`,
`/skills` and `/debug` run outside the model loop. Model/thinking choices persist
and configure future epochs. Reload requires idle execution and a compatible
selected registry; it expires pending memory drafts and confirmations. Restart
preserves unexpired pending requests and requests shutdown after durable offset
acknowledgement. A replay cannot request a second shutdown on reopening.

Debug is opt-in and process-local. Its bounded, redacted messages report visible
tool activity, lifecycle and core/date/recall diagnostics into the private target.
Thinking and raw tool payloads are excluded. Previews are best effort; rapid
queued turns can lose a preview when an earlier final flushes. Committed final
answers and their delivery receipts remain authoritative.

General shell/file/web tools, external integrations, media/group routing,
schedules and children retain their later C4–C6 gates.

## Configuration and operation

Use the [C2 configuration and launch procedure](pi-durable-c2-foundation.md),
select `durable-chat-memory-test`, and add the following synthetic configuration:

```json
{
  "memory": {
    "vaultRoot": "/srv/private/native-test-memory",
    "gitAutocommit": false,
    "legacySessionRoots": ["/srv/private/native-test-archive"],
    "timeZone": "America/New_York",
    "recall": "jev",
    "semantic": "on",
    "judgeKeyFile": "/srv/private/native-test-keys/typesafe",
    "embeddingKeyFile": "/srv/private/native-test-keys/openai"
  }
}
```

Enabled recall and semantic search require explicit key-file references. These
map to the existing domain feature flags; session routing stays off. Off variants
use `recall: off` and `semantic: off` and need no service keys. Credentials,
instance identities and task fixtures belong outside the repository. The vault
must be outside both release and workspace, including through symlink aliases.
Native configuration participates in startup compatibility checks.

Keep a separate test bot, ordinary Telegram configuration/locks, provider store,
state, workspace and vault. The normal daemon owns a single native writer and
poller. `/restart` exits with code 75; a dedicated supervisor must reopen the same
configuration. This branch supplies validation-only CI and does not activate a
production service.

Stop the runtime before native inspection. The normal private configuration
selects the same principal-scoped history resolver used by search:

```sh
PI_DURABLE_CONFIG=/absolute/private/native-instance.json npm run inspect
PI_DURABLE_CONFIG=/absolute/private/native-instance.json npm run inspect -- --lint-memory
```

The lint form uses canonical memory validation with native and configured legacy
source resolution. It opens the exclusive native writer lease without starting
scheduling or polling. The standalone legacy memory CLI remains a JSONL archive
reader; use native inspection to validate native citations.

## State and recovery

| Owner | Responsibility |
| --- | --- |
| `memory.ts`, `memory-drafts.ts` | Typed interface, durable duplicate-review drafts and authenticated confirmation decisions |
| `memory-executor.ts`, shared Markdown store | Fixed effect plans, vault lock, exact revisions and private operation receipts |
| `operations.ts`, `authority.ts` | Atomic approval/task admission, current epoch/principal/target authority and conservative reconciliation |
| `search.ts`, `history*.ts` | Derived indexes, scoped native/legacy evidence and stable source resolution |
| `context.ts`, `core-memory.ts`, `date.ts`, `recall.ts` | Request-only context, original-event dates, recall/proposals and retained-context deduplication |
| `controls.ts`, `telegram-ui.ts`, `visible-events.ts` | Persistent control receipts, direct UI and visible-only previews |

The trusted preparer fixes note UUID, timestamps, action payload and exact
pre/post revisions once. The canonical executor checks that plan under the
mutation lock and fsyncs an operation receipt before replacing Markdown. Append
and create retries join the same operation. Missing receipts, changed notes and
unprovable outcomes stay uncertain. Delete checks the revision again immediately
before unlink. Receipt paths, enums and symlinks are validated on recovery.
Operation IDs must be globally unique within a vault; receipt files remain as
deduplication evidence.

Optional local Git completion is a separate effect, recognized by its operation
trailer. An unknown Git outcome cannot authorize another Markdown mutation.
Unrelated staged work blocks a new effect; inspect interrupted staging and Git
outcomes before continuing. The mixed memory tool stays replay-unsafe; its
separate native operation task owns effect recovery.

Delete and household sharing require exact actor, principal, private chat,
message, epoch, expiry and revision authority. Telegram carries only an opaque
operation handle. Consumed operations do not rerun when response rendering fails.
New/reset/reload expire pending drafts and approvals; ordinary restart retains
their original expiry.

Hidden date/recall text and core context are stored in a conversation document
and injected only into provider requests. They never become transcript entries.
Deduplication follows the retained context: compaction or a fresh conversation
can recall a note again, while restart retains the current turn's context.
Shared semantic retrieval refreshes and revalidates visibility around embedding;
usage/decay and proposals retain the existing domain rules. Proposals do not
authorize saving.

Native evidence uses `durable.v1` locators containing instance, persistent store
identity and conversation, plus exact entry ID and timestamp. Configured archived
JSONL retains its original anchors. Search, context expansion and lint share
visibility checks. System prompts, hidden context, thinking, controls, compaction
summaries and protected tool output are excluded. Large session refreshes are
bounded; results report partial status until later refreshes converge.

## Validation and remaining acceptance

The native suite exercises the real selected profile, actual serialized tool
schemas, canonical Markdown CRUD/append, draft reuse, persisted share/delete
buttons, wrong-user/message/replayed callbacks, reload, restart acknowledgement,
scoped history and provenance lint/rebuild. Subprocess SIGKILL tests cover lost
results after Markdown replacement and independent Git completion. Real domain
recall/index tests cover usage/decay, freshness and visibility changes during
embedding. Actual native compaction/new/reopen tests verify hidden-context and
recall deduplication behavior.

A clean `npm ci --ignore-scripts --no-audit --no-fund`, `npm run check:changed`
and `npm run build` passed; the final schema fix also passed `check:changed` and build: 251 tests in 29 files, including 81 shared canonical
memory/CLI/provenance tests now included in the normal native gate. The build
imports the compiled application and includes its selected Markdown assets.
Independent memory and context/UI reviews found no critical or high findings.
The medium memory findings and restart/reload lifecycle findings were fixed.

Ten exploratory local samples of the compiled full profile, with recall and
semantic services off, measured startup p50 3.64 ms / p95 54.66 ms and durable
acceptance through fake final delivery p50 4.40 ms / p95 22.79 ms. The first store
accounted for the turn outlier; the remaining nine first turns took 3.30–6.27 ms.
That outlier exceeds C0's narrower fake-turn investigation budget. C3 includes
request context and final receipt/reconciliation, so it is not an equivalent
phase or a production latency claim. Network/auth setup is excluded. Ten stores
each completed 31 turns with two close/reopens; representative closed storage
was 225,280, 266,240 and 299,008 bytes at turns 11, 21 and 31. This short workload
showed no superlinear retained growth; long-history/platform evidence remains a
later gate. Raw scripts and measurements stay in private temporary evidence.

A separate real-service smoke used the compiled native application, a disposable
fictional note and programmatic input with a fake Telegram transport. OpenAI
`gpt-4.1-mini` completed a real tool-assisted turn and returned the seeded fact;
embedding requests returned HTTP 200 and hybrid retrieval reported semantic ready.
That check exposed OpenAI's prohibition on top-level union function schemas. The
memory wire schema now has a flat object root, with exact action validation before
any domain call; malformed branch arguments are regression-tested without effects.

The configured Jev service returned HTTP 401. Enabled recall acceptance is blocked
until valid private authorization is supplied; the successful provider diagnostic
used recall off and makes no automatic-recall acceptance claim. No interactive C3
poller started. The bounded dedicated fixture and restart supervisor are prepared
outside the repository; private credential copies are retired while awaiting input.

The pending dedicated checkpoint must use Jev recall and semantic search enabled,
exercise chat/save/recall/edit and direct confirmation across restart, and record
the user's feedback and any gaps. Offline fixtures cannot establish user
usefulness. Linux/systemd, full provider parity and staged production activation
remain C4–C7 work.

See [ADR-0053](adr/0053-native-chat-memory-and-evidence.md),
[the roadmap](pi-durable-migration-plan.md), and
[the C0 MVP contract](pi-durable-c0-contracts.md#d3-a-narrowly-selected-chat-and-memory-mvp).
