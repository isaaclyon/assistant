# C1 native feasibility pilot — prototype only

**Status: offline probes pass; C1 acceptance is held for live evidence.**

Claim: pi-durable 1.3.0 can support the approved input, recovery, approval,
provider and Telegram boundaries through public APIs and a focused fork adapter.
The minimum evidence is the bounded synthetic probe set from
[`docs/pi-durable-c0-contracts.md`](../../docs/pi-durable-c0-contracts.md#evidence-required-before-checkpoint-acceptance).
The prototype consists of four probe areas and one experimental fork subpath;
combined checks have a 180-second command budget. Retain these artifacts as
prototype-only evidence. Production integration requires the later checkpoints.

This branch has a separate root manifest, lockfile and installed dependency tree.
`pi-durable`, `pi-ai`, `chord` and `pi-codemode` are exactly 1.3.0. No coding-agent
SDK is installed or loaded. Codemode is a package dependency, not an exposed
capability. The retained legacy `src/` tree is not a functioning native host;
only the small shared modules named by tests execute.

## Reproduce

Use Node 24 and Bash 5. Place a clean local Telegram fork checkout at the exact
candidate below, or set `PI_DURABLE_C1_TELEGRAM_SOURCE` to it. The verifier rejects
wrong HEADs, tracked changes and an unexpected public subpath. See the
[Telegram README](telegram/README.md) for default checkout discovery.

```sh
npm ci --no-audit --no-fund
npm run check:changed
npm run build
```

Run each command with a finite timeout of at most 180 seconds. Native
`check:changed` deliberately runs the complete **prototype** typecheck/test suite;
it does not run the retained legacy host suite. The build emits test/fixture
artifacts, not a deployable service. Test state is synthetic and removed. Tests
neither inspect ambient credentials nor contact a live provider/Bot API. Broker
coverage opens an owned temporary Unix socket with synthetic upstream responses.

## Evidence

Final combined gate: **60 tests in seven files**, strict TypeScript test checking,
and build passed on Node 24/macOS. JavaScript helpers use `checkJs: false`; their
behavior is tested, not fully statically checked.

| Area | Evidence | Limits |
| --- | --- | --- |
| [Core](core/README.md) | 24 upstream SQLite conformance cases; WAL/FULL every open; actual SIGKILL at admission/result barriers; source and attachment replay; FIFO/control races; blocked definition recovery; fatal storage fail-closed and bounded forced exit; durable answer discovery/delivery policy; scoped old/new locator resolution; pre-import profile filtering; disposable child process/store | Synthetic protocols and send receipts; selected crash windows; no complete host, poller, history index or C5 retention subsystem |
| [Effects](effects/README.md) | Native ToolTask reopens after external mutation+receipt commit but before tool-result commit; one effect; missing receipt stays uncertain; persisted authenticated approval decision and replay/expiry/epoch/revision rejection | Synthetic external atomic receipt store and callback authentication; not arbitrary exactly-once effects or live Telegram confirmations |
| [Provider](provider/README.md) | Shared-store refresh coordination; thinking/catalog validation; actual Responses request serialization; streamed response and durable transient retry/final settlement | Injected fetch and synthetic OAuth; no real account exchange, cross-process credential lock or upstream request |
| [Telegram](telegram/README.md) | Real fork preview/final/sections/locks driven by Harness; durable input fingerprint; attachment replay; actual live-owner exit/reconnect; retained trusted IPC/client/store socket reopen, update replay and offset acknowledgement | No live Bot API, automatic fork polling recovery or broker-ack/native-admission integration; text-only native projection, metadata-only attachments |

Telegram base: `dc84d2038ce80d83406f1ea767df2fd99906cc3c`.
Local candidate: **`b463aec0683969f8c9b6075bb2f258f6ca382c5c`** on the fork's
`prototype/durable-c1` branch. Its full suite passed 1,185 tests with one platform
skip; typecheck and package dry-run passed. Full tests used `TMPDIR=/tmp` to avoid
macOS Unix socket path-length limits. A temporary legacy dependency symlink was
used only for the fork's separate legacy validation process, removed afterward,
and dependency-free prototype-subpath import passed again. The native tests use
the SHA-verified source subpath. C2 must turn the candidate into a proper pinned
package/release dependency; this local experiment is not packaged for deployment.

An independent read-only review found missing discovery, replay/reconnect,
concurrent queue and locator assertions. Focused corrections added those cases.
The new identical-source replay test also caught a native transaction-document
proxy being passed to `structuredClone`; the helper now projects its plain record.

## Important findings and remaining gates

- Native Responses sends positional developer messages and instruction-section
  patches, retaining the earlier prefix. The legacy Codex fixture collapses
  instructions. Decide and test the desired native behavior explicitly during
  provider parity work; do not claim equivalent wire serialization.
- Harness's curated stream options do not expose the existing service-tier and
  reasoning-summary controls. A supported provider wrapper may supply them after
  the C4 decision; this pilot does not implement those controls.
- The broker protocol authorizes access through its protected socket. Repeating
  `getMe` after reconnect is identity bootstrap, not an application-level
  reauthentication handshake.
- C1 still requires one authorized real provider request and a dedicated test bot
  and chat. Select isolated credential/configuration sources outside the repo;
  record live evidence separately. This prototype never starts a production
  service, polling loop or deployment.
- Full host integration, automatic poller recovery/backoff, current authorization
  on every recovery, complete callback/media/menu parity, Linux/systemd and the
  C2–C7 gates remain future work. Offline results alone do not accept C1 or
  authorize rollout.
