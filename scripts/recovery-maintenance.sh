#!/usr/bin/env bash
# Sourced by deployment. All writers must stay paused until activation completes.
# Required caller variables: NODE_BINARY RELEASE_PATH STATE_ROOT UNIT_DIR.
RECOVERY_UNITS=()
BACKUP_DIR=""

recovery_prepare() {
  local coordinator_id="$1"
  shift
  local listed_units unit state pid
  local backup_parent="$HOME/.local/share/pi-telegram-bridge/recovery-backups"
  umask 077
  mkdir -p "$STATE_ROOT" "$UNIT_DIR" "$backup_parent"
  if [[ -e "$STATE_ROOT/.recovery-maintenance" || -L "$STATE_ROOT/.recovery-maintenance" ]]; then
    echo "Unresolved recovery maintenance blocks deployment; inspect the retained checkpoint." >&2
    return 1
  fi
  # Include retired, disabled, loaded, and compatibility services, not just the new manifest.
  listed_units="$(systemctl --user list-unit-files --no-legend 'pi-telegram-bridge*.service')"
  listed_units+=$'\n'"$(systemctl --user list-units --all --no-legend --plain 'pi-telegram-bridge*.service')"
  mapfile -t RECOVERY_UNITS < <(printf '%s\n' "$listed_units" | awk '{print $1}' | \
    grep -E '^pi-telegram-bridge(-[a-z0-9-]+)?\.service$' | sort -u)
  local checkpoint
  checkpoint="$(mktemp -d "$backup_parent/checkpoint-XXXXXXXX")"
  BACKUP_DIR="$checkpoint/snapshot"
  "$NODE_BINARY" -e '
    const fs = require("node:fs");
    const fd = fs.openSync(process.argv[1], "wx", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify({version: 1, snapshotDir: process.argv[2], authorization: require("node:crypto").randomUUID()}) + "\n");
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    const dir = fs.openSync(require("node:path").dirname(process.argv[1]), "r");
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  ' "$STATE_ROOT/.recovery-maintenance" "$BACKUP_DIR"
  for unit in "${RECOVERY_UNITS[@]}"; do
    printf '%s %s %s\n' "$unit" \
      "$(systemctl --user is-enabled "$unit" || true)" \
      "$(systemctl --user is-active "$unit" || true)" >> "$checkpoint/previous-unit-status.txt"
  done
  # Disabled units cannot come back on reboot after an interrupted migration.
  for unit in "${RECOVERY_UNITS[@]}"; do systemctl --user disable --now "$unit"; done
  for unit in "${RECOVERY_UNITS[@]}"; do
    state="$(systemctl --user show "$unit" --property ActiveState --value)"
    pid="$(systemctl --user show "$unit" --property MainPID --value)"
    if [[ "$pid" != 0 || ( "$state" != inactive && "$state" != failed ) ]]; then
      echo "Bridge quiescence failed; do not migrate or start a candidate." >&2
      return 1
    fi
  done
  if [[ "$coordinator_id" == local && "$#" == 0 ]]; then
    # Match the singleton's actual EnvironmentFile, never snapshot a guessed root.
    systemd-run --user --wait --pipe --quiet --collect \
      --property="EnvironmentFile=-$HOME/.config/pi-telegram-bridge/environment" \
      --setenv="PI_TELEGRAM_BRIDGE_STATE_DIR=$STATE_ROOT" \
      "$NODE_BINARY" "$RELEASE_PATH/dist/src/recovery-maintenance.js" prepare \
      "$BACKUP_DIR" "$STATE_ROOT" "$UNIT_DIR" \
      "$HOME/.local/share/pi-telegram-bridge/releases" local
  else
    "$NODE_BINARY" "$RELEASE_PATH/dist/src/recovery-maintenance.js" prepare \
      "$BACKUP_DIR" "$STATE_ROOT" "$UNIT_DIR" \
      "$HOME/.local/share/pi-telegram-bridge/releases" "$coordinator_id" "$@"
  fi
}

recovery_started() {
  "$NODE_BINARY" "$RELEASE_PATH/dist/src/recovery-maintenance.js" started "$BACKUP_DIR"
  local authorization
  authorization="$("$NODE_BINARY" -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).authorization)' "$STATE_ROOT/.recovery-maintenance")"
  systemctl --user set-environment "PI_TELEGRAM_RECOVERY_AUTHORIZATION=$authorization"
}

recovery_revoke_startup() {
  # The manager environment is volatile. Reboot also revokes this authorization.
  systemctl --user unset-environment PI_TELEGRAM_RECOVERY_AUTHORIZATION
}

recovery_hold() {
  local unit failed=false
  recovery_revoke_startup || failed=true
  for unit in "${RECOVERY_UNITS[@]}"; do
    systemctl --user disable --now "$unit" || failed=true
  done
  echo "Recovery activation failed. Units remain disabled; preserve state and the retained snapshot. No binary-only rollback was attempted." >&2
  [[ "$failed" == false ]] || echo "CRITICAL: could not stop every bridge unit; manual intervention is required." >&2
}

recovery_complete() {
  # Keep the paired snapshot and startup barrier permanently; remove only the deployment hold.
  "$NODE_BINARY" -e '
    const fs = require("node:fs"); const path = process.argv[1]; fs.unlinkSync(path);
    const fd = fs.openSync(require("node:path").dirname(path), "r");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  ' "$STATE_ROOT/.recovery-maintenance"
}
