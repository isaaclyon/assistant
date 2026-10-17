# C0 deterministic baseline (prototype only)

Claim: the legacy production APIs can execute a repeatable, synthetic offline
workload and expose per-phase timing distributions and file-byte growth. This
probe supplies local evidence; it does not establish the entire C0 checkpoint.
Retain as prototype-only comparison evidence, outside production integration.
Complexity budget: one probe and one host fixture; runtime budget: 180 seconds.

From the repository root, create a private external directory, choose a **new**
absolute output filename, and run (use the same Node/platform for comparisons):

```sh
DURABLE_BASELINE_OUTPUT=/absolute/private/baseline.json \
node_modules/.bin/vitest run --config prototypes/durable-baseline/vitest.config.ts
```

Select Node 24 and Bash 5 on `PATH` for the recorded baseline environment; child processes inherit that path. Use a command runner timeout of 180 seconds. Type-check the probe with `node_modules/.bin/tsc -p prototypes/durable-baseline/tsconfig.json`. The output file is exclusively
created with mode 0600; the parent directory must already exist outside the
checkout. No evidence file is written inside the repository. `.probe.ts` is not
selected by ordinary Vitest test discovery; this explicit config enables it.
The disposable fixture directory is removed even on failure.

## Exact workload

All timings use `performance.now()`, with raw samples, count, min, nearest-rank
p50/p95 and max in milliseconds. There are 10 samples per phase, no discarded
warmup and no acceptance thresholds. Module import/collection time is excluded;
the first sample can include lazy initialization. Report process/platform and
Node alongside the output; machine load and filesystem caching affect results.

- **Host readiness:** 10 fresh synthetic roots; time `startBridgeHost()` until
  it returns, asserting the session is idle. Empty selected capability profile,
  synthetic instruction file, synthetic unexpired OAuth fixture and fixed
  model setting. Standard host provider/web extensions still load. Jobs are
  disabled. This is in-process readiness with warm module caches, not process
  launch, Telegram polling readiness or deployment readiness.
- **Ordinary turn:** one fixed Telegram-labelled prompt per fresh host through
  the real session; injected stream returns `SYNTHETIC_FINAL` immediately with
  one done event and fixed usage/timestamp. Wait for idle and assert the answer.
  No tool, retry, real token streaming, model or network latency is included.
- **Memory:** seed 20 real Markdown preference notes, one marked `#core`.
  Each of 10 iterations creates one additional note, reads it, appends a detail,
  and deletes it through the application's synthetic bound confirmation.
  Create includes draft creation; duplicate lookup returns an injected empty
  result. Read includes the production usage log. Delete includes local
  confirmation setup/consumption, not Telegram presentation. Git is disabled
  by the normal fixture configuration.
- **Core:** compile the 20-note vault using the production compiler; assert
  the core note appears. Extension/debug publication is excluded.
- **Search:** build the real SQLite FTS index once over the 20 notes, then
  time the same `coffee` query with a result limit of 10. Index construction,
  refresh and semantic embedding/network latency are excluded.
- **Recall:** run the production recall orchestration on one fixed incoming
  prompt and empty history with one injected candidate, fixed revision map,
  immediate deterministic judge probabilities and no-op logging. This measures
  preparation/orchestration, not retrieval, Jev, embedding, log I/O or the
  integrated enabled recall feature.
- **Inbox replay:** each of 10 fresh inboxes persists 100 ordered JSON payloads,
  closes, then times reopen/load/assert/remove/close. This is graceful SQLite
  restart replay and cleanup, not a process kill or host replay-to-model.
- **Growth:** logical recursive file sizes before/after each one-turn host
  (while open), the 20-note vault before/after 10 CRUD cycles, and each inbox
  before enqueue versus after replay and close. Open SQLite WAL files may be
  included in directory totals; closed inbox sizes reflect checkpointing.
  These are finite-workload byte observations, not disk allocation, steady-state
  growth rates, whole-service storage, retention or power-loss guarantees.

`fetch` is replaced with a throwing implementation throughout the probe. No
Telegram transport is selected; all model calls use the injected stream. The
probe never reads configured personal roots or real credentials. This guard
covers fetch-based calls; it is not an OS network sandbox.

## Interpretation and limits

Compare the same workload and injected responses on the native pilot before
setting regression budgets. Do not equate an immediate fake provider to real
provider latency or count missing enabled-feature authorization as passing.
This probe does not cover actual Telegram, live providers, Jev/semantic services,
real-browser integration, Linux/systemd readiness, cold process startup,
power-loss recovery or native behavior. The parent C0 work owns full correctness
checks and build; these measurements do not replace them.
