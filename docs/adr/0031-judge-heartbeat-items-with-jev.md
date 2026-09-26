---
status: accepted
relates-to: ADR-0019, ADR-0020
supersedes-in-part: ADR-0019
---

# Judge new heartbeat items with Jev yes/no questions

## Context

ADR-0019 limits host-evaluated heartbeat rules to exact structural change and a
sustained numeric condition. Many useful watches are fuzzy: "the landlord replied
with an inspection date" or "the venue announced Saturday tickets". Today the only
way to express them is a cron prompt that runs a full agent turn on every check,
which is expensive at a 15-minute cadence and fills the chat session with no-op
turns.

TypeSafe's Jev model answers typed yes/no questions (Nouls) over supplied state
for about $0.042 per million input tokens with sub-second latency. It is weaker at
arithmetic, date ordering, and adversarial text, and it cannot explain itself.

## Decision

Add a third heartbeat rule, `semantic-match`.

- The checker emits `value.items`: at most 50 JSON objects with unique string
  `id`s, still within the 4 KB observation limit.
- The first successful observation is a silent baseline. Later observations send
  only items whose IDs were absent from the previous observation. No new items
  means no model call, and no new state is stored beyond the latest observation.
- New items go to Jev in one request, one Noul per item. The job's `question` must
  contain `{item}`, which the host replaces with that item's state path
  (`` `items[0]` ``). `criteria.true`/`criteria.false` and an optional `context`
  (placed in state as `watch.context`) come from the job. Items with P(yes) at or
  above `notifyAt` become one pending event carrying the items, rounded
  probabilities, and the resolved model version.
- A judge failure (missing key, HTTP error after bounded 429/529 retries,
  timeout, or malformed answer) is an operational failure, never a "no". The host
  records `lastFailureAt` and keeps the previous observation so the same items are
  judged again on the next run.
- The model ID is pinned in code (`jev-1.13.0`) so tuned thresholds do not move
  with the `jev-latest` alias. Rule changes reset the baseline through the
  existing configuration fingerprint.
- The reaction is still only an agent prompt. The agent re-reads the evidence and
  treats item content as untrusted, so the strong model is the second check on
  every Jev match.
- The API key lives in a mode-`0600` file named by the operational key
  `PI_TELEGRAM_TYPESAFE_API_KEY_FILE` in the jobs coordinator's instance
  environment. The host reads it just in time for each request.

## Considered options

- **Cron prompts to the main agent:** rejected for frequent watches because each
  check costs a full agent turn and pollutes the session.
- **Let checkers call Jev themselves:** rejected because checkers are stateless
  and would each reimplement item diffing, failure semantics, and key handling.
- **One Choice over all items:** rejected because several items can match at once
  and Choice probabilities compete; a Noul per item keeps inclusion independent.
- **A generic LLM call in the host:** rejected for now; Jev's typed probabilities
  fit a threshold rule directly and cost far less per check.

## Consequences

- Item text leaves the machine for TypeSafe. Zero data retention is offered only
  to enterprise customers; the TypeSafe Data Processing Agreement otherwise
  governs retention. Each household member should opt in before a watch sends
  their private data (for example, an inbox checker).
- Jev can be steered by adversarial item text. The blast radius is one extra
  agent turn, which already treats event data as untrusted.
- Thresholds are placeholders until tuned on labeled items. Misses are the costly
  error; false wakes cost one agent turn.
- A recurring judge outage delays notification rather than dropping it, but a new
  item that disappears from the checker's list before the judge recovers is never
  judged.
