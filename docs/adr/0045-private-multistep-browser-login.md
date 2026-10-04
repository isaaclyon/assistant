# ADR-0045: Keep general multi-step sign-in inside the protected takeover owner

Status: Accepted

## Context

The generic single-form tool destroys its document after submission. This loses
the transient state used by email → password → verification flows. OpenTable has
a closed adapter, but adding a separate owner and transport for every website
would duplicate the sensitive lifecycle. The deployed takeover already owns a
bounded protected Chrome session with authenticated mobile interaction.

## Decision

Expose `private_browser_login` through the existing private-input extension and
its existing personal/builder profile selection. Reuse takeover's mutex,
observer disconnect, durable gate, authenticated HTTPS gateway, deadline,
viewer, cleanup and quarantine. Do not change the pinned Telegram fork or loosen
resource filtering. The single-form and closed OpenTable tools retain their
existing behavior.

A separate private CDP client evaluates a fixed recognizer in an isolated world.
It returns field kinds and a bound object, never page text or values to Pi.
Recognition requires a top-level HTTPS POST form, clear existing sign-in
semantics, an unambiguous submit control, and a recognized same-origin login or
verification action path. A narrow Amazon US identifier exception covers its
inspected combined heading and `/ax/claim` action. Unknown semantics route to
human takeover. These checks reduce accidental misclassification; they do not
make a compromised destination trustworthy.

Bind the document URL, form/action/method/target, button identity/label/overrides,
input identity and semantics, headings and form text, and the complete ordered
set of associated controls, including hidden challenge fields and controls
outside the form. Reject external associated controls initially. Recheck before
each fill and click. Allow the selected submit button to become enabled in
response to input. Never retry a submission; each field kind can appear only
once and transitions progress toward verification. Permit at most eight seconds
for a recognized next screen; ambiguity becomes manual control.

Authenticated `/api/auth` initially returns only fixed field metadata and a
random step nonce. `/api/login` consumes and rotates that nonce synchronously,
serializes submissions, and clears private values afterward. Saved lookup is
an explicit Mini App choice; the existing provider gains an optional exact-origin
policy for this flow. It runs under the owning instance's configured credential
scope, uses stdin for its request and bounded private stdout, and returns no
fields through the model tool or Mini App. Manual username entry must match the
saved item before later saved-password use. General codes remain manual;
OpenTable's sender-specific mail adapter is unchanged.
The credential worker has its own process group; cancellation, timeout and
completion kill remaining descendants before the private lookup settles.
Password-only entrypoints have no bound identifier and use manual input or
takeover; they cannot implicitly choose the saved item's account.

An explicit authenticated takeover request must carry the current step nonce.
It closes the private recognizer before issuing viewer credentials. The crash
gate and browser documents remain in place; automated filling cannot restart.
Normal private/shared handback choices then apply. No input, frames, console,
mail content or credentials enter the model through this operation.

Cancellation, expiry and completion close the private recognizer, abort saved
lookup and wait for outstanding private work alongside resize work. Only then
may existing teardown release the browser. Private cleanup reopens the clean
resume page; explicit user-consented sharing preserves the chosen page. A
positive sign-out control with no remaining input/frame can finish automation,
but the assistant must independently verify authentication afterward. Uncertain
cleanup retains the gate and returns `browser_blocked`.

## Consequences and validation

Common multi-screen forms no longer require intermediate browser cleanup.
Fallback preserves transient state and needs no second agent tool call. Strict
recognition and exact-origin saved matching can require manual input/control
on otherwise valid sites. This first implementation does not claim universal
login, automatic arbitrary email-code retrieval, or unattended passkeys.

Tests cover real Chrome navigation and JavaScript transitions through username,
password and code; changed fields, hidden/external controls, challenges,
autocomplete and purpose; ambiguous or unrelated actions; the inspected Amazon
identifier markup; nonce replay, identity, cancellation/draining, saved lookup
failure, exact-origin credential matching, inline takeover and Mini App closure.
Live acceptance inspected Amazon's public identifier screen without entering
account details. Full real-account acceptance remains a separate user test.

The OS user and destination website remain trusted. Private strings cannot be
reliably zeroized. Existing takeover transport and lifecycle protections in
[ADR-0044](0044-telegram-browser-takeover.md) continue to apply; see also
[ADR-0040](0040-protected-telegram-browser-input.md),
[ADR-0041](0041-protected-opentable-sign-in.md) and
[ADR-0024](0024-use-1password-for-browser-login-credentials.md).
