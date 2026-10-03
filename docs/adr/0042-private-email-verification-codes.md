---
status: accepted
relates-to: ADR-0027, ADR-0040, ADR-0041
---

# Retrieve matching email codes inside the protected login flow

## Context

The user completed OpenTable sign-in and verified Mini App auto-close, then asked
the assistant to retrieve an obvious email-delivered code automatically. Calling
the model-facing Gmail thread tool would put that code into model/session data.

## Decision

Add a private email-code adapter to the existing OpenTable operation. It runs
under the existing browser mutex and crash gate, with the observer disconnected.
The agent tool still accepts only the browser session and returns a fixed status.
Neither the model nor the Mini App receives mailbox contents or extracted codes.

Use only the current instance's existing Google transport and default account.
Require that its selected capability profile includes the Google Workspace
extension and that its own gog runtime is configured. Resolve Gmail's actual
mailbox address and require an exact case-insensitive match with the email the
user entered privately. Never borrow another instance's credentials, enumerate
other accounts, infer aliases, or add OAuth scopes. Builder and other profiles
without Google access retain manual entry.

Before requesting a login code, snapshot bounded recent OpenTable message IDs.
After the website advances to a code field, require its visible delivery notice
to identify the exact entered email. An SMS destination, masked address, unknown
wording or changed challenge stays manual. Recheck that same recipient in the
bound browser operation immediately before inserting an automatic code.

The adapter owns fixed Gmail Discovery GET methods: profile, message list and
message get. All commands are non-interactive, read-only, time/output-bounded,
and use the established minimal environment and private keyring transport.
Search only recent OpenTable code/verification messages. Require exactly one new
message, its expected ID, a fresh Gmail internal receipt timestamp, exact To
address, an OpenTable From domain, and one receiving-Gmail authentication header
with aligned DMARC pass. Reject truncation, malformed metadata, forwarded or
ambiguous messages, and multiple possible codes. Inline MIME text is parsed
deterministically; no links, attachments or instructions are executed.

Only a single six-digit candidate can enter the protected browser. A challenge
is consumed once, including failed lookup; there are no code resend or login
retries. Polling is bounded to eight seconds and preparation has its own
eight-second bound. Cancellation and the request's original expiry propagate
to the mail subprocesses and are checked before browser filling. The Mini App
allows time for these internal operations, remains open if manual input is
needed, and closes on final submission as before.

## Consequences

- Initial support is the known English OpenTable email-code screen and the
  current instance's default Gmail account. Other inboxes, aliases, providers,
  templates or ambiguous messages use manual entry.
- Mail remains unread and unmodified. A sign-in can request only the existing
  protected website action; email text cannot select tools, URLs or actions.
- Message bodies/codes live transiently inside the host and gog stdout pipe,
  never in tool parameters/results, chat, durable files or diagnostics. The code
  is never a command argument. Existing destination-site and same-user trust
  limits remain; JavaScript strings cannot be reliably zeroized.
- The implementation relies on Gmail's receiving authentication metadata and
  narrow timing/recipient matching, not an OpenTable challenge ID in the email.
  Uncertainty falls back to the private manual form.
- Automated tests use synthetic mail, mocked Google responses and real Chrome
  against local synthetic HTTPS pages. Real-inbox acceptance needs a sign-in
  through a Gmail-enabled personal profile; the builder has no mailbox connection.
