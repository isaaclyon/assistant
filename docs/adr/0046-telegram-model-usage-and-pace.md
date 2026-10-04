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
