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
   PI_CREDENTIAL_ISAAC_EXAMPLE=replace-through-a-secret-manager
   PI_CREDENTIAL_HOUSEHOLD_EXAMPLE=replace-through-a-secret-manager
   ```

   Emma files may contain only `PI_CREDENTIAL_EMMA_*` and
   `PI_CREDENTIAL_HOUSEHOLD_*`; shared files only
   `PI_CREDENTIAL_HOUSEHOLD_*`; builder files only
   `PI_CREDENTIAL_ENGINEERING_*`. Optional operational keys are the webhook
   host/port and memory path/auto-commit settings. Validation reports key names,
   never values.

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
builds once, installs all private units, validates jobs, stops the singleton,
then starts instances sequentially. Each must report `ready` for the exact
instance ID, release SHA, and stable systemd PID for five seconds. Any failure
rolls every changed unit back; state, workspaces, and builder worktrees are not
cleaned.

Activation uses each unit's bounded graceful shutdown. Accepted turns already
in the durable inbox replay after restart; a model response interrupted after
Pi took ownership may need to be re-asked because outbound delivery is not
durable. The singleton is disabled (not merely stopped) before fleet success so
it cannot reappear on reboot. Rollback restores and re-enables it when it was
the previous deployment.

Normal merged deployment automatically chooses fleet activation when the
private manifest exists. For diagnosis:

```bash
systemctl --user status 'pi-telegram-bridge-*.service'
journalctl --user -u 'pi-telegram-bridge-*.service' --since today
```

`<stateRoot>/instances/<id>/runtime.json` is the machine-readable readiness
record. It is mode `0600` and includes no credential values.

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
the affected fleet and restore the backed-up units; preserve state for audit.
