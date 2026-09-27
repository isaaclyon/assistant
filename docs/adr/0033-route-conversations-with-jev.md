---
status: accepted
relates-to: ADR-0002, ADR-0022, ADR-0031
supersedes-in-part: ADR-0022
---

# Route conversations with Jev after a short human-idle gap

## Decision

An instance explicitly enables `PI_TELEGRAM_SESSION_ROUTING=jev`. After more
than 15 minutes since its last accepted human message, the host asks one Noul:
does the incoming message continue the existing conversation? State includes
the first Telegram user message in the current Pi branch, its last two visible
user/assistant messages, and the incoming text. Each text is capped at 4,096
characters. The full branch retains the original message across compaction.
Tools, thinking, summaries, image data, attachment paths, and handler metadata
are excluded. Missing history or incoming text preserves the current session.

Use the existing TypeSafe client and mode-0600 key file with the pinned
`jev-1.13.0` model. One attempt has a three-second HTTP timeout. A probability
below 0.3 starts a new Pi session; 0.3 and above keeps the current session.
Errors preserve context and log only a fixed diagnostic. These thresholds are
initial defaults, not calibrated accuracy guarantees.

The fork's optional preparation input now includes bounded prompt text and the
original Telegram message timestamp. The timestamp persists in the inbox and
prevents queue wait time from creating artificial idle gaps. Older queued turns
without a timestamp use preparation time; out-of-order timestamps never move
the human clock backward. When first enabled without saved policy state, the
host adopts the latest persisted Telegram user-message time as its baseline.
Exactly 15 minutes stays in-session. Preparation still
retains the complete queued turn through official session replacement, and the
existing pending-replacement record recovers a failed final state write.

In Jev mode, scheduled jobs and background completions neither classify nor
rotate history. This mode takes precedence over the old idle-hours policy:
otherwise a job could destroy continuity before the next human message is
classified. `/new` keeps its manual behavior. Instances without the opt-in keep
the existing idle-hours behavior.

## Consequences

Conversation excerpts leave the machine for TypeSafe only for opted-in
instances. Configuring a key for semantic heartbeats alone does not enable this
feature. No conversation content or credential is written to routing logs.
Historical sessions remain intact; a fresh session receives the unchanged
incoming turn without copying prior context. Provider failure favors continuity.

References: [Noul](https://docs.typesafe.ai/primitives/noul) and
[HTTP API](https://docs.typesafe.ai/api).
