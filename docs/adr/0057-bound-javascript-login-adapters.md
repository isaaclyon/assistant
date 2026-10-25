---
status: accepted
relates-to: ADR-0051, ADR-0052
---

# Bind JavaScript sign-in support to inspected website contracts

## Context

Saved credential approval/copy and protected browser compatibility are separate
boundaries. The protected flow requested source approval even when its initial
page was already classified as manual. An independent vault copy could therefore
succeed while the resulting viewer could not autofill it.

The inspected Costco US existing-account page uses Azure B2C, a GET form with a
JavaScript no-op action, and a policy path containing `signup_signin`. Its closed
informational tooltips mention checkout and payment. The general POST recognizer
correctly did not accept that contract, but the workflow hid this incompatibility.

## Decision

Before requesting source approval or resolving a saved credential, require a
recognized eligible initial username/password step. Otherwise privately clean up
and return only the fixed `unsupported_form` failure. Do not silently substitute
manual browser control. This preflight cannot guarantee the page will stay
compatible during approval; later failures still report copy outcomes separately.

Support Costco through a narrow inspected contract in the existing private
recognizer: exact HTTPS origin and policy path, form/input/submit identities,
combined email and current password, JavaScript no-op action, and no embedded
form or submit destination overrides. Do not generalize this to arbitrary GET
forms or B2C tenants. Evaluate the visible existing-account purpose rather than
closed informational tooltips. Fence visible purpose, full original text,
controls, field identities, page URL and action again immediately before fill.
Continue to allow each field kind only once; do not replay uncertain submissions.

The existing private owner, credential origin approval, observer disconnection,
mutation fences, secret cleanup and terminal-output whitelist remain unchanged.
This adapter trusts scripts on the approved website, like the existing POST flow;
it does not claim to constrain JavaScript network requests. Unexpected verification,
cross-origin navigation, registration/recovery, changed policy or uncertain
completion still needs human control. Submission is not proof of authentication.

## Validation

Synthetic HTTPS Chrome tests exercise combined JavaScript submission and reject
wrong origins, actions, controls, visible non-login purpose, extra fields, embedded
forms and mutations before filling. Lifecycle tests prove incompatibility is
reported before broker approval/copy or viewer launch. Public-page recognition is
checked without submitting credentials. Real-account acceptance is a separate,
user-authorized check after deployment, reusing any existing approved copy rather
than creating another one automatically.
