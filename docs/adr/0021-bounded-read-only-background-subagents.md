---
status: accepted
relates-to: ADR-0003, ADR-0007, ADR-0009, ADR-0020
---

# Run bounded read-only subagents as durable background batches

## Context

The main Telegram session needs to delegate independent research without
blocking the conversation or sharing its context window. Pi has no built-in
subagent runtime; its example extension starts child Pi processes, but that
example waits inside one tool call, enables shell-capable agents, and keeps no
restart-safe batch state. Background completion must also return to the exact
Telegram chat/topic that requested it.

## Decision

The host owns a per-instance background-subagent service under
`<stateDir>/subagents/`. A repo-local `background_subagents` tool reaches it
through a token-guarded process-local capability and provides launch, list,
inspect, cancel, and collect operations. Every explicitly listed task starts
concurrently; there is no application concurrency cap. Jobs have isolated Pi
session directories, a fixed 30-minute timeout, 64 KiB partial/final output
limits, and seven-day retention. State transitions are atomically persisted in
a mode-0600 JSON file. Shutdown cancels and awaits all children; startup marks
unobserved running jobs interrupted and never reports them as completed.

Children run the pinned Pi CLI with discovery, built-in tools, skills, and
context files disabled. The only loaded child extension provides dedicated,
bounded repository list/read/literal-search and public HTTP(S) search/retrieval
tools. Repository paths are canonicalized beneath the selected workspace or
immutable resource root; escaping symlinks, special files, oversized files,
private/local network targets, credential-bearing URLs, unrestricted shell,
Telegram, memory, scheduling, and nested delegation are absent. Child prompts
receive only the task and optional explicit context. Child output and remote
content are labeled untrusted and cannot authorize parent actions.

The pinned Telegram dependency receives a version- and source-checked install
patch exposing one bridge-only target scope. Launch captures the active target;
after every job is terminal, the service waits for the parent to become idle,
scopes one internal completion turn to that target, and asks the parent to
collect and synthesize the batch. The completion state is persisted as
`injecting` before prompt injection and `injected` only after the settled turn.
If the process restarts in the middle, the state becomes `uncertain`: it remains
inspectable and is not automatically replayed, preferring no duplicate turn or
Telegram result over claiming an unobserved delivery.

## Consequences

- The active Telegram conversation remains usable while child model calls run.
- Provider and host resource limits, rather than an arbitrary queue cap, govern
  explicitly requested parallelism.
- Read-only is enforced by the child tool surface, not by describing shell use
  as safe.
- Listings omit task text, explicit context, and output; inspection and collect
  return bounded details only when explicitly requested.
- A crash during the small completion-injection window may leave an uncertain,
  inspectable batch without an automatic summary, but cannot duplicate a
  completion turn on restart.
- The pi-telegram version/source patch must be reviewed whenever its pin changes.
