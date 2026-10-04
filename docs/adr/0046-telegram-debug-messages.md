---
status: accepted
relates-to: ADR-0002, ADR-0007, ADR-0037
---

# Opt-in Telegram debug messages

`/debug` toggles diagnostics for the authorized source chat and topic. Explicit
`on`, `off`, and `status` arguments are supported. State lives in the instance
process, survives session replacement and extension reload, and resets on restart.
Every profile selects the extension; debug starts off.

A version- and source-checked install patch adds the authorized source target
to command contexts and binds a narrow plain-text transport using the fork's
existing active-turn target and API sender. No tokens enter diagnostics. Each
notification captures its destination before queuing; there is no fallback to
another chat. This follows the existing source-checked patch approach while
keeping the fork pinned.

The extension observes tool execution start/end and agent start/settled. Memory
extensions report core injection, date context, recall decisions (including
failures), and recalled context through the same process-local helper. These
messages are transport-only: they never enter model context or session history.
Private-input arguments/results and known credential-bearing calls are omitted.
Common structured and textual secret formats are redacted, binary data omitted,
and each message capped at 3,400 characters. Free-form secrets cannot be
identified exhaustively; this is a diagnostic view of the current conversation.

Delivery is ordered per destination, fail-open, and capped at 128 pending
messages. Disabling invalidates queued sends; an in-flight send may complete.
`/debug status` reports dropped messages and failed sends. Debug messages use
plain text, so tool output cannot create buttons, voice actions, or formatting.
Outbound diagnostics share Telegram's non-durable delivery limitation.
