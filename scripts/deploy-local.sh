#!/usr/bin/env bash
# Deploy one already-merged revision from a self-hosted GitHub Actions runner.
set -Eeuo pipefail

EXPECTED_SHA="${1:-}"
DEPLOY_PATH="${DEPLOY_PATH:-$HOME/projects/assistant}"
SERVICE="pi-telegram-bridge.service"
UNIT_PATH="$HOME/.config/systemd/user/$SERVICE"
RELEASE_ROOT="$HOME/.local/share/pi-telegram-bridge/releases"
RELEASE_PATH="$RELEASE_ROOT/$EXPECTED_SHA"
STAGING_PATH="$RELEASE_ROOT/.staging-$EXPECTED_SHA"
LOCK_PATH="$HOME/.local/state/pi-telegram-bridge/deploy.lock"
UNIT_BACKUP=""
ACTIVATION_STARTED=false
CURRENT_SHA=""

if [[ ! "$EXPECTED_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Expected a full 40-character git commit SHA." >&2
  exit 2
fi

wait_for_service_ready() {
  local since="$1"
  local stable_seconds=0
  local ready_pid=""
  local state main_pid
  for _ in {1..30}; do
    state="$(systemctl --user is-active "$SERVICE" || true)"
    main_pid="$(systemctl --user show "$SERVICE" --property MainPID --value)"
    if [[ "$state" == "active" && "$main_pid" =~ ^[1-9][0-9]*$ ]]; then
      if [[ "$main_pid" != "$ready_pid" ]]; then
        ready_pid="$main_pid"
        stable_seconds=0
      fi
      if journalctl --user -u "$SERVICE" "_PID=$main_pid" \
        --since "$since" --no-pager -o cat \
        | grep -F "Pi Telegram bridge ready" >/dev/null; then
        ((stable_seconds += 1))
        if (( stable_seconds >= 5 )); then
          printf '%s\n' "$main_pid"
          return 0
        fi
      else
        stable_seconds=0
      fi
    else
      ready_pid=""
      stable_seconds=0
    fi
    sleep 1
  done
  return 1
}

show_failure_context() {
  local original_status=$?
  trap - ERR
  rm -rf "$STAGING_PATH"
  if [[ "$ACTIVATION_STARTED" == true && -n "$UNIT_BACKUP" && -f "$UNIT_BACKUP" ]]; then
    echo "==> Restoring the previous service unit" >&2
    if [[ -n "$CURRENT_SHA" ]]; then
      git -C "$DEPLOY_PATH" reset --hard "$CURRENT_SHA" || true
    fi
    cp "$UNIT_BACKUP" "$UNIT_PATH"
    rollback_time="$(date --iso-8601=seconds)"
    rollback_ok=false
    if systemctl --user daemon-reload && systemctl --user restart "$SERVICE"; then
      if rollback_pid="$(wait_for_service_ready "$rollback_time")"; then
        rollback_ok=true
        echo "==> Previous release restored, PID $rollback_pid" >&2
      fi
    fi
    if [[ "$rollback_ok" != true ]]; then
      echo "CRITICAL: previous release did not recover after rollback." >&2
    fi
    rm -f "$UNIT_BACKUP"
  fi
  echo "==> Deployment failed; service status follows" >&2
  systemctl --user status "$SERVICE" --no-pager >&2 || true
  exit "$original_status"
}
trap show_failure_context ERR

mkdir -p "$(dirname "$LOCK_PATH")" "$RELEASE_ROOT"
exec 9>"$LOCK_PATH"
if ! flock -w 900 9; then
  echo "Timed out waiting for another deployment to finish." >&2
  exit 1
fi

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [[ -s "$NVM_DIR/nvm.sh" ]]; then
  # shellcheck disable=SC1090
  source "$NVM_DIR/nvm.sh"
fi

command -v node >/dev/null 2>&1 || {
  echo "Node.js is not available on the deployment runner." >&2
  exit 1
}
NODE_BINARY="$(command -v node)"
node -e 'if (Number(process.versions.node.split(".")[0]) !== 24) process.exit(1)' || {
  echo "Node.js 24 is required to match CI; found $(node --version)." >&2
  exit 1
}

cd "$DEPLOY_PATH"
echo "==> Fetching merged revision $EXPECTED_SHA"
git fetch --prune origin main
REMOTE_SHA="$(git rev-parse origin/main)"
if ! git merge-base --is-ancestor "$EXPECTED_SHA" "$REMOTE_SHA"; then
  echo "Requested revision $EXPECTED_SHA is not on origin/main." >&2
  exit 1
fi
CURRENT_SHA="$(git rev-parse HEAD)"
if [[ "$CURRENT_SHA" != "$EXPECTED_SHA" ]] && \
  git merge-base --is-ancestor "$EXPECTED_SHA" "$CURRENT_SHA"; then
  echo "==> Revision $EXPECTED_SHA was already superseded by deployed $CURRENT_SHA"
  trap - ERR
  exit 0
fi
if ! git merge-base --is-ancestor "$CURRENT_SHA" "$EXPECTED_SHA"; then
  echo "Refusing non-fast-forward deployment from $CURRENT_SHA to $EXPECTED_SHA." >&2
  exit 1
fi

if [[ ! -f "$RELEASE_PATH/dist/src/daemon.js" ]]; then
  echo "==> Building immutable release $RELEASE_PATH"
  rm -rf "$STAGING_PATH"
  mkdir -p "$STAGING_PATH"
  git archive "$EXPECTED_SHA" | tar -x -C "$STAGING_PATH"
  (
    cd "$STAGING_PATH"
    npm ci --no-audit --no-fund
    npm run build
  )
  rm -rf "$RELEASE_PATH"
  mv "$STAGING_PATH" "$RELEASE_PATH"
fi

# The canonical checkout remains the agent cwd and source of repo-local
# capabilities. Build artifacts and dependencies live in the immutable release.
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "Canonical checkout has tracked edits; refusing to discard live agent work." >&2
  exit 1
fi

echo "==> Validating scheduled jobs against the new release"
systemd-run --user --wait --pipe --quiet --collect \
  --property="EnvironmentFile=-$HOME/.config/pi-telegram-bridge/environment" \
  --setenv="PI_TELEGRAM_BRIDGE_CWD=$DEPLOY_PATH" \
  "$NODE_BINARY" "$RELEASE_PATH/dist/src/jobs-check.js"

if [[ -f "$UNIT_PATH" ]]; then
  UNIT_BACKUP="$(mktemp)"
  cp "$UNIT_PATH" "$UNIT_BACKUP"
fi

echo "==> Activating $SERVICE"
ACTIVATION_STARTED=true
ACTIVATION_TIME="$(date --iso-8601=seconds)"
systemctl --user stop "$SERVICE"
git reset --hard "$EXPECTED_SHA"
git clean -ffdx -- \
  .pi/extensions \
  .pi/skills \
  .pi/settings.json \
  .agents/skills
PI_TELEGRAM_BRIDGE_CWD="$DEPLOY_PATH" \
  node "$RELEASE_PATH/dist/src/install-service.js"
systemctl --user restart "$SERVICE"

if ! MAIN_PID="$(wait_for_service_ready "$ACTIVATION_TIME")"; then
  echo "$SERVICE did not report readiness and remain active for five seconds." >&2
  false
fi

echo "==> Deployment complete at $(git rev-parse --short HEAD), PID $MAIN_PID"
ACTIVATION_STARTED=false
[[ -z "$UNIT_BACKUP" ]] || rm -f "$UNIT_BACKUP"
find "$RELEASE_ROOT" -mindepth 1 -maxdepth 1 -type d \
  ! -name "$EXPECTED_SHA" -printf '%T@ %p\n' \
  | sort -nr | tail -n +4 | cut -d' ' -f2- | xargs -r rm -rf
trap - ERR
