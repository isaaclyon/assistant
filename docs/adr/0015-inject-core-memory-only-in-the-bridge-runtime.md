---
status: accepted
relates-to: ADR-0009, ADR-0011, ADR-0014
supersedes-in-part: ADR-0014
---

# Inject core memory only in the bridge runtime

## Context

ADR-0014 deliberately stopped at deterministic compilation. Project-local
extensions are also discovered by ordinary Pi sessions in this repository, so
loading an injection extension alone would expose personal core memory outside
the always-on Telegram runtime. Compiling only at session start would leave
memory stale after an edit.

## Decision

The host binds a token-guarded process-local runtime marker for its lifetime. A
repo-local `before_agent_start` extension checks that marker, compiles the vault
through ADR-0014's existing renderer using the host-bound instance principal
and memory view, and appends the exact projection to the
chained system prompt on every agent start. With no marker or no selected core,
the extension is a no-op.

Do not cache the projection, write a generated file, or persist it as a session
message. If compilation fails, let Pi log the extension error and continue the
turn without core memory; the compiler never returns a partial projection.

## Considered Options

- **Inject through Telegram instructions:** rejected because generated personal
  data would become stale tracked instruction content.
- **Persist a custom session message:** rejected because it would duplicate
  sensitive derived state and become stale across edits and session branches.
- **Compile once at session start:** rejected because memory changes should take
  effect on the next agent start without a reload.
- **Use an environment flag:** rejected because the existing token-guarded
  process-local capability pattern has explicit bind and unbind lifetimes.

## Consequences

- Ordinary Pi sessions can load the extension but do not receive core memory.
- Isaac, Emma, and Shared Bot receive independently filtered core projections;
  Builder's `none` view compiles an empty projection.
- Each agent start pays one bounded vault scan of at most 1,000 notes and 16 MiB.
- Invalid core cannot block unrelated assistant work, but it is absent until the
  vault is repaired; the process log records the extension failure.
