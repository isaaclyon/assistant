# Take over a browser inside Telegram

`browser_takeover` opens an authenticated, live view of the selected stock-Chrome
session inside a private Telegram Mini App. The active agent turn waits while
the user controls the browser, then continues after handback and cleanup.

## Agent workflow

1. Use the stock helper to start a dedicated session and navigate to the requested
   HTTPS website. Begin with one tab and no other debugger attached.
2. Choose a clean HTTPS `resumeUrl` on the same origin, without query or fragment.
   Prefer a public home/account landing page that can be reopened after login.
3. Tell the user to keep Tailscale connected, tap **Take over**, complete the
   manual step, and tap **Hand back**. Call the tool with `session` and `resumeUrl`.
4. Wait. Do not run other tools, inspect the display/profile/runtime, read the VNC
   password, or bypass the session gate with raw CDP.
5. After the tool returns, verify the resulting website state. A handback status
   means the user returned control; it does not prove a login or other task succeeded.
6. Stop the stock browser when the overall task is complete.

## Phone controls

The view automatically fits the space inside Telegram, including changes when
the keyboard opens or the phone rotates. The page uses the viewer's CSS width,
so responsive sites can display their narrow-screen layout. The host sizes the
Chrome window and streams only that part of its private display. Chrome's
minimum native window width is compensated inside the page so text retains its
intended size on the phone. Browser controls and extension UI remain available.

Use **Desktop** for a wider layout or a popup that extends beyond the fitted
view, then **Fit view** to return. This is desktop Chrome with a responsive page
viewport; sites that require a mobile-specific browser identity may still show
their desktop experience. Extra windows are available in Desktop view.

Tap the remote field before opening **Keyboard**. **Tab** and **Enter** act on the
remote browser; those buttons appear while the keyboard is open. **Hide keys**
closes the keyboard. Drag with two fingers to scroll the webpage. **Zoom** gives a larger view with drag-to-pan; **Fit** shows the
whole display. Closing the Mini App does not hand control back. Reopen/reconnect,
or let the bounded session expire.

**Hand back** offers two choices:

- **Return privately** reopens `resumeUrl` and destroys previous page documents.
  Browser cookies remain, but open tabs and unsaved page changes are discarded.
- **Continue from this page** keeps the current website and its in-page state.
  The user explicitly agrees that the assistant can see the page and form
  contents. This choice requires a live viewer. Close extra windows if the
  selected page would otherwise be ambiguous.

The Mini App closes automatically after a confirmed handback. If a client cannot
close itself, it leaves a completion message. A disconnected viewer keeps the
agent paused and offers reconnect/private handback.

Handback waits for any active resize, clears the page size override and restores
the original window bounds when the original tab still exists. Page sharing
preserves entered state across those geometry changes.

## Availability and recovery

- Available through the existing private-input extension in personal and builder
  profiles, not the household group profile.
- Requires stock Chrome/Xvfb, x11vnc, websockify, Tailscale connectivity, and the
  existing noninteractive permission to launch foreground Tailscale Serve.
- Uses unused HTTPS port **8447**. It refuses an existing mapping or Funnel grant;
  it never overwrites another mapping or exposes CDP.
- Returns only `handed_back` with `private`/`share`, `cancelled`, `expired`,
  `failed`, `unavailable`, or `browser_blocked`.
- On `browser_blocked`, stop the browser with the stock helper before reopening.
  Never delete its gate. If cleanup involved a stuck handoff/proxy, inspect only
  the owned helper status and dedicated Serve mapping; never reset all Serve
  configuration. Uncertain process identity requires operator inspection.
- Existing SSH handoff remains available when Telegram/Tailscale viewing cannot
  be used. Never expose its raw noVNC listener directly.

## Passkeys

The viewer can show browser UI and extension prompts. It does not install,
configure or unlock 1Password, supply a passkey, or forward phone biometrics.
Start with the general takeover acceptance test; add and test an appropriately
scoped 1Password browser setup separately.

See [ADR-0044](adr/0044-telegram-browser-takeover.md) for the transport and privacy
boundaries, including the explicit difference between private and shared handback.
