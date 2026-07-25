---
status: accepted
relates-to: ADR-0020, ADR-0024
---

# Temporary SSH-tunneled browser handoff

## Context

Some browser actions require secrets or human presence that must not pass
through Telegram, model context, logs, or process arguments: passkeys, TOTP,
payment details, CAPTCHA, push approvals, and unusual security challenges. CDP
cannot be exposed because it grants nearly complete control of the persistent
browser profile. A permanently listening remote desktop would create a similar
unnecessary attack surface.

## Decision

Add a tracked handoff supervisor that attaches x11vnc to the exact Xvfb display
of an already-running stock-Chrome session. Bind x11vnc and noVNC/websockify only
to independently allocated loopback ports. Require a random eight-character VNC
password stored in a mode-`0600` runtime file; never put it in process arguments,
agent output, or Telegram. The user retrieves it directly through their existing
SSH-authenticated terminal and forwards only the noVNC loopback port over SSH.

Handoffs last ten minutes by default and at most thirty under normal process
operation. The supervisor removes its state, log, and password on explicit stop,
child failure, or expiry. State
records the supervisor identity, and cleanup verifies its command line before
signaling a process group so stale PID reuse cannot kill an unrelated process.
Do not expose or tunnel CDP. Pause agent automation for the entire handoff and
resume only after the user finishes and the helper stops.

## Consequences

- Human-only authentication and payment steps can occur in the same persistent
  Chrome profile without their secrets entering model-visible channels.
- SSH authentication and VNC authentication are both required; HTTP/WebSocket
  traffic is unencrypted only inside the user's SSH tunnel endpoints.
- The browser display gives broad control over the active profile, so handoffs
  remain explicit, brief, single-viewer sessions rather than a background
  service.
- The boundary remains same-Unix-user semantic isolation as described by
  ADR-0020; a process already running as that user is outside the threat model.
  Such a process could suspend both the supervisor and its timer, so expiry is
  not a security boundary against a same-user adversary.
