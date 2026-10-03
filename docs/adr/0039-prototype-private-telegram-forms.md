---
status: accepted
relates-to: ADR-0024, ADR-0025, ADR-0028
---

# Prototype private forms inside Telegram with dummy data

## Context

Browser authentication needs a convenient input surface on the user's phone.
Before building protected browser filling, verify that a Telegram Mini App can
reach tailnet-only HTTPS and authenticate the paired user on the actual device.
The existing webhook injects request bodies into Pi and cannot handle this data.
The pinned Telegram section keyboard types currently support callback buttons
only; a full interactive capability would require a reviewed fork API change.

## Decision

Add an operator-launched, fifteen-minute prototype, separate from bridge polling
and the Pi runtime. Its narrow Bot API sender posts one `web_app` button to the
selected instance's paired private chat and edits that message with a fixed
completion, cancellation, or expiry notice. The prototype never polls updates,
changes bot menus, or handles real credentials. It uses the existing private
instance manifest and reads only the selected Telegram profile server-side.

A foreground Tailscale Serve child forwards an unused HTTPS port to a dynamically
allocated loopback HTTP listener. Startup rejects occupied ports and Funnel
grants in both background and foreground configuration. It verifies the exact
private proxy and HTTPS health before sending the button. Shutdown closes the
local server, terminates only the owned Serve child, and checks removal. Other
Serve mappings are never overwritten. No public ingress is added.

The web form posts directly to its own origin. The server verifies Telegram's
HMAC over raw `initData`, a bounded `auth_date`, the exact paired user, and a
random per-launch request ID. Duplicate fields, cross-origin requests, unknown
JSON fields, oversized payloads, stale requests, and repeated consumption fail
closed. Static assets and responses use no-store and a restrictive CSP. The
frontend submits only the literal sample code `123456`; arbitrary input fails
both client-side and server-side checks. Only a closed terminal-status enum
leaves the handler. The server does not store or log bodies or launch data.

## Consequences

- The prototype is shipped through normal repository deployment but is started
  explicitly; it does not add an always-on server or restart the live bridge.
- Private-chat Mini App buttons need no group launch or persistent menu changes.
  Phone/Tailscale compatibility remains a real-device acceptance check.
- Restarting invalidates pending requests. Responses and Telegram notifications
  are not durable; reopening an unexpired form can show its terminal status.
- Tailnet clients can exhaust the small global request budget; this is an
  availability limitation of a temporary single-user prototype.
- This proves launch, identity validation, and dummy submission only. It does
  not establish secret isolation, protected browser filling, passkey support,
  group routing, or automated agent resumption. Those need separate work before
  accepting privileged information. Same-user processes remain outside the
  security boundary, consistent with ADR-0020.
