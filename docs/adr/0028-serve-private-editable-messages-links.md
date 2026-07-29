---
status: accepted
relates-to: ADR-0005, ADR-0009, ADR-0020
---

# Serve private editable Messages links through Tailscale

## Context

Telegram does not make `sms:` links from bot messages clickable. Assistant
workflows still need to propose a recipient and draft while leaving editing,
opening Messages, and sending under separate user control. Recipient and draft
text must not enter the web server request or logs.

The production host already runs Tailscale and deploys immutable releases. An
earlier proof of concept established that the target iPhone accepts
`sms:<number>&body=<encoded text>` and that Tailscale Serve can expose a static
page privately over HTTPS.

## Decision

Track a dependency-free static page under `web/messages`. Links encode the
normalized recipient, bounded label, and proposed body exclusively in the URL
fragment. Browser JavaScript parses and validates those fields, renders the body
in a textarea, and constructs the tested iPhone `sms:` URL from the textarea's
current value only inside an explicit button-click handler. The page never
navigates automatically; sending remains a separate Messages action.

Publish the selected immutable release directory through Tailscale Serve on
HTTPS port 8443. Do not use Funnel. The merged deployment activates this page
only after the bridge is ready, verifies that Serve points at the exact release,
rejects any Funnel permission on that port, and fetches a content-free health
file through the tailnet HTTPS hostname. A failed page activation restores the
previous Serve target and fails deployment without rolling back an already
healthy bridge, matching the post-activation notification failure boundary in
ADR-0005. `tailscaled` owns HTTPS certificates and serving lifetime.

A tracked `message-link` skill and stdin-JSON helper generate Telegram-safe
HTTPS links. The helper discovers the local tailnet DNS name or accepts an
explicit HTTPS-origin override. It refuses credentials, paths, queries, and
non-HTTPS base URLs. Fragment values never appear in its HTTPS origin.

## Consequences

- Authorized tailnet devices can open the page; tailnet grants/ACLs remain the
  network authorization boundary.
- The server receives only `/`, static asset, and health requests. URL fragments
  are browser-local by HTTP semantics and cannot appear in Serve access logs.
- Deployment requires a running, HTTPS-enabled Tailscale node and noninteractive
  permission to update Serve configuration. Missing Tailscale or failed health
  checks make deployment visibly fail after bridge readiness.
- Release cleanup is safe because every successful deployment repoints Serve to
  the newest retained immutable release before old releases are pruned.
- The `sms:` body syntax is based on the verified target iPhone behavior. Other
  platforms may handle body prefill differently; no automatic-send guarantee is
  made.
