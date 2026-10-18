---
status: accepted
relates-to: ADR-0004, ADR-0020
---

# Telegram active-model usage and pace

Expose `/usage` in every capability profile through the reload-safe Telegram
command registry. A read-only process-local host capability resolves a fresh
official Pi extension context on each call, using the current model and its
registered provider authentication. The extension receives only formatted text;
it never receives the runtime, credentials, or raw provider response.

Reuse the pinned Codex conversion dependency's usage client and normalized
payload. Each invocation fetches fresh subscription usage under a ten-second
deadline and uses the active Pi account, without reading another process's
credentials or polling history. Unsupported models and unavailable data produce
explicit messages. Requests never redeem resets or invoke the model.

Show the shared Codex allowance and any additional limit whose ID or name
matches the active model. Additional unrelated limits are omitted. Percentages
are subscription allowances, not token/context percentages. Shared usage also
includes other clients on the same account.

Even pace compares allowance remaining with the fraction of the window's time
remaining, deriving its start from the reported reset time and duration. Higher
allowance remaining means usage is under pace; lower means over pace. Missing,
expired, or inconsistent window metadata suppresses pace. This is an even-use
target, not a forecast. Nothing persists across sessions; host disposal removes
the capability, and every request resolves the current session again.

## Native migration implementation

`durable-provider-test` binds the direct `/usage` command to `provider-usage.ts`.
The native service resolves the selected registered model and its explicit
Codex OAuth account through `Models`; it imports no coding-agent wrapper. The
fixed ChatGPT `/backend-api/wham/usage` read and normalized fields follow the
pinned legacy client's contract. A ten-second deadline covers selection, auth,
fetch and body consumption; a 256 KiB body limit and redirect rejection bound
the response. Late responses and aborted body reads are cancelled.

Only formatted shared Codex and matching active-model allowance windows leave
the service. It rechecks the selected model before returning. Other provider/API
combinations, including the native OpenAI provider, return an explicit unsupported
message. API-key accounts are unsupported. Failures return a fixed unavailable
message. Nothing is polled or persisted; usage remains an on-demand read. Live
provider compatibility remains a later acceptance gate.
