# Read-only Linux host monitoring

Use the two generic scripts described in [ADR-0056](adr/0056-read-only-linux-health-monitoring.md)
only with explicit operator authorization. They are standalone monitoring
utilities, not a bridge heartbeat adapter and not a second coordinator.

## Configuration and identity

Keep a private task manifest under the requesting instance's
`temporary/host-health/<id>/`: purpose, creation time, approved thresholds,
collector/publisher units and private data paths, source baseline, allowed
recipient/prefix, source commit/digests, maintenance procedure, and end condition.
Retire when cancelled or the monitored system is retired; do not invent expiry.

The collector configuration is root-owned and contains:

```json
{"version":1,"sourceId":"sample","mounts":{"system":{"path":"/","source":null},"data":{"path":"/mnt/data","source":"UUID=<verified-filesystem-uuid>"}},"containers":{"app":"sample-app-1"},"backupUnit":"sample-backup.service"}
```

Poll configuration supplies `sourceId`, `intervalSeconds`, private `statePath`,
read-only shared `reportPath`, and `maintenancePath`; `ssh` has a literal IP
`host`, restricted `user`, private `key`, and pinned `knownHosts`. Each `mounts`
rule has `warnPercent`, `criticalPercent`, optional `warnFreeBytes` and
`criticalFreeBytes`. `containers` maps the same logical IDs to
`{criticalDown: boolean}`. `ram` has warning/critical byte and duration thresholds;
`cpu` has warning/critical percentages, `forSeconds`, and `contentionPercent`;
`backup` has warning/critical ages in seconds. Run `validate-collect` or
`validate-poll` before installation. Linux/Python 3.10+ and Node 24 are required.

The publisher config has `version:1`, `sourceId`, `jobPrefix`, `target`, private
`statePath`, `reportPath`, and the engineering runtime's explicitly provisioned
`instanceId`, `nativeConfigPath`, and exact `nativeConfigSha256`. It extracts only
the existing `scheduleClient` and immutable resource root after verifying the pin;
it does not discover another bot's state or construct new client authority. The
release's existing client checks server UID, socket permissions and private key
ownership. List validates the currently granted namespace/target before writes.
A configured target is a notification recipient, not permission to make changes.

## Provisioning

1. Install the reviewed collector script, a fixed config, and a short root-owned
   wrapper on the monitored host. The wrapper executes a bounded timeout around
   `/usr/bin/python3 -I <installed-script> collect <fixed-config>` and accepts no
   arguments or `SSH_ORIGINAL_COMMAND`. Grant a dedicated account sudo access only
   to that wrapper with an empty argument specification. Keep its home and
   `authorized_keys` root-owned/non-writable to the account; permit reading the
   public key file. Use an authorized-key `restrict,command="..."` entry and a
   verified source-address restriction where appropriate. Never grant Docker
   group membership, generic sudo or an interactive key.
2. Provision a separate local non-login collector user and key. Verify the remote
   host fingerprint out of band; use a private pinned known-hosts file. Restrict its
   systemd process to that IP, no-new-privileges, a read-only filesystem, hidden
   personal homes, and write access only to its own state and telemetry directory.
   Set command/time/memory limits. The key/config must be read-only in the service.
3. Make the telemetry directory setgid with read/traverse access for the personal
   runtime. Its atomic report is mode 0640; state and SSH credentials are private.
   Give the publisher read access to telemetry through its *service-only* group
   selection, not broader personal-runtime group membership.
4. Install the publisher under the existing engineering UID, with a root-owned
   config and a private state directory. Hide homes except a read-only bind of the
   engineering native-config/key directory. Hide personal/broker/checkpoint roots;
   allow only Unix sockets, no-new-privileges, and writes to its own ledger only.
   It needs read/traverse access to the configured control socket directory.
5. A five-minute collector timer and one-minute publisher timer provide lightweight
   observations and freshness supervision. Healthy polls create no prompt jobs.
   These service/timer operations require authorization separately from code merge.
   Verify actual sandboxed execution, report ownership/readability, fixed host key,
   forced-command behavior and denial of direct shell/sudo/forwarding before saying
   monitoring is active. Do not modify the personal network namespace or Tailscale.
6. Test an explicitly labelled notification canary through the existing grant.
   Verify publication acceptance separately from observed user delivery. Do not
   fabricate an outage in live collector state to test a notification.

## Semantics

- Disk percentage uses non-reserved available capacity, consistent with `df`.
  A free-byte threshold is an alternative trigger, not an additional requirement.
  Missing/wrong-source mounts do not read the underlying root filesystem as data
  capacity, or clear a previously reported disk problem.
- RAM is `MemAvailable`. CPU busy time is the aggregate delta excluding idle and
  I/O wait; first samples and reboot/gap boundaries need a new baseline. CPU
  contention is the current CPU PSI `some avg60` percentage. Sustained CPU time
  includes the measured interval; other conditions use point observations.
- Noncritical stopped/missing/unhealthy containers require two consecutive checks.
  `criticalDown` means immediate critical when not running. A container without a
  healthcheck is not called unhealthy merely for lacking one.
- Backup age uses systemd's successful oneshot completion message, not a start
  request or an attempted-but-failed run. No retained success is unknown/warning.
  The selected unit must be an actual oneshot backup, not a long-running daemon.
- Collection failure preserves unresolved incidents; timing gaps reset unconfirmed
  sustained windows. Existing incidents remain active while the underlying
  predicate still matches. Recovery requires positive evidence, not timeout.
- Reports older than twice the configured collection interval are unavailable.
  Missing, malformed or future-dated reports also fail closed. Duplicate unchanged
  severities do not publish additional jobs; details may update without alerting.

## Maintenance and retirement

Atomically write the private maintenance file as
`{"version":1,"until":<UTC epoch seconds>,"reason":"<operator reason>"}`.
The deadline must be at most 24 hours ahead; `until:0` ends maintenance. Collection
continues. Both evaluator and publisher suppress notices inside the window and
report remaining problems after it expires. Maintenance is explicit, never
inferred from a broken service. A complete self-outage cannot notify until some
independent monitoring path is available.

On cancellation, disable/stop both dedicated timers/services, inspect any
uncertain publication intents, and remove only their exact owned outstanding
schedule definitions through the delegated helper with fresh revisions. Revoke
the monitor's remote SSH key; retain receipts and retire the private task manifest.
Do not delete general engineering schedule credentials or other jobs, wipe
occurrence history, restore old snapshots, or remove shared accounts automatically.

The publication ledger records **accepted**, not delivered. A `started` or
`remove-started` intent with uncertain outcome requires exact job inspection and
operator reconciliation. Do not delete the ledger or generate a new identity to
silently replay it. Unit logs intentionally omit provider output and secrets.
