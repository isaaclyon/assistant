#!/usr/bin/env bash
#
# Deploy the Pi Telegram bridge host to the box running its systemd user service.
#
# Strategy: git pull on the remote. The commit you want live must already be on
# origin/<branch> (this script deploys what origin has, not your uncommitted
# working tree). It fetches, hard-resets to origin/<branch>, reinstalls deps,
# rebuilds dist/, and restarts the service, then prints status + recent logs.
#
# Overridable via environment:
#   DEPLOY_HOST    SSH destination (alias or user@host)   default: lyon-server
#   DEPLOY_PATH    repo path on the remote                default: /home/isaaclyon/projects/assistant
#   DEPLOY_BRANCH  branch to deploy                       default: master
#
# Usage:
#   npm run deploy
#   DEPLOY_HOST=other-host npm run deploy
set -euo pipefail

DEPLOY_HOST="${DEPLOY_HOST:-lyon-server}"
DEPLOY_PATH="${DEPLOY_PATH:-/home/isaaclyon/projects/assistant}"
DEPLOY_BRANCH="${DEPLOY_BRANCH:-master}"
SERVICE="pi-telegram-bridge.service"

echo "==> Deploying origin/$DEPLOY_BRANCH to $DEPLOY_HOST:$DEPLOY_PATH"

# Preflight: warn (do not block) if the local branch tip differs from origin, so
# you don't restart the service on a commit you forgot to push.
git fetch --quiet origin "$DEPLOY_BRANCH" 2>/dev/null || true
LOCAL_REF="$(git rev-parse --verify --quiet "$DEPLOY_BRANCH" || true)"
REMOTE_REF="$(git rev-parse --verify --quiet "origin/$DEPLOY_BRANCH" || true)"
if [ -n "$LOCAL_REF" ] && [ -n "$REMOTE_REF" ] && [ "$LOCAL_REF" != "$REMOTE_REF" ]; then
  echo "!!  Local $DEPLOY_BRANCH ($LOCAL_REF) != origin/$DEPLOY_BRANCH ($REMOTE_REF)."
  echo "!!  This deploys origin/$DEPLOY_BRANCH. Push first if you meant to ship local commits."
fi

# The remote block runs under bash with nvm sourced: nvm-managed node is not on a
# non-interactive SSH PATH, so npm/node would otherwise be "command not found".
ssh "$DEPLOY_HOST" bash -s -- "$DEPLOY_PATH" "$DEPLOY_BRANCH" "$SERVICE" <<'REMOTE'
set -euo pipefail
DEPLOY_PATH="$1"; DEPLOY_BRANCH="$2"; SERVICE="$3"

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh" >/dev/null
fi
command -v node >/dev/null 2>&1 || { echo "node not found on $(hostname) PATH" >&2; exit 1; }
echo "==> remote node $(node --version), npm $(npm --version)"

cd "$DEPLOY_PATH"

echo "==> git fetch + reset --hard origin/$DEPLOY_BRANCH"
git fetch --prune origin
BEFORE="$(git rev-parse --short HEAD)"
git reset --hard "origin/$DEPLOY_BRANCH"
AFTER="$(git rev-parse --short HEAD)"
echo "    $BEFORE -> $AFTER"

echo "==> npm ci"
npm ci --no-audit --no-fund

echo "==> npm run build"
npm run build

echo "==> restart $SERVICE"
systemctl --user restart "$SERVICE"
sleep 2
STATE="$(systemctl --user is-active "$SERVICE" || true)"
echo "    service is $STATE"

echo "==> recent logs"
journalctl --user -u "$SERVICE" -n 20 --no-pager || true

if [ "$STATE" != "active" ]; then
  echo "!!  Service is not active after restart. Inspect the logs above." >&2
  exit 1
fi
REMOTE

echo "==> Deploy complete."
