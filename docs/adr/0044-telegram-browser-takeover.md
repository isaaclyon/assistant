---
status: accepted
relates-to: ADR-0025, ADR-0039, ADR-0040
---

# Authenticated browser takeover inside Telegram

## Context

The user asked for a general “take over / hand back” flow inside Telegram, with
1Password passkeys as a later application. The existing SSH/noVNC handoff can
display browser chrome and popups, but requires a terminal and manual password
retrieval. Private form filling cannot handle arbitrary manual browser steps.

## Decision

Add `browser_takeover` to the existing private-input extension and its existing
private personal/builder profiles. Keep the pinned Telegram fork and resource
filter unchanged. The tool accepts only a stock-Chrome session and a clean HTTPS
resume URL. It checks the selected private chat and paired user, holds the
session mutex, persists the existing crash gate, disconnects the normal browser
observer, and requires one unattached HTTPS page on the resume URL's origin.

Reuse the owned x11vnc/websockify supervisor on that browser's private Xvfb
display. Its random VNC password stays in its private runtime file and is read
only by the takeover host. A temporary loopback HTTP/WebSocket gateway runs
behind a foreground, tailnet-only Tailscale Serve mapping on unused port 8447.
The gateway verifies signed, fresh Telegram identity and exact origin/request
binding before returning credentials to the user's Mini App. Nothing is polled
through Telegram and no images, keystrokes or VNC credentials enter Pi.

The pinned noVNC client authenticates the WebSocket using a short-lived,
single-use ticket in its first frame, never a URL. The gateway checks origin and
the ticket before opening the loopback VNC transport. Only one viewer is allowed.
Display frames and keyboard/mouse input travel directly between the authenticated
viewer and VNC. Disable clipboard synchronization, noVNC diagnostic logging,
compression negotiation at the gateway. The takeover code uses no persistent
client storage. Bound
payloads, connections, buffers, authentication deadlines and the whole operation.
Serve only the owned frontend and canonically contained noVNC browser modules.

Disconnecting or closing the Mini App leaves the assistant paused. The user may
reconnect with a new ticket; old tickets cannot reopen the stream. Authenticated
private handback remains available even after the public request budget is
exhausted. Page sharing requires a live authenticated viewer.

Hand back asks the user to choose:

- **Return privately:** revoke viewer access, stop VNC, destroy page documents,
  and reopen the predetermined safe URL. Cookies survive; unsaved page state does
  not. Cancellation, expiry and failures use this same private cleanup.
- **Continue from this page:** explicit consent to let the assistant see the
  current website and form contents. Keep the focused visible HTTPS page (or the
  sole visible HTTPS page), clear its buffered console/log entries, and close
  other pages. Fail closed when the current page is ambiguous or unavailable.

The first choice extends the private-input cleanup guarantee. The second is a
deliberate release of current page contents so CAPTCHA results and other
in-memory workflow state can survive; it does not promise those contents remain
secret from subsequent automation. Neither choice records the user's interaction.

On completion, revoke the viewer before page cleanup and agent resumption. Verify
owned handoff child shutdown and removal of the owned Serve mapping. Preserve
the crash gate on uncertain cleanup and report `browser_blocked`, including when
a new request finds a gate retained from an earlier crash. Never reset other
Serve configuration or silently reopen a protected browser. Expiry is ten minutes;
host/session cancellation also ends the operation. Only a fixed result reaches Pi.

If Serve removal cannot be verified, retain a refusal-only loopback listener
until removal is observed, so a stale mapping cannot expose an unrelated service
that later reuses that ephemeral port. This exceptional cleanup timer is unref'd
and does not keep the host alive; the browser gate remains set for recovery.

## Consequences and limits

- Native-phone Telegram/Tailscale usability requires a user acceptance test.
  Synthetic tests cover signed identity, transport gating, replay, disconnection,
  cancellation/expiry, cleanup order, UI choices and real Chrome/noVNC input.
- The human has broad control of the dedicated browser display. This does not
  grant the assistant permission for subsequent purchases or account changes.
- The takeover capability installs no 1Password account or extension and supplies
  no passkey authenticator. Phone biometrics and cross-device proximity are not
  forwarded. That integration requires its own setup and acceptance test.
- The display fits the viewer automatically; Zoom and Desktop remain available.
  Live viewing depends
  on Tailscale connectivity and the installed x11vnc/websockify/Xvfb tools.
- The current shared page can contain secrets; sharing is a human choice, not an
  automatic model decision. Cancellation cannot undo actions already performed.
- Same-Unix-user and destination-site trust limits from ADR-0040 remain. This is
  cooperative protection against accidental model exposure, not an OS sandbox.
  A host crash closes the gateway; the browser stays gated until stop-only
  recovery. The detached VNC supervisor retains its own bounded expiry.

## Mobile sizing

The first phone acceptance test showed the full 1920×1080 desktop shrinking into
a narrow viewport, with Chrome occupying only part of the image. The authenticated
client now supplies bounded viewport dimensions at connection and on debounced
layout changes, including the on-screen keyboard. A compact toolbar preserves
room for the browser and keeps handback visible.

The protected host sizes the original Chrome window at the display origin,
compensates its minimum native width with a page-only CDP geometry override, and
clips the owned private x11vnc framebuffer to the window. It retains a private
page session for these fixed geometry methods; no DOM, frames, input, console or
network observations are enabled for resizing. The browser identity remains
desktop Chrome. The user may explicitly choose a full Desktop view for wider
sites, extension UI or additional windows.

Entry still requires all prior debugger sessions to be disconnected. The sizing
contract assumes ordinary stock-Chrome geometry; preserving custom pre-existing
device emulation is unsupported. After explicit shared handback, the existing
cleanup flow checks page visibility/focus to select the shared page, as described
above. That consented cleanup is separate from the geometry-only resize path.

Only paired-user authenticated requests can resize. Updates require the current
consumed viewer ticket and an open stream. Validate an exact width/height/mode
shape, limit dimensions to the stock display, serialize changes, and retain the
existing request budget. The helper verifies the owned private supervisor and
x11vnc process before issuing one fixed, bounded clip command through a random,
per-supervisor X property. Both process identity and the property binding are
verified, so another x11vnc on the same display does not receive the command.
No arbitrary remote-control command or executable is client-selected.

Handback/cancellation immediately revoke the stream and await the active geometry
operation before cleanup. Clear the page override and restore original bounds
when its tab survives. Select the user's shared page before restoring geometry,
since restoring a window can change focus; foreground the selected page and
discard buffered console activity afterward. Failures in that cleanup retain
the existing crash gate.
Tests cover authentication and bounds, resize/handback races, actual mobile
framebuffer rendering, keyboard-height changes, desktop fallback and shared-page
state restoration. Native Telegram keyboard behavior still needs phone acceptance.
