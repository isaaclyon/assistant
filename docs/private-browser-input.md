# Private browser input

`private_browser_input` opens an authenticated Telegram Mini App for a supported
sign-in form. It is available in private personal and builder chats. Tailscale
must be connected on the phone. No persistent listener or bot menu is installed.

For general email → password → verification flows, prefer
[`private_browser_login`](private-browser-login.md). It preserves transient
state between screens and offers takeover inside the same protected operation.

## Workflow

1. Use the tracked stock-Chrome helper to open the website and inspect its form.
   Keep a single tab in the browser session. Use a screenshot before private
   entry when it helps the user understand the step.
2. Call `private_browser_input` with the browser session, exact `pageUrl`, CSS
   selectors for one to three `username`/`password`/`code` fields, and the submit
   button. Choose a same-origin `resumeUrl` without query or fragment where the
   agent can verify login afterward. Never include values in tool arguments.
3. The user taps **Enter securely**, checks the displayed website, enters values,
   and taps **Fill and submit sign-in form**. This explicitly submits that form.
4. After the final successful submission, the Mini App closes and returns the
   user to chat. Intermediate steps and errors stay open; if the Telegram client
   cannot close, the completion message remains visible. The user does not need
   to send a separate “done” message.
5. The tool waits and returns a fixed status. After `submitted`, inspect the
   clean resume page to verify sign-in. A new code challenge needs a new request.

Supported pages must use HTTPS and an ordinary same-origin POST form. Inputs
must be visible, enabled, and in the same top-level form as the submit button.
Password fields must actually be password inputs. Replaced elements, changed
documents, changed form actions/methods, and another attached debugger fail closed.

## OpenTable

Use `private_opentable_login` for an existing OpenTable account:

1. Open `https://www.opentable.com/` in one stock-Chrome tab. Wait for the page to
   load, click **Sign in**, and select **Use email instead**. Snapshot refs work
   inside its sign-in iframe; re-snapshot before using a ref.
2. Call `private_opentable_login` with only the browser session name. Tell the
   user to keep Tailscale connected and use **Enter securely**.
3. The Mini App asks for email, then the password or six-digit code requested by
   the website. The agent waits through all steps. Never ask for those values in
   chat or inspect the protected browser between steps.
   In a Gmail-enabled profile, a fresh matching email code can be filled privately
   without another form. The code never appears in the Mini App or agent results.
4. After `submitted`, inspect the fresh homepage to verify the account is signed
   in. Stop the stock-Chrome session when finished; profile cookies persist.

This adapter supports the inspected same-origin sign-in frame and known login
routes only. It rejects changed frames/fields, registration, repeated challenges,
and unexpected steps. Interactive CAPTCHA, phone entry and unsupported screens
need the existing SSH handoff. It never resends a code or retries a submission.

### Automatic email codes

Automatic lookup uses only the current instance's configured default Gmail
account, and only when its capability profile already includes Google Workspace.
The entered email must match that mailbox exactly, and the website's visible
delivery notice must name that same email. There is no cross-profile credential
sharing or account discovery. The builder currently has no Gmail connection.

The private adapter checks sender authentication, recipient, receipt time and
uniqueness; it never follows email instructions, opens links or attachments, or
modifies messages. Lookup is brief and bounded. Missing mail, uncertain matches,
SMS, aliases, unfamiliar templates or disconnected accounts leave a manual code
field in the same protected Mini App. Do not retrieve a Gmail thread into model
context just to copy a verification code into the browser.

## Status and recovery

- `submitted`: a fill and submission were attempted successfully; the sensitive
  page was closed and a fresh resume page opened. Verify the website separately.
- `cancelled` / `expired`: input ended. In a multi-step flow, earlier steps may
  already have submitted, such as requesting a code. Sensitive pages are cleaned.
- `failed`: the browser rejected the submission or the page changed. A partial
  fill may have occurred; the sensitive page is cleaned before returning.
- `unavailable`: setup or delivery failed. Re-inspect the supported form and check
  Tailscale availability before requesting another form. Never paste values in chat.
- `browser_blocked`: cleanup is uncertain. Use `stock-chrome.mjs stop <session>`,
  then reopen and inspect the site. Do not read the page, delete its gate file,
  inspect profile/runtime files, or bypass the helper with raw CDP.

Stopping a crash-blocked browser discards its pages; profile cookies persist.
An old default agent-browser daemon can make preflight fail after this upgrade;
stop/reopen the dedicated Chrome session to detach the old connection.

## Limits

Reopening a clean page discards transient DOM state. Use the existing SSH browser
handoff for JavaScript-only forms, multi-tab login, passkeys, CAPTCHA, payment
fields, embedded frames, or challenges that must keep their response document,
apart from the closed OpenTable adapter above.
The tool is for authorized sign-in and verification, never purchases or account
changes. The operating-system user and destination website remain trusted.

## Validation

Tests cover signed identity and origin checks, replay and expiry, cancellation,
concurrent submission, sanitized failures, gate retention, and real Chrome
submission to a synthetic HTTPS form. The Chrome test deliberately reflects the
synthetic password in its response and verifies that document is destroyed before
ordinary browsing resumes. Real-site compatibility still needs the user's test.
