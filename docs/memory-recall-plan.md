# Automatic memory recall plan

Status: implemented; see
[ADR-0037](adr/0037-recall-memory-with-jev-before-each-turn.md) and the
[recall setup](search-index.md#automatic-memory-recall). Enabling it requires
`PI_TELEGRAM_MEMORY_RECALL=jev` and a TypeSafe key in the instance environment.

## Approved scope

- Before each qualifying turn, retrieve candidate notes using the incoming
  prompt and recent conversation, ask Jev whether each would change the
  assistant's next response, and add the notes that pass as one session
  message.
- Qualifying turns: Telegram messages, scheduled jobs, and one-time reminders.
  Skip heartbeat reactions, webhooks, and background-subagent completions.
- Go live on Isaac's instance with logging. No shadow period.
- No overall recall deadline yet; keep per-call limits (Jev: one attempt, 3 s).

## Out of scope

- Automatic saving, "remember this?" offers, and pre-save verification.
- Supersession or contradiction suggestions.
- A Jev "is memory needed?" routing gate.
- Recall from session history (notes only).
- Enabling Emma's, household, or engineering instances. Emma opts in herself.
- Threshold tuning beyond the initial defaults, and log rotation.

## Approach as built

Recall lives in the search extension, which already owns the per-instance
search index handle, its shutdown tracking, the principal/view context, and
the refresh, embed, refresh privacy sequence. A separate extension would open
a second handle and duplicate that lifecycle.

- `src/memory-recall.ts`: prompt classification by host-written prefix, the
  conversation window and queries, the Jev question, selection limits, the
  hidden message, the log record, and a fail-open orchestrator. Its
  dependencies are injected, so tests need no network.
- `src/memory-semantic.ts`: `prepareMemoryQueryEmbeddings` embeds up to three
  queries plus up to 30 missing sections in one request.
  `searchHybridMemoriesForQueries` interleaves per-query rankings. Summed rank
  fusion, as first planned, let an uninformative query crowd out another
  query's best match in tests. `visibleMemoryRevisions` supports the
  post-judgment recheck. The single-query tool path is unchanged.
- `src/conversation-text.ts`: text extraction shared with conversation routing.
- `.pi/extensions/search.ts`: the `before_agent_start` hook and fail-closed
  refresh checks. The search tool keeps its own pipeline; the shared part was
  too small to justify changing its behavior.
- `.pi/lib/bridge-runtime.ts`: runtime-marker check shared with core memory.
- `src/credential-environment.ts`: validates `PI_TELEGRAM_MEMORY_RECALL`.
  The extension treats anything other than `jev` as off.
- Docs: ADR-0037, `docs/search-index.md`, `docs/household-fleet.md`,
  `ARCHITECTURE.md`, and `.pi/telegram/AGENTS.md`.

## Acceptance criteria

1. With recall enabled, a turn whose text alone is uninformative ("ok do it")
   after an assistant proposal retrieves candidates using the proposal and
   injects a note that Jev judges relevant.
2. Heartbeat, webhook, subagent-completion, and unrecognized prompts make no
   embedding or Jev call and write no log line.
3. With recall disabled, missing a TypeSafe key, or on any retrieval or judge
   failure, the turn proceeds with no recall message and an unchanged system
   prompt. Failures are logged as failures, never as "no" answers.
4. Only notes visible to the instance's principal/view reach OpenAI, TypeSafe,
   or the message. A note that changes or becomes invisible during judgment is
   not injected.
5. A note ID/revision injected after the latest compaction is not judged or
   injected again; an edited revision or a post-compaction turn may inject it.
6. At most four notes and 2,000 snippet characters are injected, ordered by
   probability, all at or above 0.5.
7. The search tool returns the same results as before for single queries.
8. Each qualifying turn writes one log line with timings and per-candidate
   probabilities and no conversation or note text.
9. Recall messages are not forwarded to Telegram, not indexed by session
   search, and not read by conversation routing (verified by test or smoke
   check against the pinned fork).
10. `npm run check` and `npm run build` pass. Tests use fake embedding and Jev
    responses; no paid calls or live service restarts during tests.

## After launch

After one to two weeks on Isaac's instance, review the log for: p50/p95 added
latency, share of turns injecting anything, notes injected per turn, and a
spot check of injected notes against the session. Use turns where the agent
still called `assistant_memory_search` or where Isaac had to remind it of a
saved fact as missed-recall examples. Then decide on the threshold, the
deadline, and whether to offer recall to Emma's instance.
