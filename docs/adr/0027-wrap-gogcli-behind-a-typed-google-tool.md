---
status: accepted
relates-to: ADR-0009, ADR-0020
---

# Wrap gogcli behind one typed Google tool

## Context

Gmail, Calendar, Contacts, and Places need one reusable Google API boundary.
Giving the model shell access to `gog` would also expose every command and every
OAuth scope supported by that binary. Fleet instances need separate account and
credential configuration without putting identities or secrets in an immutable
release.

## Decision

Register one repo-local `google_workspace` Pi tool. Its public schema is a closed
set of typed operations; there is no command, argument-array, API-method, or URL
escape hatch. The foundation initially exposes only a bounded account-status
operation. Feature issues add reviewed operation adapters to the same tool.

Execute an absolute, externally configured `gog` binary directly without a
shell. Every invocation is non-interactive, output- and time-bounded, and uses
operation-owned safety flags. Parse JSON and return only operation-specific
normalized fields. Child failures, stderr, malformed output, and configuration
details collapse to bounded generic errors.

Keep registration and the exact public schema in the extension, pure operation
parsing in `.pi/lib/google-operations.ts`, and credential/configuration plus
process/HTTPS execution in `.pi/lib/google-transport.ts`. The transport also
sanitizes its own errors. Already-cancelled requests never spawn a child; on
POSIX systems a dedicated process group lets timeout, cancellation, and cleanup
terminate descendants as well as the direct child. Windows retains direct-child
cleanup and is not the production deployment target.

Per-instance mode-`0600` environment files provide the absolute binary path,
an isolated `GOG_HOME`, optional default account, and path to a separate
mode-`0600` keyring-password file. OAuth clients, refresh tokens, API keys, and
the password remain in `gog`/bridge-owned external configuration. The extension
reads the password just in time and gives the child a minimal environment rather
than forwarding the bridge's ambient credentials. A distinct `GOG_HOME` prevents
one fleet profile from selecting another profile's stored account.

Enable the capability only in profiles that have an approved Google credential
scope. Adding a service operation does not authorize an account or broaden its
OAuth scopes; those remain explicit operator actions.

## Consequences

- Skills can share account selection and process safety without gaining generic
  Google or shell execution.
- Account onboarding and credential rotation remain operational setup outside
  Git and require a service restart to update the process environment.
- A new Google operation requires a schema change, a narrow response contract,
  and behavior tests.
- `gog` remains an external runtime prerequisite whose supported version and
  executable path must be managed by deployment/operator documentation.
- The same Unix user can still read its own credential files; this is the
  semantic fleet boundary already accepted in ADR-0020.
