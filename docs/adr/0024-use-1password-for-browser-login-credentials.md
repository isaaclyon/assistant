---
status: accepted
relates-to: ADR-0020
---

# Use 1Password for browser login credentials

## Context

Persistent stock Chrome sessions reduce repeated sign-in prompts, but some sites
still require passwords. Putting service-account tokens or passwords in model
prompts, shell arguments, tracked configuration, or the bridge environment would
make accidental disclosure too easy. A provider also must not turn a dedicated
agent vault into unrestricted cross-domain credential access.

## Decision

Register a repo-owned `agent-browser.plugin.v1` provider with the stock-Chrome
helper and expose only `credential.read`. Keep one 1Password service-account token
and vault name per validated bridge credential scope under the private external
configuration root. Require service-user ownership and mode `0600`; install or
rotate them only through a trusted local hidden-input setup command.

For each request, derive the scope from the bridge identity, retrieve one exact
Login item through `op`, and pass the service-account token only in that child
process's environment. Require an HTTPS target whose hostname matches the item's
saved website hostname or a subdomain. Return only username, password, and the
validated target URL through agent-browser's credential response. Ignore TOTP
seeds and all other fields, suppress `op` diagnostics, and return bounded generic
failures.

Do not automate TOTP until agent-browser offers a protected fill path that does
not expose a code through model-visible output or process arguments. Use the
interactive browser handoff for second factors in the meantime.

## Consequences

- Passwords are resolved just in time and are not saved into agent-browser or
  Chrome by this provider.
- The long-lived bridge environment does not contain the 1Password token, though
  the provider and its short-lived `op` child necessarily hold it in memory.
- The dedicated vault remains the item allowlist, and saved website metadata is
  the domain allowlist.
- A compromised process running as the same Unix user is still outside this
  boundary; ADR-0020 already treats fleet separation as semantic rather than
  hostile multi-tenancy.
- TOTP remains a user handoff until a non-leaking automation interface exists.
