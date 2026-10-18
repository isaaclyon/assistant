# C4 general tools, public web and Google reads

Status: **first slice implemented and locally validated on `feat/durable-c4`;
a second Google-read slice is implemented and locally validated on
`feat/durable-c4-reads`;
C4 remains in progress.** C3 is accepted. The first slice restores general file,
shell and bounded public-web tools in a separate selected profile. Production
continues using its legacy release. The legacy planning checkout retains this
guide as checkpoint evidence.

## Selected surface

`durable-tools-test` extends C3's seven bundles and personal-memory skill with
`native-general-tools`, `native-public-web` and explicit tool instructions. It
adds `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`, `web_fetch` and
`web_search` to the five C3 memory/history tools. The accepted C3 profile and
foundation profile keep their existing selections.

Use the [C2 launch procedure](pi-durable-c2-foundation.md) and
[C3 memory configuration](pi-durable-c3-chat-memory.md#configuration-and-operation)
with `capabilityProfile: durable-tools-test`. Use separate private native state;
a profile change over an existing store fails compatibility checks. This profile
requires the same scoped memory principal, private configuration and vault as C3;
engineering cannot select it. It enables no additional skills or credentials.
All resource paths are canonicalized inside the release before importing bundles.

## Execution and recovery

The pinned 1.3.0 SDK owns native read/write/edit/bash semantics. The application
owns one `NodeExecutionEnv` rooted at the configured workspace, and closes it
after stopping the host. Relative paths use that workspace. Absolute filesystem
access follows the runtime's operating-system permissions; the cwd is not a
filesystem sandbox. Typed memory tools retain their existing approval workflow.

Every selected tool passes through `registry.ts`'s production authorization and
handler-signature wrapper. It rechecks the bound principal, private target and
current conversation epoch before execution, including replay. A completed
historical result does not authorize a new call.

| Tools | Recovery policy |
| --- | --- |
| `read`, `grep`, `find`, `ls`, `web_fetch`, `web_search` | Replay-safe after a current authority check; a resumed read can observe newer data |
| `write`, `edit`, `bash` | Replay-unsafe and sequential; a missing result stays interrupted instead of repeating an effect |
| C3 memory/history tools | Existing C3 policies and domain-owned operation receipts |

An interrupted write or command may already have succeeded. Inspect the
filesystem and any external effects before deciding to retry. General writes
have no domain reconciliation receipt. Shell calls default to 60 seconds with a
300-second maximum. SDK execution owns cancellation, process-tree cleanup and
bounded tail/spill output. Do not start unmanaged background services.

Child execution uses `inheritEnv: false`. The environment contains ordinary
user path/home/locale/temp settings, selected public instance paths/identity and
explicit operation extras. Ambient bridge credentials, feature flags and
repository-routing variables are excluded. This limits accidental inheritance;
the operating-system identity remains the access boundary.

`grep` and `find` require `rg` on PATH, run fixed argv under a ten-second deadline,
and retain at most 50 KiB of raw output. Glob filtering happens after gitignore
rules, so a positive glob cannot re-include ignored files. Simple globs support
`*`, `**`, `?` and character classes, with 256 characters/eight stars and no
brace/extglob expansion. Path arguments are bounded to 4096 characters.
Result limits and discarded partial records are reported as incomplete; a
narrow filter can miss matches beyond the raw capture. Grep renders at most
500 characters per retained line. `ls` includes dotfiles and returns a sorted
sample of at most 500 entries.

## Public web

`web_fetch` retrieves credential-free public HTTP(S) URLs. Every redirect hop
resolves and validates all addresses, blocks local/private destinations, and
pins the connection to the validated addresses. Requests use fresh connections.
The complete operation, including the DNS wait and body, has a 20-second
deadline and caller cancellation. Retrieval stops at 2 MiB and five redirects;
text output is bounded to 50 KiB. HTML becomes plain text; binary content is
identified without printing its bytes. Text decoding currently assumes UTF-8.

`web_search` uses the existing DuckDuckGo HTML approach, returning up to ten
result titles, HTTP(S) URLs and optional snippets with source attribution.
Bot-check pages, HTTP failures and unparseable/empty results produce explicit
errors. Search availability and markup can change. Returned text is untrusted
source material; cite actual public URLs.

These tools are a bounded provider-neutral first slice. They do not establish
legacy `web_run` or provider-specific search parity. Authenticated browser
workflows retain their separate C4 acceptance boundary.

## First-slice validation and limits

Under Node 24, `npm run check:changed` passed all 293 tests in 32 files, and
`npm run build` passed, including the compiled application import.
Tests exercise the actual selected application/profile with synthetic providers,
real files, shell commands and argument-array inspection. They cover gitignore
with globs, injection-shaped patterns, environment exclusion, shell deadlines,
output bounds, child-process termination on abort and cleanup after a host-close
failure. The C3 tool catalog remains unchanged.

Subprocess SIGKILL tests pause after real bash/write/read effects and before the
tool result is recorded. Reopening proves writes and commands are not repeated,
reads can replay, and a changed epoch prevents another filesystem read. These
use the selected production registry wrapper; the test-only pause surrounds the
real handler. Web fixtures cover address/redirect validation, retrieval/output
caps, DNS/body deadlines, cancellation races, late-response cleanup and optional
search snippets. Mocked Node HTTP tests exercise the default transport's pinned
lookup, fresh-connection options and connection failures with a real readable
body. They do not prove current live search availability or public-network
reachability.

Two independent read-only reviews found no critical/high issues. DNS deadline,
abort-race, snippet pairing, fresh-connection, glob-bound and sequential-write
findings were addressed with regression coverage. Authority is enforced by the
production registry wrapper shared by all selected tools; the recovery fixture
loads that wrapper rather than adding authority only around a test handler.

No live bot, credential copy, production service or private-state migration was
needed for this slice. Linux/systemd and full integration acceptance remain later
gates. The [roadmap](pi-durable-migration-plan.md#c4--remaining-integrations-and-protected-browser-workflows)
keeps C4 open for remaining CLI-backed skills, direct places UI, guarded mutations,
protected browser workflows and provider/operator parity. C5–C7 remain pending.


## Google read integration slice

`durable-read-integrations-test` selects the general-tools surface plus the
native `google-reads` bundle, a focused Google-read skill and the existing
`check-weather` skill. It offers twelve `google_workspace` operations:
`account_status`, `calendar_list`, `calendar_events`, `calendar_search`,
`calendar_availability`, `calendar_event`, `gmail_search`, `gmail_thread`,
`contacts_search`, `places_search`, `places_search_candidates`, `places_details`.
The foundation, accepted C3 and first C4 profiles retain their selections and
compatibility signatures. Use a separate private native store for this profile.

The provider sees a flat, closed object schema. The adapter validates the exact
operation branch before transport, including required fields, cross-operation
fields and branch-specific limits. The native bundle reuses pure Google
normalizers, the bounded gog/HTTPS transports, the guarded single-event read,
and the existing Places SQLite gateway. It does not import the legacy Pi
extension or its registration/confirmation lifecycle.

### Explicit private configuration

Use the C2/C3 private instance configuration with
`capabilityProfile: "durable-read-integrations-test"` and an explicit `google`
object. This synthetic example shows the complete optional configuration:

```json
{
  "google": {
    "account": "reader@example.com",
    "gog": {
      "binary": "/opt/google/bin/gog",
      "passwordFile": "/private/native/google-password",
      "home": "/private/native/gog-home"
    },
    "calendarTargets": {
      "account": "reader@example.com",
      "personal": "stable-personal-calendar-id",
      "thingsToDo": "stable-things-calendar-id"
    },
    "places": {
      "apiKeyFile": "/private/native/places-key",
      "searchMonthlyLimit": 20,
      "detailsMonthlyLimit": 20,
      "candidatesMonthlyLimit": 10
    }
  }
}
```

The native adapter takes these paths and limits from private instance JSON;
it does not resolve legacy Google environment variables. Paths must be absolute.
Passwords and API keys stay in separate current-user-owned mode-0600 files,
read just in time. OAuth clients/tokens stay in the isolated gog home. An empty
`google: {}` is valid and reports unavailable configuration when needed.
Missing sections disable their corresponding transport. Limits are required
when selecting Places, accept integers from zero to one million, and cannot be
overridden by tool arguments. Google configuration is rejected for other native
profiles; this profile requires the same memory principal/authority as C3.
Changing its Google configuration blocks reopening an incompatible store.

Single-event reads preserve the existing stricter Calendar boundary: explicit
stable Personal/Things to Do IDs, the configured email account, full Calendar
authorization and editor/owner access. They issue only `calendarList.get` and
`events.get`. The other Calendar reads use bounded account/calendar/window
selection. This profile exposes no Calendar mutations.

### Bounds and recovery

Workspace commands use absolute gog execution without a shell, fixed read-only,
noninteractive and no-send flags, a minimal child environment, a ten-second
transport deadline and 64-KiB output caps. The native adapter adds a 30-second
operation signal and propagates caller cancellation. POSIX cancellation kills
the process group. Contacts limits results to ten, Gmail search to fifty,
calendar windows to 366 days and availability to 31 days/eight accounts.
Normalized remote text remains untrusted and failures omit raw provider errors.

The model-visible dispatcher is replay-safe; ordinary Workspace reads may run
again after the production registry rechecks current principal/chat/epoch.
Places runs as an internal `google_places_read` nested task, callable only by
other tools, with replay **unsafe**. Its durable intent prevents an interrupted
lookup from automatically repeating an uncertain outbound attempt. A completed
nested result can return to the dispatcher after restart. An interrupted result
reports that an attempt may already be counted; a new explicit lookup follows
the usual cache and metering rules. Both task boundaries use production authorization and handler signatures.

Places keeps the existing `<stateDir>/google-places.db` transaction, cache keys,
UTC-month accounting and SKU limits. Reservation occurs before outbound fetch;
failed attempts remain counted. Identity text/candidate searches cache for 24
hours and identity details for 30 days. Rich details are uncached, retain review
author/source links and use a separate SKU with its own copy of the details
limit. Identity and rich details can therefore consume twice the numeric details
setting. Local metering is conservative; it does not prove provider billing.

### Read-slice validation

Under Node 24, `npm run check:changed` passed 395 tests in 37 files and
`npm run build` passed, including the compiled application import.
Validation uses synthetic providers and private fictional credential fixtures;
it makes no real Google requests. Production composition exercises the default
gog subprocess and default Places HTTPS path with fake network responses,
normalization, fixed masks, cache hits, monthly blocks, uncached attributed
reviews, authorization, actual child termination and nested HTTPS cancellation
on abort. Schema/branch and
config tests cover invalid requests before I/O and incompatible configuration.
Subprocess SIGKILL tests cover Workspace retry after effect, epoch rejection,
and a Places fetch/reservation with no duplicate after recovery. Shared transport
and gateway suites remain in the ordinary native test gate.

Live Google/OAuth compatibility, Linux/systemd and the remaining full C4
integration gates remain unverified. CLI-backed skills, direct places UI,
guarded mutations, protected browser and provider/operator parity remain open.
