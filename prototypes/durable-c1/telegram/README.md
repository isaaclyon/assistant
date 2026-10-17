# C1 Telegram feasibility evidence

Candidate: `isaaclyon/pi-telegram` local branch `prototype/durable-c1`, commit
`b463aec0683969f8c9b6075bb2f258f6ca382c5c`, based on
`dc84d2038ce80d83406f1ea767df2fd99906cc3c`. It is committed locally and has not been
pushed, published, deployed, or substituted into the production dependency lock.

The public `@llblab/pi-telegram/prototype-durable` subpath composes actual fork
preview, final Rich Markdown, section rendering/callback, and singleton-lock
helpers. It imports without node_modules or any legacy runtime. The standard
fork root entrypoint is unchanged. This pilot uses a source candidate, not a
vendored copy or a claimed production migration.

## Reproduce

Use Node 24 and run from the native assistant checkout. The approved worktree
layout defaults to the adjacent repository's `.worktrees/durable-c1`. For another
local checkout of the exact candidate, set `PI_DURABLE_C1_TELEGRAM_SOURCE` to its
absolute path. `candidate.mjs` checks the full HEAD SHA, tracked cleanliness, and
public export before loading it. The candidate is local-only; transfer the
commit through normal Git mechanisms before trying another machine.

```sh
PI_DURABLE_C1_TELEGRAM_SOURCE=/path/to/exact/fork/checkout \
  npx vitest run --config prototypes/durable-c1/vitest.config.ts \
  prototypes/durable-c1/telegram
```

For fork regression tests, provide its development dependencies and run
`TMPDIR=/tmp node --experimental-strip-types --test tests/*.test.ts` on macOS.
The short temporary path avoids Unix socket path-length errors in two unchanged
bus tests. Typecheck uses `tsc --noEmit`; `npm run pack:check` checks packaging.
The native adapter must still import after those legacy dependencies are removed.

## Proven locally

- Actual native `Harness` + explicit `Models`/faux provider + JSONL storage accepts
  synthetic Telegram input, projects committed partial text through actual fork
  Rich Draft rendering, then delivers the exact final answer with thread and
  reply-message scope. Wrong actor and wrong thread are rejected before admission.
- Graceful Harness close, storage reopen, and adapter reconnect preserve the
  conversation id and persisted target/actor/message/attachment metadata. A new
  input reaches the reopened Harness. This is JSONL graceful reopen evidence;
  SQLite crash recovery is covered by the parent pilot, not this test.
- Actual fork section token generation, direct render and callback acknowledgment
  run without invoking the model. Foreign-actor callbacks are rejected.
- Actual filesystem locks reject a separate live Node process. That same process
  exits, with its lock record left unchanged, and reconnect replaces the now-stale
  owner. Release/reconnect also succeeds, using explicit synthetic lock paths.
- A restricted transport failure propagates final-delivery failure without an
  alternate transport. Separately, the real retained `trustedTelegramFetch`,
  `serveTrustedTelegram`, `TrustedTelegramTransport`, and SQLite store run against
  a private temporary synthetic Unix socket and stub upstream. The same client
  fails while the socket is closed, reconnects after broker/store reopen, repeats
  `getMe`, receives the unacknowledged update again, acknowledges it with offset
  8, and subsequently receives no replay. A forbidden `setWebhook` remains denied.
  All upstream data and the token-shaped string are synthetic; no network call
  reaches Telegram. The protocol relies on protected socket permissions and has
  no application authentication handshake. Repeated `getMe` proves identity
  bootstrap, not reauthentication or OS user isolation.
- Synthetic attachment metadata is copied at admission and stored with the native
  user entry across reopen. File download, bytes, model image ingestion, upload,
  and attachment authorization are not implemented here.
- Fork regression verifies an in-flight draft finishes before final delivery and
  no draft-clear request occurs after the final.

- A native conversation-scoped durable document binds the normalized adapter
  input fingerprint to its request ID before submission. After storage reopen,
  changed text or attachment identity under that ID fails before model execution;
  identical input reuses the original submission. The host must still validate
  its complete source envelope before calling this adapter (including instance,
  bot, original timestamp and host attachment authorization). This local guard
  covers only the adapter input fields and is not the host admission protocol.

Validation: native Telegram suite 5/5; fork full suite 1185 passed, 1 platform skip;
fork typecheck and pack dry run passed. Fork test dependencies were supplied by a
temporary symlink to the existing legacy checkout and removed afterward; the
prototype's dependency-free public import was rechecked successfully.

## Deliberate limits

This adapter is opt-in prototype code. It does not implement polling, actual
broker authentication handshake, automatic poller reconnect/backoff or its
acknowledgement ordering against native admission, queue/replacement lifecycle,
durable output receipts,
exactly-once Telegram sends, section-token restart persistence, menus, tools,
voice, household policy, or full extension parity. Native request IDs deduplicate
input after the adapter fingerprint check; a replay can still send the same output twice. Native event projection is
limited to the text-only pilot and does not claim tool/multiblock/resync parity.
An additional authorized live outbound-only smoke passed: a real provider answer
committed in native Harness, the verified fork adapter rendered its exact labeled
text, and Bot API acknowledged one final message to the selected paired private
chat. Identity/destination checks preceded the send. The input was synthetic;
no Telegram update was consumed and no service/poller was changed. Private
scripts and receipts are external evidence. Dedicated live inbound, streamed
preview, callback and Telegram client behavior remain unverified.
