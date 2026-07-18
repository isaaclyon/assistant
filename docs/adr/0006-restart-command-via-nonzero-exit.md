---
status: accepted
---

# Restart the bridge from Telegram via a graceful non-zero exit

## Context

Operators need to restart the running bridge from inside Telegram (for example,
to bring the process back on a freshly deployed release) without SSHing in to run
`systemctl --user restart`. Pi already ships a built-in `/reload` slash command,
but it hot-reloads skills/extensions in-process and does not restart the process.

The systemd unit supervises the bridge with `Restart=on-failure`
(`src/service-unit.ts`). The daemon exits cleanly (code 0) on shutdown, which
systemd treats as success and does not restart — so an ordinary clean shutdown
cannot express "restart me."

## Decision

Add a repo-local `/restart` command (`.pi/extensions/restart.ts`), named to avoid
colliding with the built-in `/reload` and to name its behavior accurately. It is
registered through the fork's Telegram command registry (via the shared
`registerReloadSafeTelegramCommand` helper in `.pi/lib/telegram-command.ts`) with
`showInMenu`, so it is dispatched at the Telegram routing layer and listed in the
bot's `/` autocomplete menu — unlike `pi.registerCommand`, whose commands only
reach Pi as a forwarded turn and never appear in `setMyCommands`. That registry is
process-global and survives Pi's `/reload` (which re-runs extension factories), so
the helper stashes its unbind on a global symbol and clears the prior registration
before re-registering. The command signals the daemon through a
separate process-local capability published on a
shared global symbol (`bindBridgeRestart` in `src/telegram-capabilities.ts`),
mirroring the existing fork capability seam. The host defers the trigger to
`waitForIdle` so disposal never races an in-flight turn, then requests shutdown
with the reason `"restart"`. The daemon disposes gracefully (releasing the
Telegram ownership lock and closing the inbox) and, for that reason only, exits
with `RESTART_EXIT_CODE` (75), so `Restart=on-failure` brings the process back on
the current release with session continuity preserved.

## Consequences

- `/restart` restarts the process cleanly; it does not pull or build new host
  `src/`. Picking up new host source still requires `npm run deploy`, which builds
  a new release, repoints the unit, and restarts on its own.
- The bridge's restart path now depends on `Restart=on-failure`; changing that
  systemd policy would break `/restart`.
- A restart appears in the journal as a code-75 exit followed by a systemd
  restart — expected, not a fault.
- Shelling out to `systemctl --user restart` from the command was rejected: it
  hardcodes the unit name, is Linux/systemd-only, and risks the restart job being
  killed with the service's cgroup.
