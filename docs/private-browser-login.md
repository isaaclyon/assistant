# Private multi-step sign-in

`private_browser_login` keeps an existing stock-Chrome session protected across
email/username, password and verification-code screens. It uses the same private
Telegram Mini App and browser ownership as [browser takeover](browser-takeover.md).

## Workflow

1. Open the site's sign-in page with the stock helper and inspect it before
   private entry. Keep one HTTPS tab. Use this tool only for an authorized
   existing-account sign-in.
2. Supply `session`, the exact `pageUrl`, and a clean same-origin `resumeUrl`
   without query or fragment. Optional `credentialItem` names a user-approved
   1Password Login item in the current instance's dedicated vault. Never supply
   passwords, usernames or codes as tool arguments.
3. Tell the user to keep Tailscale connected and tap **Sign in privately**.
   The form shows the website and asks for the fields on the current screen.
   **Continue** submits that step. **Use saved sign-in**, when offered, privately
   resolves the approved item and fills just that step's username/password fields.
4. Wait through the whole flow. Do not inspect the browser, runtime, profile,
   console or network; do not run other browser tools or raw CDP.
5. The Mini App asks for the next recognized step without reopening Chrome.
   Unknown screens offer **Take over**, which opens the live browser inside the
   same protected operation. The user can finish a CAPTCHA, approval, passkey
   prompt or unfamiliar step, then choose **Hand back**. Prefer **Return
   privately** after sign-in. **Continue from this page** explicitly shares the
   website and its form contents with the assistant.
6. A recognized completion closes the Mini App automatically. Some sites need
   a final takeover and handback to confirm where the flow ended. After the tool
   returns, verify sign-in on the clean page; `submitted` and `handed_back` alone
   do not prove authentication. Stop the browser after the overall task.

## Supported screens and limits

The recognizer supports English-labelled, top-level, same-origin HTTPS POST
forms with one unambiguous sign-in action and recognized login/verification
destination paths. It supports ordinary navigations and JavaScript transitions
that retain those form semantics. Fields must be ordinary visible inputs with
clear username/email/phone, current-password or one-time-code semantics. A small
Amazon specialization accepts the inspected US identifier screen's combined
"Sign in or create account" heading and `/ax/claim` action; registration steps
still require human control.

Each field kind is submitted at most once, progressing from username to password
to code. Repeated challenges, ambiguous forms, unsupported destinations,
registration/recovery/settings screens, cross-origin transitions, embedded
frames, extra tabs and uncertain completion require takeover. A changed form or
challenge is never silently rebound and resubmitted. Some valid login sites will
therefore need manual control. Detection is conservative, not a proof of a
website's purpose; the destination website remains trusted.

Saved credentials require an **exact HTTPS origin** in the Login item's website
list, including hostname and port. A parent domain, subdomain, or `www` variant
does not qualify implicitly. Lookup uses the current instance's credential
scope, stays within the host, and is bounded. After manual username entry, a
saved item's username must match exactly. Missing configuration, mismatched
origin/username or lookup errors leave private manual entry available.
Starting directly on a password-only screen also uses manual entry or takeover;
saved-password steps require an identifier submitted within this private flow.

General verification codes use private manual entry. Automatic Gmail retrieval
remains limited to the existing [OpenTable specialization](private-browser-input.md),
with its audited sender, recipient, freshness and challenge checks. Passkeys
still require a compatible authenticator in remote Chrome.

## Source-vault approval in an isolated deployment

When a separately provisioned trusted broker is available,
`find_login_candidates` returns nonsecret source item references for the exact
website. Pass a selected `source:<item-id>` as `credentialItem`, with a short
`purpose`, to `private_browser_login`. The protected browser operation waits
while the broker sends the paired user a Telegram approval identifying the
assistant, login/account, source vault, website and purpose.

- **Allow Once** authorizes one protected username/password sign-in operation.
  It creates no destination item; website cookies may remain reusable.
- **Always Allow** creates an independent destination Login with only the
  username, password and website, then verifies it before delivery.
- **Deny**, cancellation and expiry release nothing.

The broker binds decisions to the shown message, item version and exact origin.
It consumes a decision once, including across restarts. It never retries an
ambiguous website submission or uncertain vault creation automatically. A
verified copy remains a successful copy even when website sign-in fails; these
outcomes are reported separately. Source edits do not update an existing copy.
Manual verification codes and takeover retain the existing supported behavior.

This flow requires the [isolated runtime and broker](household-fleet.md#isolated-personal-deployment);
the ordinary runtime has no source-vault approval authority. Production enablement
requires real Telegram, synthetic-vault and protected-browser acceptance.

## Privacy and recovery

The operation holds the stock session mutex and durable crash gate, and detaches
the regular observer before discovery or entry. Only fixed terminal status
reaches Pi. Step nonces are single-use; failed saved lookup rotates the nonce
and does not silently retry. Private form authentication does not release a VNC
ticket or password. Only an explicit **Take over** choice enables the viewer;
automatic filling stops permanently for that operation.

The same ten-minute deadline and tailnet-only port **8447** serve the entire
flow. Cancellation/expiry revoke input, cancel private lookup, drain in-flight
work and use private browser cleanup. Earlier website actions cannot be undone.
Unknown states preserve the current document until the user chooses takeover
or cancellation. Cleanup destroys sensitive documents and reopens `resumeUrl`
while retaining cookies, unless the user explicitly shares the current page.

On `browser_blocked`, stop the stock session before reopening. Never delete the
gate or inspect a protected browser. Other statuses and Serve recovery follow
the [takeover guide](browser-takeover.md). Same-user OS trust and JavaScript's
inability to guarantee string zeroization remain unchanged.

See [ADR-0045](adr/0045-private-multistep-browser-login.md).
