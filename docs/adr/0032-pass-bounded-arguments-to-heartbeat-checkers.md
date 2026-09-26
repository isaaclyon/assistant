---
status: accepted
relates-to: ADR-0019, ADR-0031
supersedes-in-part: ADR-0019
---

# Pass bounded arguments to heartbeat checkers

## Context

ADR-0019 lets a heartbeat name only a checker ID. Watching a new web page
therefore meant writing, reviewing, and deploying a new checker with its URL
hardcoded. Semantic page watches (ADR-0031) make that cost recurring.

## Decision

- A heartbeat may add `checker.args`: at most 8 camelCase keys whose values are
  non-empty strings (at most 1 KB) or lists of 1-20 strings (at most 200 bytes
  each), 2 KB in total. Anything else fails job validation.
- The host passes the validated args as one JSON argv argument after the
  checker path. There is still no shell, no environment injection, and no
  executable path from job configuration.
- Args are part of the configuration fingerprint, so changing them resets the
  job's baseline.
- The first reusable checker is `web-page-items`. It reads `url` (public HTTPS
  only; IP literals, single-label, `.local`, `.internal`, and tailnet hosts are
  rejected, including after redirects) and optional `contains` phrases. It emits
  visible server-rendered text blocks as content-hashed `value.items` within the
  4 KB limit, and fails when a page has no readable text.

## Consequences

- The agent can create new page watches by editing `jobs.json` alone.
- Each checker owns the meaning and validation of its args; the host enforces
  only shape and size.
- `web-page-items` does not run JavaScript, log in, or read private pages. Pages
  that need those remain out of scope.
- An edited text block gets a new ID and is judged again as a new item.
