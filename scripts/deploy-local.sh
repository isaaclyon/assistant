#!/usr/bin/env bash
# Deploy one already-merged revision from a self-hosted GitHub Actions runner.
set -Eeuo pipefail
umask 022

EXPECTED_SHA="${1:-}"
DEPLOY_PATH="${DEPLOY_PATH:-$HOME/projects/assistant}"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
RELEASE_ROOT="$HOME/.local/share/pi-telegram-bridge/releases"
RELEASE_PATH="$RELEASE_ROOT/$EXPECTED_SHA"
STAGING_PATH="$RELEASE_ROOT/.staging-$EXPECTED_SHA"
LOCK_PATH="$HOME/.local/state/pi-telegram-bridge/deploy.lock"
FLEET_MANIFEST="${PI_TELEGRAM_BRIDGE_INSTANCE_MANIFEST:-$HOME/.config/pi-telegram-bridge/instances.json}"
CURRENT_SHA=""

if [[ ! "$EXPECTED_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Expected a full 40-character git commit SHA." >&2
  exit 2
fi
if [[ ! -f "$FLEET_MANIFEST" ]]; then
  echo "No bridge instance manifest at $FLEET_MANIFEST; deployment requires a configured fleet." >&2
  exit 2
fi

show_failure_context() {
  local original_status=$?
  trap - ERR
  rm -rf "$STAGING_PATH"
  echo "==> Deployment failed; service status follows" >&2
  systemctl --user status 'pi-telegram-bridge*.service' --no-pager >&2 || true
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
  # Package archives can carry permissive modes independently of our umask.
  chmod -R go-w "$STAGING_PATH"
  rm -rf "$RELEASE_PATH"
  mv "$STAGING_PATH" "$RELEASE_PATH"
fi

# The canonical checkout remains the agent cwd and source of repo-local
# capabilities. Build artifacts and dependencies live in the immutable release.
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  if [[ "${PI_TELEGRAM_BRIDGE_DISCARD_TRACKED_EDITS:-0}" != "1" ]]; then
    echo "Canonical checkout has tracked edits; refusing to discard live agent work." >&2
    exit 1
  fi
  echo "==> Discarding explicitly authorized tracked edits in the canonical checkout"
  git reset --hard "$CURRENT_SHA"
fi

echo "==> Activating configured bridge fleet"
PI_TELEGRAM_BRIDGE_INSTANCE_MANIFEST="$FLEET_MANIFEST" \
  bash "$RELEASE_PATH/scripts/activate-fleet.sh" \
    "$EXPECTED_SHA" "$RELEASE_PATH" "$NODE_BINARY"

# The canonical checkout may be updated after fleet readiness because every
# service loads code/resources from the immutable release. Builder worktrees
# are separate paths and are never reset or cleaned here.
git reset --hard "$EXPECTED_SHA"
git clean -ffdx -- \
  .pi/extensions \
  .pi/skills \
  .pi/settings.json \
  .agents/skills
bash "$RELEASE_PATH/scripts/activate-messages-link.sh" "$RELEASE_PATH"
"$NODE_BINARY" "$RELEASE_PATH/dist/src/deployment-notify.js" \
  "$FLEET_MANIFEST" "$AGENT_DIR" "$EXPECTED_SHA"
echo "==> Fleet deployment complete at $(git rev-parse --short HEAD)"
find "$RELEASE_ROOT" -mindepth 1 -maxdepth 1 -type d \
  ! -name "$EXPECTED_SHA" -printf '%T@ %p\n' \
  | sort -nr | tail -n +4 | cut -d' ' -f2- | xargs -r rm -rf
trap - ERR
