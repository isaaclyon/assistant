---
status: accepted
supersedes: ADR-0001
---

# Pin a pi-telegram fork for host session actions

## Context

Telegram update handlers receive ordinary Pi `ExtensionContext`, so upstream `pi-telegram` cannot request the official session-replacement lifecycle used by `/new`. Command-context support in this host proves `AgentSessionRuntime.newSession()` is safe, but it does not bridge asynchronous Telegram handlers.

## Decision

Pin `@llblab/pi-telegram` to a full `isaaclyon/pi-telegram` commit through an integrity-locked GitHub tarball. The fork adds one process-local host capability, `registerTelegramHostNewSession`, and Telegram `/new` delegates through that capability to this host's `AgentSessionRuntime.newSession()`. The host exposes no other runtime internals. The fork must remain a narrow patch, preserve upstream package naming for compatibility, and be rebased or removed when upstream provides an equivalent supported API.

The pinned fork also consumes a narrow host-owned household policy: one exact
group chat ID and two exact Telegram user IDs mapped to stable actor labels. It
authorizes targets and actors before durable inbox persistence or Pi delivery,
retains attribution through replay/grouping, and leaves classic private mode
unchanged. Household `/new` uses a Telegram-owned callback namespace and an
authorized inline confirmation; readiness is checked again before replacement.

## Consequences

- Telegram can start a fresh Pi session in the same thread through Pi's official shutdown/rebind/start path.
- Busy, queued, compacting, or concurrent replacement states are rejected rather than losing in-memory work.
- Dependency updates now require rebasing the fork, rerunning both repositories' test suites, and pinning a new full commit SHA.
- Group/supergroup ID changes fail closed until the private manifest is updated;
  tokens and raw identity configuration never enter fork diagnostics.
- TTY injection, stale command contexts, session-file mutation, shadow Pi processes, and exposing the full host runtime remain prohibited.
