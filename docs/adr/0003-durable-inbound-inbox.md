---
status: accepted
relates-to: ADR-0002
---

# Durable inbound-turn inbox

## Context

`pi-telegram` keeps accepted prompt turns in an in-memory queue and advances the Telegram `lastUpdateId` offset as soon as a turn is accepted — before it is dispatched to Pi. A host crash or restart while turns are queued drops them, and the advanced offset means Telegram will not redeliver. For a tool whose promise is "message the assistant and trust it runs," that at-most-once behavior is the one load-bearing reliability gap.

Inbound turns bypass this host entirely (`pi-telegram` calls `api.sendUserMessage()` straight into Pi), and there is no public `pi-telegram` API to re-inject a stored turn into its queue. So capture and replay must happen inside the fork, where the crash window lives, while the durable store itself belongs to this host.

## Decision

Add a durable inbound inbox with an inbox-only scope. The store is a single SQLite table (`node:sqlite`, no new dependency) at `<stateDir>/inbox.db`, owned by this host (`src/inbox.ts`): `persist` on accept, `remove` on handoff to Pi, `loadPending` on startup, keyed by a stable per-turn identity (`chatId:minSourceMessageId`) for idempotency against redelivery and replay.

The fork gains a second narrow process-local capability under ADR-0002's discipline — `registerTelegramInboundInbox` — mirroring `registerTelegramHostNewSession`. As with that capability, the host and fork rendezvous on a shared `globalThis` symbol registry rather than importing across the boundary (the compiled host cannot type-strip the source-only fork under `node_modules`): the host binds via `src/telegram-inbox-capability.ts`, the fork reads via `getTelegramInboundInbox`. The fork wraps its in-memory queue store so that every mutation reconciles the durable inbox to exactly the queued prompt turns (persist before the offset advances, remove once dispatched to Pi), and replays pending turns into the queue once on process start. No changes to the queue engine itself. The host passes only the `persist`/`remove`/`loadPending` view; database lifecycle (`close`) stays host-side. Binding is inert against a fork build that does not read the registry, so the two repositories can be re-pinned independently.

A durable *outbound* reply store is deliberately excluded as YAGNI: a failed send leaves the answer in Pi's persistent session, and the user can re-ask. Revisit only if outbound send failures become an observed problem for the 1-2 users sharing this assistant.

## Consequences

- Accepted Telegram turns survive a host crash/restart with at-least-once execution; redelivery and replay are idempotent via `update_id`.
- A turn already handed to Pi is owned by Pi's own session persistence; the inbox only defends the accept→dispatch window.
- The fork now carries two narrow capabilities, so dependency updates require rebasing both and re-pinning a new full commit SHA (ADR-0002 rebase cost, extended).
- A residual micro-window remains: removal happens when `sendUserMessage` resolves, assuming Pi persists the user entry first. Tightening would move removal to that turn's agent-lifecycle callback; not warranted at this scale.
