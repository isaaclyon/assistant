# C1 external-effect and approval recovery probes

Prototype only. `runtime.mjs` owns a synthetic domain executor and approval adapter;
`worker.mjs` provides the separate process; `effects.test.ts` supervises it.
No production code, real provider, Telegram transport, credential, or live service is used.

## Tested facts (Node 24.18.1, native packages 1.3.0)

- Native SQLite opens through public `openNodeSqliteDatabase` and
  `SqliteStorage.open`; every open verifies WAL and synchronous FULL.
- A real native `ToolTask` records its execute checkpoint, calls the fixture,
  commits an external counter increment, then signals an IPC barrier **before
  returning or committing its native result**. The supervisor sends SIGKILL,
  joins the child, and reopens the same native store.
- Before scheduling recovery the test verifies the persisted execute checkpoint,
  operation/task identities, executing operation record, and absent tool result.
  Recovery reruns the replay-safe tool, recognizes the external receipt, settles
  the native task as completed and appends exactly one result. The counter stays
  at one, including a second native reopen.
- The independent external SQLite fixture atomically stores the counter change
  and its operation-ID/fingerprint receipt. It is **not** the native database.
  In the intentionally missing-receipt variant, the mutation still happens once;
  recovery reports `uncertain` and does not repeat it or claim verified success.
- A separate process persists an approval and closes. A new runtime accepts the
  same-epoch callback, atomically consumes it with native tool-task creation,
  and completes one external mutation. Wrong actor/chat and replay after another
  restart fail. Separate persisted cases reject expired (exact TTL boundary),
  rotated epoch, revoked, stale revision, wrong version, and unpresented approvals.
- Every child has a bounded crash barrier or exit timer. Teardown kills and joins
  surviving children before removing disposable synthetic databases.

## Limits

The tool is driven with the public `AssistantEntry`, `Tx.createTask(ToolTask,…)`
and native scheduler APIs. This isolates tool recovery; model generation,
`Conversation.submit` admission and Telegram dispatch are other pilot probes.
No private native tables are read or edited.

`replay: "safe"` only permits native reexecution. The domain receipt and conservative
uncertain policy supply effect reconciliation; Harness does not make an arbitrary
external operation exactly once. The fixture's atomic receipt is stronger than
many remote APIs. There is no host/power-loss claim, no real Markdown mutation or
Calendar reconciliation, and no cross-process concurrent executor proof.

The callback is a prototype adapter function, not a Telegram callback listener.
Its actor/chat arguments stand for an already authenticated transport identity.
Approval revision and version are synthetic expected values; real domain preflight
and authenticated ingress remain integration work. These probes cover ordinary
approval persistence and consumption; broker credential approvals remain separate.
The JavaScript worker is runtime-tested; scoped TypeScript checks cover the test
and imported declarations with `checkJs: false`, matching the pilot config.

## Focused validation

From the native checkout with Node 24 first on PATH:

```sh
node node_modules/vitest/vitest.mjs run --config prototypes/durable-c1/vitest.config.ts prototypes/durable-c1/effects/effects.test.ts
node node_modules/typescript/bin/tsc --noEmit --strict --allowJs --checkJs false --skipLibCheck --target ES2023 --module NodeNext --moduleResolution NodeNext prototypes/durable-c1/effects/effects.test.ts
```

Nine focused tests pass. The parent owns whole-pilot checks and checkpoint acceptance.
