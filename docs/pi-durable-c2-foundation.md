# C2 native runtime foundation

Status: **C2 passed; go to C3.** Native implementation, local integration
validation and independent review are complete. Production remains on the legacy
release. This guide records the completed C2 checkpoint; the
[C3 guide](pi-durable-c3-chat-memory.md) records the subsequent implementation
and its completed dedicated live user checkpoint.

Code paths below belong to the isolated `feat/durable-c2` release tree. The legacy
checkout retains this guide as checkpoint evidence.

## Ownership and packaging

`src/durable/application.ts` composes the native host, provider, selected resources,
ordinary operation task and Telegram adapter. `daemon.ts` owns process signals,
readiness and bounded exit; `config.ts` requires explicit native instance selection.
The native package has its own exact 1.3.0 SDK tree, lockfile, strict TypeScript
build and tests. No production module imports a C1 probe or coding-agent runtime.
Legacy source remains available for domain reuse and comparison, outside the
native entrypoint. The separate legacy checkout keeps its existing package,
patches, build and deployment path.

| Owner | Responsibility |
| --- | --- |
| `storage.ts` | Exclusive OS writer lease, WAL/FULL Harness and front-buffer inbox, verified close |
| `host.ts`, `ingress.ts` | Source/epoch binding, policy, admission receipts, controls, shutdown and compatibility preflight |
| `delivery.ts`, `recovery.ts` | Authoritative settlement scans, stable segments, send receipts, uncertain outcomes and failed-run queue advancement |
| `provider.ts` | Explicit account/settings, catalog/thinking checks and shared Pi-auth refresh locking |
| `registry.ts` | Canonical selection before import, native contributions, handler signatures and cleanup |
| `transport.ts` | Pinned fork ownership/rendering, ordinary offsets, restricted broker reconnect and acknowledgement |
| `telegram-bridge.ts` | Authenticated private text normalization and exact destination checks |
| `operations.ts` | Ordinary approval and mutation records, atomic task admission, current authority and receipt reconciliation |

The C1 ingress/delivery/operation helper implementations remain disposable
prototype evidence. Their public-API techniques were reimplemented in strict
TypeScript with these lifecycle owners. The fork's prototype entrypoint is also
excluded from production imports; its new compiled `./durable` surface supplies
native-safe primitives.

The new `durable-foundation-test` profile intentionally selects no domain tools,
skills, schedules, browser or general shell/file/web capabilities. Its explicit
instructions describe that limited surface. C3 adds the already-approved
`durable-chat-memory-test` profile and its seven bundles; the foundation profile
is retained separately.

## Private instance configuration

Create a separate private state directory and workspace. Keep instance data and
provider/Telegram credentials outside the release. The configuration file must
be owned by the runtime identity with mode `0600`; the state directory must be
private. Its paths are explicit and canonicalized. Native state cannot overlap
the release or workspace. For example, this synthetic shape selects the trusted
broker transport:

```json
{
  "version": 1,
  "runtime": "pi-durable",
  "instanceId": "native-test",
  "principal": "isaac",
  "releaseSha": "0000000000000000000000000000000000000000",
  "resourceRoot": "/srv/native-test-release",
  "workspaceCwd": "/srv/native-test-workspace",
  "stateDir": "/srv/private/native-test-state",
  "capabilityProfile": "durable-foundation-test",
  "account": "native-test-account",
  "credentialPath": "/srv/private/agent/auth.json",
  "settingsPath": "/srv/private/native-test-provider.json",
  "jobsRole": "disabled",
  "idleHours": 0,
  "transport": {
    "mode": "broker",
    "socketPath": "/srv/private/broker/runtime.sock",
    "botId": 123,
    "allowedUserId": 456
  }
}
```

Use the actual reviewed release SHA. Ordinary mode instead has `mode: ordinary`,
`profile`, `configPath`, `locksPath`, `botId` and `allowedUserId`. Those paths name
the existing private Telegram configuration and polling locks; the token is not
included in native configuration. Both modes verify bot identity. Ordinary outbound requests also recheck current
pairing and token identity before sending. The foundation
surface accepts only the paired user's private ungrouped text. Edited messages
are ignored; unsupported media is rejected before admission with a best-effort notice.
Rejected updates advance the transport offset so later text remains usable. Full grouping,
media and household routing remain later parity gates.

Provider settings are a separate private file:

```json
{
  "version": 1,
  "account": "native-test-account",
  "provider": "openai",
  "modelId": "gpt-4.1-nano",
  "thinkingLevel": "off"
}
```

Supported factories are `openai`, `openai-codex` and `anthropic`; the selected
model and thinking level must exist in that provider's catalog. Provider settings
may include an ordered `modelIds` array to register only the chosen chat models
and show only those choices in the model picker. It must be nonempty, contain
unique known IDs and include `modelId`. Omit it to keep the provider's full
catalog. A persisted model choice removed from the selected catalog blocks
startup; it is preserved for explicit reconciliation and never silently falls
back to the default. Model choices belong in private instance settings.
The `account` label binds settings to the configured credential scope; in `pi-auth` format,
the explicit path and OS access are the account boundary. It does not prove a
remote account identity. Credentials use the existing Pi file shape and are not
copied at startup. The native adapter requires an owned, private, regular file;
shared cross-UID ACL files and symlink credential paths are not accepted by this
entrypoint. Isolated deployments retain their own private credential file.

Pi-auth writes coordinate through the legacy proper-lockfile protocol with a
five-second heartbeat, preserving unrelated provider records. Publication is an
atomic replacement with mode `0600` and fsync. Remote refresh success followed
by loss of its local credential commit still requires account reconciliation.
The optional native-envelope store uses a fail-closed lock whose abandoned
owner requires explicit inspection. No ambient environment key is a fallback.

For an explicitly configured dedicated test instance, build and run with:

```sh
npm ci
npm run check:changed
npm run build
PI_DURABLE_CONFIG=/absolute/private/native-instance.json \
PI_TELEGRAM_BRIDGE_RELEASE_SHA=<reviewed-full-sha> npm start
```

The daemon verifies the entrypoint's release root, changes to the configured
workspace, and writes existing instance/SHA/PID readiness metadata. It does not
install or start a systemd service. C6 owns the mixed-release installer and
Linux/systemd rehearsal; C7 owns production activation. This branch's GitHub
workflow runs validation only, including manual dispatch; it has no production
deployment job. Native runtime upgrades
receive manual weekly review alongside the default branch's grouped legacy PRs.

## Recovery and control behavior

- `durable/harness.db` owns native execution and host documents;
  `durable/writer.lock.db` enforces one writer; `inbox.db` remains the accepted
  input front buffer. Historical `sessions/` is untouched.
- Source acknowledgement follows source binding and inbox persistence. Admission
  uses public `Conversation.submit()` with a stable request ID, then records the
  receipt and removes the inbox row. A retry preserves source time, destination
  and conversation even after rotation.
- Normal input is one-at-a-time follow-up. A failed run receives a target-scoped
  failure notice and an idempotent empty-model control write advances queued
  input. That execution metadata is not a user-history source.
- `/abort` cancels captured active work while preserving queued input. `/stop`
  captures and withdraws queued work too. `/new` rejects incompatible busy states,
  changes epoch once and invalidates ordinary pending approvals. Duplicate
  controls retain their original work targets. A busy `/new` rejection is persisted,
  so replay cannot rotate the conversation after the busy work finishes.
  `/compact` uses native compaction;
  an interrupted uncertain control is not blindly repeated.
- Optional idle rotation uses original human timestamps and a serialized epoch
  update. A restart preserves the current epoch and unexpired ordinary approval;
  it does not extend authorization. Domain reload/reset invalidation is exposed
  by the operation API for C3 controls.
- Final delivery uses committed settlements, independently of preview listeners.
  Each bounded UTF-16 segment has a stable identity and receipt. Missing send
  acknowledgement remains uncertain. A lost receipt is not proof of non-delivery.
- Startup checks compatibility, selected definitions and current source/control
  authority before scheduling. An incompatible registry/profile blocks recovery;
  do not edit stored metadata to bypass it. Close timeout retains the writer lease
  until the process exits. The daemon bounds shutdown at ten seconds.

Stop the writer before inspecting its store. With the same private configuration:

```sh
PI_DURABLE_CONFIG=/absolute/private/native-instance.json npm run inspect
```

The inspector does not resume tasks or start polling. It reports pending input,
blocked/live task states and uncertain delivery identities without printing
prompts or tool payloads. The operation API separately exposes handler/version
and interrupted/uncertain mutation records for C3's operator UI. Missing or
incompatible executors never authorize an automatic repeat. Keep the matching
code/state checkpoint; do not rewind accepted work or open native stores with
the legacy binary.

## Validation and limits

A clean `npm ci --ignore-scripts` passed with the published full-SHA fork pin.
After the final review fixes, `npm run check:changed` passed all 75 tests in ten
files, and `npm run build` passed, including importing the compiled application.
Independent authority and runtime reviews found no remaining C2 blockers after
fixes for uncertain mutation outcomes, refresh-lock timing, duplicate tasks,
rejected-update replay and outbound pairing checks.

The native suite covers source deduplication/reopen, exclusive writer recovery,
control correlation/cancellation, failed-run queue advancement, per-segment
uncertain sends, both transport modes, provider refresh locking, registry
isolation and ordinary mutation authority. Subprocess tests use real SIGKILL at
admission and mutation receipt boundaries and noncooperative tools for fatal
storage and control deadlines. The ordinary refresh test holds the lock for
eleven seconds while a separate legacy-protocol process attempts acquisition.

The fork's clean install, typecheck, deterministic compiled API build, full suite
(1,188 passed, one platform skip), and package dry-run passed. The production
adapter is pinned to `56f0fe38d2260db8dede028aca62d47cbb49bb20`. Its generated
ESM and declarations import no legacy SDK. The native dependency test requires
one exact 1.3.0 generation and excludes coding-agent, agent-core and TUI. The
legacy checkout's changed-file checks and build also passed. Production native
dependencies have no reported audit vulnerabilities at this checkpoint; the
inherited development test-runner tree has advisories requiring a separate
reviewed upgrade.

Ten exploratory local samples measured compiled application construction through
fake-transport readiness at p50 2.93 ms / p95 7.40 ms, and durable input acceptance
through fake final delivery/reconciliation at p50 3.65 ms / p95 8.67 ms. These are
below C0's investigation budgets. The foundation profile is smaller than the
legacy full host, and the delivery boundary includes more than C0's fake-provider
turn, so these numbers establish local overhead rather than a production speedup.
Provider setup, network time, systemd readiness and memory operations are excluded.

Ten stores each completed 31 synthetic turns, with close/reopen after turns 11
and 21. A representative closed store grew from 159,744 to 200,704 to 225,280
bytes; each later ten-turn increment was smaller. Open totals include several
megabytes of reusable WAL pages. No superlinear retained growth appeared in this
short workload. Long-history retention remains a later workload gate. Raw
measurements and scripts stay in private temporary evidence outside the repo.

Synthetic tests use disposable stores and provider/transport fixtures. Production provider factories are installed, but
real OAuth refresh, Codex/Anthropic wire parity, full Telegram UI and target
Linux/systemd behavior remain their later recorded gates. C2 does not start a
live service or migrate canonical private data. Revocation after an outbound
request has begun cannot recall that external effect; the check protects the
pre-send boundary. Foundation controls use exact command text; bot-qualified
forms such as `/new@botname` remain part of C6 Telegram parity.

C3 subsequently implemented the approved chat-and-memory profile, canonical
Markdown/Git execution, direct confirmations and scoped history/recall. Its
[guide](pi-durable-c3-chat-memory.md) records validation and remaining acceptance.
The foundation profile alone is not the chat-and-memory MVP.

See [ADR-0052](adr/0052-native-durable-runtime-foundation.md),
[the roadmap](pi-durable-migration-plan.md), and
[the C0 contracts](pi-durable-c0-contracts.md).
