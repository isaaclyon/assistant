# C4 tools, reads, CLI skills and direct places

Status: **first slice implemented and locally validated on `feat/durable-c4`;
a second Google-read slice is implemented and locally validated on
`feat/durable-c4-reads`; a CLI skill slice is implemented on
`feat/durable-c4-cli`; direct private places are implemented and locally validated on
`feat/durable-c4-places` (validation below);
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
keeps C4 open for direct places UI, guarded mutations,
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
profiles except the CLI-integrations profile, which inherits these reads. Both
require the same memory principal/authority as C3.
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
integration gates remain unverified. Direct places UI, guarded mutations,
protected browser and provider/operator parity remain open.

## CLI skill integration slice

The separate `durable-cli-integrations-test` profile selects the Google-read
profile's bundles plus memory, weather, `manage-ynab` and `message-link` skills.
A `google-read-tools` skill supplies the same Google-read rules while allowing
selected workflows to compose contact lookup with Messages drafting. The prior
read profile keeps its own narrower skill and unchanged compatibility identity. It adds no tool or CLI adapter. Calls use the existing bounded,
sequential, replay-unsafe `bash` tool. Prior native profiles keep their selected
resources and compatibility signatures. Select this profile with a new private
native store, the same C3 memory configuration and explicit `google` object
(`{}` is valid when Google is not configured).

### Configuration and operation

An optional private native configuration field sets the Messages HTTPS origin:

```json
{
  "capabilityProfile": "durable-cli-integrations-test",
  "cli": {
    "messagesBaseUrl": "https://synthetic-node.example.ts.net:8443/"
  }
}
```

This is a synthetic configuration fragment; retain the other required C2/C3
fields. The origin must use HTTPS without credentials, a non-root path, query or
fragment. Unknown CLI fields and CLI configuration outside the CLI and places profiles fail
validation. The selected origin becomes `PI_TELEGRAM_MESSAGES_BASE_URL` only in
the CLI and places profiles' child shell environment. Ambient values are excluded. Omitting
`cli` or its origin retains the helper's bounded local Tailscale hostname
discovery. CLI configuration is part of this profile's recovery signature;
changing it blocks incompatible store reopening.

Both skills resolve tracked helpers from `PI_TELEGRAM_BRIDGE_RESOURCE_ROOT`,
with the existing cwd fallback for ordinary repo sessions. They work when the
mutable workspace differs from the release. User values require shell quoting;
Messages draft JSON enters on stdin. The helper encodes recipient, label and
body only in the URL fragment. Generating a link does not verify that the
private endpoint is deployed or reachable. Opening Messages and sending remain
separate user actions. Tailscale Serve deployment remains the existing
[ADR-0028 procedure](adr/0028-serve-private-editable-messages-links.md).

YNAB uses the runtime's OS identity and existing CLI-owned authentication.
Tokens are not selected through model arguments or copied into native config.
Budget/account defaults remain private `~/.config/pi-telegram-bridge/ynab.json`;
the skill asks the user to choose missing or invalid defaults. CLI discovery and
read helpers prefer `ynab` on PATH, then `~/.bun/bin/ynab` only when the
executable is missing. Auth, command and transport failures do not select a
second installation or silently repeat the call. Existing helper subprocess
bounds remain 30 seconds and 1 MiB; shell tool output/deadlines remain bounded
as described above.

The full YNAB skill retains its user-authorization rules for transaction changes,
receipt previews and destructive actions. Those rules are model guidance; this
slice does not add a trusted financial approval service or domain receipts.
All CLI calls, including reads, inherit replay-unsafe shell recovery. A lost
write result may mean the transaction succeeded. Inspect the exact transaction
with a read-only command and reconcile it before proposing another attempt;
never automatically repeat an uncertain create, update, delete or split.

### CLI-slice validation and limits

Validation uses synthetic providers, a disposable HOME and fake YNAB/Tailscale
executables through the actual selected application and real shell environment.
Tests cover private defaults, normalized helper output, PATH preference, Bun
fallback, no fallback after a command failure, release/workspace separation,
explicit Messages origin and hostname discovery, fragment-only draft values,
a synthetic write result, actor rejection, profile selection and config-change
compatibility rejection. Existing YNAB normalization and Messages page/helper
unit suites now run in the ordinary native gate.

SIGKILL tests stop the process after a fake CLI write succeeds but before its
tool result commits. Recovery keeps one effect and one invocation, returns an
interrupted tool error, and does not rerun the command after an epoch change.
The fixture uses the production selected registry and authority wrapper; replay
unsafe recovery itself skips execution rather than invoking authorization again.

Under Node 24, `npm run check:changed` passed 438 tests in 40 files and
`npm run build` passed, including the compiled application import. Independent
read-only review found no critical/high defects. Its receipt-capability mismatch
was corrected with explicit text-only guidance; recovery assertions were also
tightened. The CLI profile uses Google-read guidance compatible with Messages
drafting while preserving the prior profile's narrower selection.
No real YNAB account, keychain, receipt upload, Google account, Telegram bot or
Tailscale endpoint was used. Live CLI/auth compatibility, private endpoint
health, media/receipt handling and Linux service behavior remain later acceptance
work. This completes the selected CLI skill migration slice; it does not close
C4's places, guarded-mutation, browser or provider/operator gates.


## Direct places application slice

`durable-places-test` adds the `native-places` bundle and `rank_places` tool to
the CLI profile's selected capabilities. It requires the `isaac` principal and
the same explicit memory/Google configuration (`google: {}` is valid), with
optional `cli.messagesBaseUrl`. Use a new private native store; changing an
existing store's selected profile fails compatibility checks. All older profile
selections and signatures remain unchanged.

`/place_rankings` and the status menu open the deterministic application outside
the model loop. The tool hands an add request to category/sentiment buttons, and
comparison answers, back, resume, rankings and details use the existing
`PlacesApplication`, `PlacesService` and private `places.db`. Ranking algorithms
and the domain schema stay unchanged. Names, categories and place notes can be entered through replies to an exact
direct prompt. Renaming, notes, moving/re-ranking and paginated categories and
rankings use the same non-destructive application commands. A successful direct
tool handoff ends the model round. The native profile remains text-only.

The native Harness root owns the pre-insertion draft, prompt bindings, one-use
callback capabilities and command claims. Capabilities expire after ten minutes
and bind the current principal, actor, private chat, conversation epoch and
acknowledged Telegram message. Callback data contains an opaque handle. A send
without a known message receipt cannot enable its buttons; reopen the command to
recover. New/reset invalidates old buttons and prompts while a fresh open
recovers the saved draft or canonical comparison. Reload likewise invalidates
interaction capabilities. Restart preserves unexpired current-epoch state.

Acknowledged prompt message IDs remain as compact tombstones when full prompt
records expire or are pruned. They keep delayed replies out of model history.
If a prompt send loses its receipt, an exact quoted prompt from the configured
bot in the private chat is consumed as inactive using its opaque input reference;
it cannot authorize an effect. Prompt input bodies are not stored in these
tombstones. C6 must measure their retention/storage cost before cutover.

Each effect first commits a claim. A second Harness transaction rechecks current
authority, synchronously runs the domain command and records its result. The
Harness and ranking database are separate stores: a crash after claiming can
leave an unknown result. That claim never executes again. Inspect or resume the
canonical ranking before deciding what to do next. Interrupted model tool calls
are also replay-unsafe. Losing a direct-result presentation cannot turn a
captured reply into a new model request or automatically repeat an effect.
Concurrent redelivery reuses the recorded result. Presentations are at-least-once,
so an uncertain send can produce duplicate messages; only the acknowledged
message binding enables its buttons. Shutdown stops intake and drains complete
places operations while the Harness is still open, then closes its domain store.

This slice excludes cancellation, deletion, undo and confirmation requests; the
following guarded-mutation slice adds their explicit authority and recovery.
It does not import legacy in-flight callbacks or private state. C6 owns migration
rehearsal for legacy drafts and other existing recovery data.

### Places-slice validation and limits

Offline validation uses the actual selected application and registry, a faux
provider, recording Telegram transport, disposable native stores and the existing
ranking/application/service/store/management suites. It covers model handoff,
direct callback/reply capture, actor/chat/message/epoch rejection, reset/reload,
restart, concurrent redelivery, category pagination, queued shutdown and replies
to pruned or unacknowledged prompts. An input that expires after its claim is
consumed and gets a visible notice.

Six SIGKILL cases exercise the real host and domain SQLite database: before and
after a ranking write, both crashes followed by an epoch change, and before/after
a captured category-input write. Recovery resends the exact original command ID
first, then tests a fresh update ID. No write is repeated. Epoch fixtures mutate
the root Bindings document directly; actual `/new` and `/reload` are also covered
in the full application tests. Lost send receipts use fault injection rather
than process death at the network boundary.

Under Node 24, `npm run check:changed` passed 547 tests in 49 files and
`npm run build` passed, including the compiled application import. Static
comparison confirmed every pre-existing profile/resource object is unchanged;
updated documentation links and `git diff --check` also passed.

Independent read-only review covered the production integration and crash
assertions and found no high/medium defects. Its shutdown-order and input-expiry
findings were corrected with regression tests. Prompt-ID retention remains an
explicit C6 measurement gate; pruning those IDs without another capture mechanism
would admit old private replies to the model.

No live Telegram bot, real provider account, private rankings or production
service was used. Real ordinary/broker delivery, Linux service behavior and
legacy-to-native state migration remain later acceptance gates.
