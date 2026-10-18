# C4 general tools and public web

Status: **first slice implemented and locally validated on `feat/durable-c4`;
C4 remains in progress.** C3 is accepted. This slice restores general file,
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

## Validation and limits

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
keeps C4 open for read-oriented integrations, direct places UI, guarded mutations,
protected browser workflows and provider/operator parity. C5–C7 remain pending.
