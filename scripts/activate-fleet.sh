#!/usr/bin/env bash
# Activate one prebuilt immutable release across the statically configured fleet.
set -Eeuo pipefail

EXPECTED_SHA="${1:?expected release SHA}"
RELEASE_PATH="${2:?release path}"
NODE_BINARY="${3:?node executable}"

CONFIG_ROOT="${PI_TELEGRAM_BRIDGE_CONFIG_ROOT:-$HOME/.config/pi-telegram-bridge}"
STATE_ROOT="${PI_TELEGRAM_BRIDGE_STATE_ROOT:-$HOME/.local/state/pi-telegram-bridge}"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
MANIFEST_PATH="${PI_TELEGRAM_BRIDGE_INSTANCE_MANIFEST:-$CONFIG_ROOT/instances.json}"
UNIT_DIR="$HOME/.config/systemd/user"
ACTIVATION_STARTED=false
source "$RELEASE_PATH/scripts/recovery-maintenance.sh"

if [[ ! "$EXPECTED_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Fleet activation requires a full release SHA." >&2
  exit 2
fi

export PI_CODING_AGENT_DIR="$AGENT_DIR"
export PI_TELEGRAM_BRIDGE_CONFIG_ROOT="$CONFIG_ROOT"
export PI_TELEGRAM_BRIDGE_STATE_ROOT="$STATE_ROOT"
export PI_TELEGRAM_BRIDGE_INSTANCE_MANIFEST="$MANIFEST_PATH"
export PI_TELEGRAM_BRIDGE_RESOURCE_ROOT="$RELEASE_PATH"
export PI_TELEGRAM_BRIDGE_RELEASE_SHA="$EXPECTED_SHA"

PREFLIGHT_JSON="$($NODE_BINARY "$RELEASE_PATH/dist/src/fleet-preflight.js")"
mapfile -t INSTANCE_IDS < <(
  "$NODE_BINARY" -e '
    const value = JSON.parse(process.argv[1]);
    for (const id of value.instanceIds) console.log(id);
  ' "$PREFLIGHT_JSON"
)
COORDINATOR_ID="$($NODE_BINARY -e '
  const value = JSON.parse(process.argv[1]);
  if (value.coordinatorId) process.stdout.write(value.coordinatorId);
' "$PREFLIGHT_JSON")"

if (( ${#INSTANCE_IDS[@]} == 0 )); then
  echo "Fleet preflight returned no configured instances." >&2
  exit 1
fi

wait_for_instance_ready() {
  local instance_id="$1"
  local expected_sha="$2"
  local service="pi-telegram-bridge-$instance_id.service"
  local metadata="$STATE_ROOT/instances/$instance_id/runtime.json"
  local stable_seconds=0
  local ready_pid=""
  local state main_pid
  for _ in {1..30}; do
    state="$(systemctl --user is-active "$service" || true)"
    main_pid="$(systemctl --user show "$service" --property MainPID --value)"
    if [[ "$state" == "active" && "$main_pid" =~ ^[1-9][0-9]*$ ]] && \
      "$NODE_BINARY" "$RELEASE_PATH/dist/src/readiness-check.js" \
        "$metadata" "$instance_id" "$expected_sha" "$main_pid"; then
      if [[ "$main_pid" != "$ready_pid" ]]; then
        ready_pid="$main_pid"
        stable_seconds=0
      fi
      ((stable_seconds += 1))
      if (( stable_seconds >= 5 )); then
        printf '%s\n' "$main_pid"
        return 0
      fi
    else
      ready_pid=""
      stable_seconds=0
    fi
    sleep 1
  done
  return 1
}

rollback_fleet() {
  local original_status=$?
  trap - ERR
  if [[ "$ACTIVATION_STARTED" == true ]]; then
    recovery_hold
  fi
  exit "$original_status"
}
trap rollback_fleet ERR

echo "==> Fleet preflight passed for ${#INSTANCE_IDS[@]} instance(s)"
if [[ -n "$COORDINATOR_ID" ]]; then
  echo "==> Validating scheduled jobs through coordinator $COORDINATOR_ID"
  systemd-run --user --wait --pipe --quiet --collect \
    --property="EnvironmentFile=-$CONFIG_ROOT/instances/$COORDINATOR_ID.env" \
    --setenv="PI_CODING_AGENT_DIR=$AGENT_DIR" \
    --setenv="PI_TELEGRAM_BRIDGE_INSTANCE_MANIFEST=$MANIFEST_PATH" \
    --setenv="PI_TELEGRAM_BRIDGE_INSTANCE_ID=$COORDINATOR_ID" \
    --setenv="PI_TELEGRAM_BRIDGE_RESOURCE_ROOT=$RELEASE_PATH" \
    --setenv="PI_TELEGRAM_BRIDGE_RELEASE_SHA=$EXPECTED_SHA" \
    --setenv="PI_TELEGRAM_BRIDGE_STATE_ROOT=$STATE_ROOT" \
    --setenv="PI_TELEGRAM_BRIDGE_CONFIG_ROOT=$CONFIG_ROOT" \
    "$NODE_BINARY" "$RELEASE_PATH/dist/src/jobs-check.js"
fi

ACTIVATION_STARTED=true
recovery_prepare "$COORDINATOR_ID" "${INSTANCE_IDS[@]}"
for instance_id in "${INSTANCE_IDS[@]}"; do
  RECOVERY_UNITS+=("pi-telegram-bridge-$instance_id.service")
done
PI_TELEGRAM_BRIDGE_INSTALL_NO_START=1 \
  "$NODE_BINARY" "$RELEASE_PATH/dist/src/install-service.js"

recovery_started
for instance_id in "${INSTANCE_IDS[@]}"; do
  service="pi-telegram-bridge-$instance_id.service"
  echo "==> Activating $service at $EXPECTED_SHA"
  systemctl --user restart "$service"
  if ! ready_pid="$(wait_for_instance_ready "$instance_id" "$EXPECTED_SHA")"; then
    echo "$service did not become stable and ready on $EXPECTED_SHA." >&2
    false
  fi
  echo "==> $service ready at PID $ready_pid"
done

recovery_revoke_startup
for instance_id in "${INSTANCE_IDS[@]}"; do
  systemctl --user enable "pi-telegram-bridge-$instance_id.service"
done
recovery_complete
ACTIVATION_STARTED=false
trap - ERR
echo "==> Fleet activation complete: ${INSTANCE_IDS[*]}"
