---
status: accepted
relates-to: ADR-0020, ADR-0024, ADR-0025, ADR-0039
---

# Submit private browser input through an authenticated Telegram form

## Context

The paired user verified the dummy Mini App on their phone over Tailscale. Real
input also needs a private fill path and protection against later page reads,
screenshots, and automation caches revealing values. A form alone is insufficient.

## Decision

Provide `private_browser_input` in private personal and builder profiles. The
active tool waits for up to ten minutes and returns only a closed status value,
letting the same turn resume without a second prompt. Bind the recipient to both
the active Telegram target and the selected profile's paired user. Household
group usage remains unsupported. Session shutdown and tool cancellation abort
pending input and await cleanup.

Use the already-tested narrow Bot API sender to deliver an authenticated Mini
App button for this operation; this does not register menus, callbacks, or an
update poller and needs no new pi-telegram fork API. Secrets travel directly from
same-origin HTTPS POST to a private, in-process CDP connection. Never pass values
through tool parameters/results, process arguments, files, or diagnostics.
Validate Telegram HMAC/freshness/user, origin, opaque request identity, field
shapes, body bounds, and single consumption before touching the browser.

Stock-Chrome runs now use a stable per-instance/session agent-browser daemon and
hold the lifecycle mutex for the whole command. Protected input holds that same
mutex across its entire operation, writes a private crash-persistent gate, and
disconnects the normal daemon before accepting values. Preparation requires one
HTTPS page, no attached debugger, and a same-origin POST form. An isolated Chrome
world captures exact document/field/button objects and form destination/method,
including submit-button overrides; revalidate immediately before each fill and
submission. Values enter only `HTMLInputElement` fields. No frame traversal,
arbitrary JavaScript, or secret-bearing protocol diagnostics are exposed.

After an attempted fill, close all page targets in this dedicated browser and
create a clean page at the explicit same-origin `resumeUrl` (no query/fragment).
This discards response documents which might echo a password or code, and avoids
reconnecting the normal daemon to secret-bearing DOM or captured console/network
events. Submission is not proof of successful authentication; the resumed agent
must verify the safe page. Pending cancellation leaves the unmodified page intact.
If sensitive-document cleanup fails, retain the gate; only stopping that browser
can clear it. Never silently expire a crash gate and resume page reads.

The Mini App uses foreground tailnet-only Serve on unused port 8446. A separate
private mutex serializes this endpoint across instances. Reject existing mappings
and Funnel grants. Close the HTTP server and owned Serve process on completion,
cancellation, startup failure, or expiry. Protect interactive SSH handoff startup
with the same browser mutex so it cannot race protected input.

## Consequences

ADR-0041 adds one closed OpenTable adapter for an embedded, multi-step login.
The restrictions below continue to apply to the generic form tool.

- This first version supports ordinary top-level POST sign-in/verification forms.
  JavaScript-only forms, passkeys, CAPTCHA, embedded fields, multi-tab flows, and
  challenges that cannot survive reopening need the existing SSH handoff.
- Restarting at `resumeUrl` preserves profile cookies but discards in-page state.
  The status is `submitted`, not “logged in”; failed or slow sign-ins may require
  a fresh request. No submission is automatically retried.
- The private input operation holds an agent turn open. Competing ordinary browser
  commands fail busy rather than inspecting the protected page. New tool calls in
  this extension runtime are blocked while input is active.
- The gate is cooperative protection against accidental model exposure. Code with
  the same Unix permissions can bypass it, inspect memory, or access raw CDP;
  hostile same-user isolation is not claimed. The destination website necessarily
  receives the values. JavaScript strings cannot be reliably zeroized in memory.
- Older default agent-browser daemons may still be attached after upgrading.
  Preparation fails closed; stop/reopen that dedicated browser and re-inspect the
  form. Never kill an unrelated daemon or clear the gate manually.
