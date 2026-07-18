#!/usr/bin/env bash
# Manual fallback for the same exact deployment path used by GitHub Actions.
set -euo pipefail

DEPLOY_HOST="${DEPLOY_HOST:-lyon-server}"
DEPLOY_PATH="${DEPLOY_PATH:-/home/isaaclyon/projects/assistant}"

echo "==> Deploying origin/main to $DEPLOY_HOST:$DEPLOY_PATH"
ssh "$DEPLOY_HOST" bash -s -- "$DEPLOY_PATH" <<'REMOTE'
set -euo pipefail
DEPLOY_PATH="$1"

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [[ -s "$NVM_DIR/nvm.sh" ]]; then
  # shellcheck disable=SC1091
  source "$NVM_DIR/nvm.sh"
fi

cd "$DEPLOY_PATH"
git fetch --prune origin main
EXPECTED_SHA="$(git rev-parse origin/main)"
DEPLOY_SCRIPT="$(mktemp)"
trap 'rm -f "$DEPLOY_SCRIPT"' EXIT
git show "$EXPECTED_SHA:scripts/deploy-local.sh" >"$DEPLOY_SCRIPT"
chmod +x "$DEPLOY_SCRIPT"
DEPLOY_PATH="$DEPLOY_PATH" bash "$DEPLOY_SCRIPT" "$EXPECTED_SHA"
REMOTE

echo "==> Deploy complete."
