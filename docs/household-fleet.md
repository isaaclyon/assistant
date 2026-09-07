# Household bot fleet

The fleet runs Isaac Bot, Emma Bot, Shared Bot, and Builder Bot from one exact
immutable release. Each instance has a distinct Telegram profile, workspace,
session tree, durable inbox, runtime metadata file, credential environment, and
systemd service. Capabilities remain centralized in the reviewed release at
`.pi/capabilities.json`; an instance selects a profile but cannot discover
global or workspace-local extensions and skills.

The tracked [example manifest](examples/instances.example.json) is illustrative.
Production identity values live only in
`~/.config/pi-telegram-bridge/instances.json`, mode `0600`. Never commit real
Telegram user IDs, the household group ID, bot tokens, or credential values.

To grant a capability, Builder edits the central resource entry/profile in a
worktree, adds tests, runs `npm run check` and `npm run build`, then takes the
change through review, merge, and normal deployment. `/reload` may refresh the
active profile only after that release is deployed; it never reads the builder
worktree. A capability profile does not grant credentials—its instance
environment must independently contain the allowed scoped key.

## Security model

| Instance | Telegram surface | Memory | Credentials | Intended capabilities |
| --- | --- | --- | --- | --- |
| `isaac` | private chat | Isaac-personal + household | Isaac-personal + household | personal assistant |
| `emma` | private chat | Emma-personal + household | Emma-personal + household | personal assistant |
| `shared` | one exact group, two exact actors | household only | household only | shared assistant |
| `builder` | private chat | none | engineering only | capability/code maintenance |

These are semantic enforcement boundaries, not operating-system sandboxes. All
processes run as the same Unix user. The host enforces the manifest invariants,
loads only the selected release-local resources, injects the trusted principal
and memory view, and validates credential key namespaces before startup.
Unauthorized group updates are rejected in the Telegram transport before Pi
sees content. The shared prompt and replay records attribute accepted messages
to stable `Isaac` or `Emma` labels.

`/restart`, `/reload`, model controls, and ordinary commands are available to
either configured spouse on Shared Bot. `/new` affects both spouses' shared
conversation, so it requires an inline confirmation and rechecks readiness at
confirmation time. Builder-only skills are absent from personal and household
capability profiles.

## First-time configuration

1. Create four bots with BotFather. For Shared Bot, disable privacy mode so the
   bot receives ordinary group messages. Add only Isaac, Emma, and Shared Bot to
   the group; do not make the bot an administrator unless a future feature
   specifically requires it.
2. In a one-time interactive Pi session, run `/telegram-setup isaac`,
   `/telegram-setup emma`, `/telegram-setup shared`, and
   `/telegram-setup builder`. Tokens remain in the private Pi Telegram config;
   do not place them in the instance manifest or per-instance environment.
3. Obtain the exact negative group chat ID and the two positive Telegram user
   IDs through a trusted diagnostic, then place them in the private manifest.
   A migrated group/supergroup ID must be updated explicitly; the transport
   fails closed on any other chat or actor.
4. Create each absolute `workspaceCwd`. These paths hold mutable working state
   and may be separate Git worktrees. They are not capability roots: extension,
   skill, and instruction code always comes from the shared immutable release.
5. Create one environment file per instance at
   `~/.config/pi-telegram-bridge/instances/<id>.env`, owned by the service user
   and mode `0600`. Every file must declare the exact scope:

   ```text
   PI_TELEGRAM_CREDENTIAL_SCOPE=isaac-personal
   PI_TELEGRAM_BRIDGE_WEBHOOK_PORT=0
   PI_TELEGRAM_SESSION_IDLE_HOURS=8
   PI_CREDENTIAL_ISAAC_EXAMPLE=replace-through-a-secret-manager
   PI_CREDENTIAL_HOUSEHOLD_EXAMPLE=replace-through-a-secret-manager
   ```

   Emma files may contain only `PI_CREDENTIAL_EMMA_*` and
   `PI_CREDENTIAL_HOUSEHOLD_*`; shared files only
   `PI_CREDENTIAL_HOUSEHOLD_*`; builder files only
   `PI_CREDENTIAL_ENGINEERING_*`. Optional operational keys are the webhook
   host/port, memory path/auto-commit settings, and human-idle session timeout.
   Validation reports key names, never values.

   Port `0` requests an ephemeral listener and may be reused. Any fixed
   host/port pair must be unique across the fleet; preflight rejects collisions.
6. Copy the example manifest to the external path, replace every placeholder,
   make all paths absolute, and set mode `0600`. Instance IDs, Telegram
   profiles, and workspaces must be unique; an installable fleet must have
   exactly one jobs coordinator.

Credential rotation is file replacement followed by fleet deployment or a
targeted service restart. Write a new mode-`0600` file atomically, run preflight,
restart only the affected instance, and verify its exact runtime metadata. Keep
the prior value available in the secret manager until the smoke test succeeds.

## Inactivity-based session rotation

Rotation is disabled by default. To enable an eight-hour human-idle boundary for
one instance, atomically add `PI_TELEGRAM_SESSION_IDLE_HOURS=8` to that
instance's mode-`0600` environment file, restart only that service, and verify
the journal reports rotation enabled with the bounded duration. Values may be
positive finite hours up to 8,760; malformed, negative, non-finite, and larger
values fail startup.

The timeout is evaluated only when a Telegram prompt or scheduled job is ready.
No timer creates an empty session. Jobs can trigger one rotation but never move
the human-idle clock; a later human follow-up stays in that fresh session and
starts the next interval. Rotation is silent and copies no summary. Pi's normal
token compaction remains independent.

To disable or roll back, remove the setting or set it to `0`, atomically replace
the environment file, restart that instance, and verify the journal reports
rotation disabled. Do not delete `conversation-session-state.json`; it is inert
while disabled and preserves a safe epoch if the setting is re-enabled. If
startup reports malformed policy state, leave the durable inbox untouched,
inspect and restore the state file from a trusted backup (or move it aside only
after accepting a new baseline), then restart. Historical Pi session files need
no migration or cleanup.

## State migration

The compatibility singleton remains supported when no manifest exists. Before
the first fleet activation, stop normal writes and copy its legacy state into
the chosen continuity instance (normally `isaac`) with
`migrateLegacyStateToInstance` from `src/state-migration.ts`. Migration is
copy-only: it rejects unknown entries and symlinks, stages under
`instances/.<id>.migrating`, hardens permissions, and atomically renames the
result. It never deletes legacy state.

After migration, inspect the copied entry list and session continuity before
enabling the manifest. If migration fails, remove only the explicitly reported
staging directory after inspection and retry; the source remains untouched.
Legacy memory notes without a scope are conservatively Isaac-personal, never
household. Promote a note only through a confirmed, revision-checked update.

Scheduled jobs version 3 require a stable `target` instance ID. Use
`both-personal` only for intentional Isaac+Emma fan-out. One coordinator owns
triggers; targets receive durable, idempotent handoff files. An uncertain file
left in `processing` is surfaced for operator review rather than silently
replayed.

## Preflight and activation

Build and test the candidate release first. Then set the external paths and
full candidate SHA and run the sanitized preflight:

```bash
export PI_TELEGRAM_BRIDGE_INSTANCE_MANIFEST="$HOME/.config/pi-telegram-bridge/instances.json"
export PI_TELEGRAM_BRIDGE_CONFIG_ROOT="$HOME/.config/pi-telegram-bridge"
export PI_TELEGRAM_BRIDGE_STATE_ROOT="$HOME/.local/state/pi-telegram-bridge"
export PI_TELEGRAM_BRIDGE_RESOURCE_ROOT="/absolute/path/to/immutable/release"
export PI_TELEGRAM_BRIDGE_RELEASE_SHA="<full-40-character-sha>"
node /absolute/path/to/immutable/release/dist/src/fleet-preflight.js
```

Successful output contains only instance IDs and the coordinator ID. Activation
builds once and validates jobs, then disables/stops all discovered bridge units,
including retired and singleton units. It verifies quiescence, snapshots state
and previous application binaries, and performs offline job migration before
installing private units and starting instances sequentially. Each must report
`ready` for the exact instance ID, release SHA, and stable systemd PID for five
seconds. Failure holds services disabled for explicit recovery, never unit-only
rollback. Workspaces and builder worktrees are not cleaned.

Activation uses each unit's bounded graceful shutdown. Accepted turns already
in the durable inbox replay after restart; a model response interrupted after
Pi took ownership may need to be re-asked because outbound delivery is not
durable. The singleton is disabled (not merely stopped) before fleet success so
it cannot reappear on reboot. A retained maintenance marker also blocks new
units on reboot until activation has fully committed.

Normal merged deployment automatically chooses fleet activation when the
private manifest exists. For diagnosis:

```bash
systemctl --user status 'pi-telegram-bridge-*.service'
journalctl --user -u 'pi-telegram-bridge-*.service' --since today
```

`<stateRoot>/instances/<id>/runtime.json` is the machine-readable readiness
record. It is mode `0600` and includes no credential values.

## Recovery checkpoints and failure holds

Before rollout, pause external state editors and manual memory/job/recovery
commands, verify enough free disk for a full state copy plus the previous
immutable releases, and keep the previous Node executable installed. Services
remain unavailable during copying and migration. The checkpoint does not copy
Node itself, external credentials, or canonical memory outside the state tree;
the offline migration does not change those resources.

`<stateRoot>/.recovery-maintenance` is private JSON pointing to a checkpoint under
`~/.local/share/pi-telegram-bridge/recovery-backups/checkpoint-*/snapshot`.
Checkpoints contain private session/job data and must never be uploaded or
printed. They are not automatically pruned. The sibling
`previous-unit-status.txt` records prior enablement and active state; the
snapshot retains only bridge unit files, not unrelated systemd units.

The initial job migration accepts only a complete terminal legacy handoff graph.
It preserves old files byte-for-byte and refuses pending, processing, failed,
missing, conflicting, unsafe, or malformed evidence. Resolve pending work under
the old protocol or retire it explicitly; inspect uncertain session evidence
before any explicit acknowledgement or retry. Do not rename uncertain work to
pending merely to pass migration. Exact current one-shot terminal evidence can
seed suppression without fabricating an occurrence. A legacy `fired[id]` alone
is insufficient; a reused ID or changed definition requires operator resolution.
Additional coordinator roots and singleton-to-fleet job-state relocation also
require explicit reconciliation rather than silent copying.

On failure, leave the fleet stopped and disabled. Do not delete the maintenance
marker, a ledger, or recipient files to make deployment pass. Find the private
snapshot path without exposing its contents:

```bash
SNAPSHOT="$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).snapshotDir)' \
  "$PI_TELEGRAM_BRIDGE_STATE_ROOT/.recovery-maintenance")"
```

- **Before candidate startup:** if the snapshot has a complete `snapshot.json`
  and no `candidate-started` file, restore it with the candidate release's
  `node dist/src/recovery-maintenance.js restore "$SNAPSHOT"`. The command
  independently requires all bridge units stopped and disabled, verifies backup
  digests before changing destinations, restores state and matching application
  binaries/units, and verifies the restored digests. It preserves the deploy
  lock inode and maintenance marker, does not start services, and can retry an
  interrupted restore from the same untouched checkpoint. Run `systemctl --user
  daemon-reload`, verify the restored release and state, then explicitly clear
  the hold and restore only the enablement/active states recorded in the sibling
  status file. Retain the checkpoint until recovery is verified.
- **After candidate startup may have occurred:** `candidate-started` permanently
  forbids automatic restore. Preserve all new acceptance/session evidence;
  reconcile with an operator or roll forward. Rewinding the snapshot could
  duplicate accepted work. Never delete the barrier to authorize a rewind.
- **Incomplete snapshot:** no `snapshot.json` means the copy never committed.
  Do not restore it. Migration and candidate startup follow snapshot commit;
  inspect the exact failure and unchanged source before explicitly recovering
  prior services. Keep the failed checkpoint for diagnosis.

Generated service units use `ExecCondition` with `recovery-start-check.js`.
During candidate startup, a one-use-per-deployment authorization is supplied
through the user manager's volatile environment. Deployment revokes it before
enabling units and removes/synchronizes the hold only after every instance is
ready and enabled. On reboot the manager authorization disappears, so a partial
enable sequence cannot start through a surviving hold. An unexpected deployment
process kill still requires operator inspection: already-running candidates may
have accepted work, and the startup barrier must remain authoritative.

Before the first production transition, perform a disposable **non-bridge**
user-unit smoke test on the target systemd version, using synthetic private
state and an `ExecStart` that only creates a temporary marker file. Verify:

1. With a maintenance hold and no matching manager authorization, condition exit
   `1` skips the unit; no marker file appears and `NRestarts` remains zero even
   with `Restart=on-failure`.
2. Matching manager authorization permits that harmless start.
3. After `systemctl --user unset-environment
   PI_TELEGRAM_RECOVERY_AUTHORIZATION`, a subsequent start is skipped again.
4. Removing the synthetic hold permits normal startup. Remove the disposable
   unit/state and reload the manager afterward; never print manager environment
   contents or touch live bridge units during this smoke test.

Local fake-systemd tests do not replace this platform check or the live smoke
matrix below. Retain checkpoint copies until production verification completes;
then remove only explicitly selected obsolete checkpoints, never the checkpoint
referenced by an unresolved hold.

## Live smoke test

Perform all checks after the four services are ready on the same release SHA:

- Message Isaac Bot privately; confirm only Isaac's workspace/session changes.
- Message Emma Bot privately; confirm only Emma's workspace/session changes.
- In the household group, send one message as each spouse and verify stable
  actor attribution and one shared conversation.
- From a third Telegram account and from a different group, attempt a message;
  verify the update is rejected and absent from Pi session history.
- Restart Shared Bot with an accepted message durably queued and verify replay
  preserves target and actor attribution without duplicate execution.
- Use `/new` in the group, cancel once, then confirm once; verify cancel is
  side-effect-free and confirmation replaces only the shared session.
- Use `/restart` as each spouse and verify authority and post-restart
  acknowledgement.
- Add one personal memory for each spouse and one household memory. Verify each
  personal bot sees its own personal note plus household, Shared Bot sees only
  household, and Builder Bot sees no memory.
- Exercise one allowed credential-backed skill per scope and verify no instance
  can address a key outside its namespace.
- Dispatch a job to one personal target and one `both-personal` job; verify the
  coordinator records each recipient once.
- Verify all four `runtime.json` files still name the exact deployed release
  and current stable systemd PID.

Do not declare rollout complete from service status alone. Record the release
SHA, timestamp, operator, and each smoke result. On any isolation failure, stop
the affected fleet; preserve state and follow the recovery barrier above. Do not
restore old units alone over state that a candidate may have changed.
