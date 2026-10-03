---
status: accepted
relates-to: ADR-0025, ADR-0040
---

# Keep OpenTable's embedded login protected across steps

## Context

The user selected OpenTable as the first useful real-site login. Inspection found
a same-origin sign-in iframe with JavaScript-managed forms: email first, then a
password or a six-digit verification code. The code screen automatically submits
when complete. Reopening the homepage between these steps loses the challenge.
The generic POST-only tool cannot handle this flow.

## Decision

Add `private_opentable_login` to the existing private-input extension and profiles.
It accepts only a stock-Chrome session name. The host owns the exact homepage,
same-origin iframe, login paths, fields, and permitted step transitions. The agent
opens Sign in and selects Use email instead before calling. No arbitrary script,
frame selector, callback URL, endpoint, or intermediate page content enters the
tool contract. Generic `private_browser_input` remains POST-only.

Hold the existing browser mutex, observer disconnection, persistent crash gate,
and private CDP connection through the entire operation. Bind the original tab,
top document, iframe identity and document, then bind exact field/form/button
objects for each recognized step in an isolated world. A changed frame or field
invalidates that pending input. Only the website's existing UI receives values;
the host never constructs login API requests, reads cookies, solves CAPTCHA, or
extracts application tokens. Click email/password Continue once after its render;
let OpenTable's own code listener submit the six-digit code once.

The authenticated Mini App advances through fixed email/password/code labels.
Every submission requires the current random step nonce, consumes it before any
browser work, and rotates it before exposing the next step. The server permits
at most three distinct kinds, including initial email, and never retries a step
or resends a code automatically. Earlier values and page text never appear in
metadata. Cancellation and the original ten-minute deadline cover all steps;
neither can reopen a pending step after in-flight browser work finishes.

After any attempted fill, including cancellation between steps, destroy the
sensitive tabs and open a fresh homepage before releasing the observer. Retain
the gate on uncertain cleanup. `submitted` remains an attempted submission, not
proof of login. The agent verifies the clean homepage separately.

## Consequences

- Existing-account email login is supported. Phone entry, registration, account
  changes, unexpected routes, repeated challenges, and interactive CAPTCHA need
  the SSH handoff. A site update may safely reject a previously supported step.
- Entering email can already request a verification message before the user
  cancels. Terminal cancellation/expiry does not undo earlier website actions.
- This is a reviewed site adapter, not general embedded-form or JavaScript-form
  support. It preserves ADR-0040's trust in the destination website and operating
  system user rather than claiming hostile-process isolation.
- Tests use locally mapped synthetic HTTPS pages with the observed routes and
  selectors, including auto-submission, disabled buttons, registration refusal,
  DOM/frame replacement, stale-step replay and reflected secret cleanup. The
  real unauthenticated email screen passed a read-only binding check. Completing
  an actual account login still requires the user's acceptance test.
