# Personal runtime isolation and approved credentials

Status: approved direction; implementation and migration pending.

## Outcome

Run the personal assistant as a dedicated, unprivileged OS identity. A separate
trusted service verifies the user's credential approvals and reads eligible
1Password items. The assistant can request a login but cannot read the source
vault token, manufacture an approval, or administer the trusted service.

The user approved migrating the personal runtime to an unprivileged account.
This document records the migration requirements and the remaining engineering
work. It does not describe an already-deployed boundary.

## Evidence and constraints

Current fleet isolation is semantic under one Unix account (ADR-0020). The
personal runtime's current account has unrestricted passwordless sudo and
container-administration group membership. Adding a second credential-service
user under that arrangement does not isolate its secrets.

Synthetic tests separately established scoped 1Password copy behavior and an
actual Telegram-button-to-browser flow. The latter used in-memory credentials.
Neither proves the combined production path or OS isolation.

`src/service-unit.ts` and `src/install-service.ts` currently install user units.
Fleet preparation assumes shared agent/config/state roots. Job delivery writes
directly into recipient state directories (`src/job-handoff.ts`). Deployment and
recovery expect a coordinated fleet transition. Changing only a service's user
would break these contracts.

Retain pinned Pi packages and `@llblab/pi-telegram`; any required fork transport
change must be source-reviewed and pinned. Preserve capability filtering,
dedicated bridge sessions, same-workspace restarts, durable inbox/occurrence
state, and the recovery barriers in ADR-0030.

## Boundaries

### Personal runtime

Use a dedicated static UID so private state survives restarts. It has no sudo,
Docker/LXD administration, access to administrative SSH keys, deployment
credentials, writable privileged executables, or administrative service sockets.
Use an administrator-owned system unit with `User=`, `Group=`,
`NoNewPrivileges=yes`, an empty capability set, and explicit writable state and
workspace paths. Validate additional systemd protections against Chrome and the
existing tools rather than enabling an untested blanket sandbox.

Runtime code, interpreter binaries, unit definitions, and their parent paths
must not be writable by this UID. Move runtime dependencies out of the old
administrator's home. Give the runtime only its selected capability credentials
and scoped private state. Do not copy the administrator's entire home, Pi agent
directory, Telegram configuration, or SSH environment.

An approved independent copy belongs in the personal destination vault. Access
to that vault is intentionally available for future sign-ins. Removing its
item prevents future password use; it does not revoke existing website cookies.
An OS administrator remains trusted and can access this machine's services.

### Credential and approval service

Use another non-login UID with source-vault read and destination-vault write
credentials. Its executable and configuration are administrator-owned. Source
vaults must be eligible custom vaults; built-in Personal/Private vaults cannot
be granted to a service account. Keep account/vault/item IDs and all tokens in
private external configuration, using synthetic values in tests.

Approval verification must run outside the assistant's authority. A runtime
claim that a callback was approved is not evidence. An IPC request must bind an
authenticated runtime identity to its permitted destination, exact source
item, site, user, request nonce and expiry.

For the existing-bot interface, a trusted transport must own the actual Bot API
token and receive Telegram updates itself. Forward ordinary assistant traffic
through a narrow interface and consume credential decisions in trusted code.
There is one poller and one durable offset owner. Do not share the bot token
with the untrusted runtime or let it edit trusted approval messages. In
particular, Telegram Mini App signatures do not create isolation if the
assistant can read the token used to verify them.

This transport split needs a compatibility probe against the pinned fork before
selecting its implementation. It is not permission to replace the fork or add
a general-purpose arbitrary Bot API proxy. Preserve ordinary conversations,
pairing, debug controls, incoming files and existing private-input operations.

### Privileged builder and jobs

The personal runtime must not gain privilege indirectly by writing files,
scheduled prompts, webhook requests, or messages consumed as trusted instructions
by a privileged builder. Inventory these paths before enabling the new runtime.
Cross-identity delivery needs a constrained transport with independently
enforced target authorization. Shared writable builder state is not acceptable.
Retain occurrence identities, acceptance evidence and uncertain-work handling.
If current cross-instance behavior cannot be retained safely, report that
specific conflict before changing it; do not silently disable jobs.

## Credential behavior

Show requesting assistant, selected login/account, source vault, target website,
and purpose. Resolve ambiguity before approval. Bind the choice to the shown
item/version and revalidate before use; changed identity/site requires a new
request.

- Allow Once: privately resolve and deliver for one protected sign-in operation.
  Do not persist a destination copy. Browser cookies may remain reusable.
- Always Allow: create an independent destination Login with the intended
  username, password and website; exclude unrelated notes, attachments and
  second-factor seeds. Verify the destination before reporting success.
- Deny, timeout or cancellation: release no credential and create no copy.

Consume decisions once. Do not retry ambiguous website submissions. Reconcile
ambiguous vault writes against a stable operation identity before retrying so
callbacks, transport failures and restarts cannot create duplicate copies.
If copying succeeds but sign-in fails, report those outcomes separately.

Use the existing protected browser owner and validated origin checks for
delivery. Only status and nonsecret item references reach the model. The
credential path must never accept arbitrary executable paths, arbitrary URLs
for secret delivery, or caller-selected destination vaults outside its policy.

## Implementation sequence

1. Add OS-identity-aware service rendering, fleet configuration, and deployment
   support. Build and test installation and recovery using disposable state.
2. Resolve cross-identity jobs and the trusted Telegram transport. Prove that a
   runtime process cannot forge approvals or route work to administrative tools.
3. Implement the narrow 1Password broker and protected browser delivery. Run the
   three decisions end to end with synthetic vault items, including persistent
   copies and restart/replay cases.
4. Prepare an idempotent migration command with inventory and dry-run modes.
   Inventory selected files by role and ownership without printing secrets.
5. Rehearse migration and recovery, then perform the authorized personal-runtime
   cutover. Enabling real source vaults follows successful synthetic acceptance.

No new recurring task, general permissions framework, passkey/TOTP automation,
whole-fleet privilege redesign, or password synchronization is included.

## Migration and recovery

Record the personal session directory, workspace path, inbox, scheduler ledger,
handoffs, memory, browser profile, selected OAuth and API credentials, private
input/Tailscale setup, CLI binaries and Telegram ownership state. Account for
hardcoded absolute paths and symlinks. Keep the workspace path stable where
safe; otherwise make relocation explicit and verify references before cutover.

Quiesce all affected writers before a paired application/state checkpoint.
Copy only selected state into new private ownership; preserve the checkpoint.
Disable the old personal unit before activating the replacement, and ensure
normal deployment cannot recreate the old poller. Validate both system and
user unit management, boot activation, readiness and maintenance holds.

Before candidate startup, a failed preflight can restore the old unit against
untouched state. After candidate startup, use the existing failed-deployment
hold and reconcile accepted work. Do not restart the old unit over stale state
or apply the prototype's unconditional restart watchdog to this migration.

## Acceptance

Run tests from the actual personal-runtime UID and service context:

1. Sudo, container administration, privileged service control, administrative
   keys, broker token/config/state, and builder control channels are inaccessible.
   Attempts to change runtime executables or privileged path parents fail.
2. Wrong-user/chat/message/site/item decisions, forged IPC, expired requests,
   replay and caller-supplied approval booleans cannot release a credential.
3. All three Telegram choices work with real synthetic 1Password items and the
   protected browser. Once creates no copy; Always survives restart independently
   of source edits; Deny performs no read for delivery or destination write.
4. Credentials are absent from model-visible outputs, logs and process arguments.
5. Conversations, saved sessions, memory, jobs, supported Google/Hue/YNAB/browser
   capabilities, private input and same-workspace restarts remain functional.
   Test only configured capabilities and use reversible synthetic operations.
6. Reboot/deploy preserves the isolation and exactly one personal poller.
   Recovery rehearsals preserve inbox and scheduled-work evidence.
7. Required changed-file checks and build pass. Resolve the pre-existing pinned
   Telegram `ThinkingLevel` typecheck failure before a production rollout.

## Owning code and documentation

Likely owners: `src/service-unit.ts`, `src/install-service.ts`, fleet config and
installer modules, `src/config.ts`, `src/instances.ts`, Telegram host interfaces,
job delivery, deployment/activation/recovery scripts, credential provider and
protected browser modules. Add behavior tests at each changed boundary.

Update ARCHITECTURE, household fleet operations, browser login documentation and
ADRs when implementation establishes the new behavior. This plan does not
supersede the currently accepted runtime or recovery decisions.
