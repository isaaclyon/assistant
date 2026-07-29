#!/usr/bin/env bash
# Publish the release-owned static Messages page through tailnet-only HTTPS.
set -Eeuo pipefail

RELEASE_PATH="${1:?release path}"
PORT="${PI_TELEGRAM_MESSAGES_HTTPS_PORT:-8443}"
PAGE_PATH="$RELEASE_PATH/web/messages"
STATUS_BEFORE="$(mktemp)"
ACTIVATION_STARTED=false
PREVIOUS_TARGET=""
trap 'rm -f "$STATUS_BEFORE"' EXIT

if [[ ! "$PORT" =~ ^[1-9][0-9]{0,4}$ ]] || (( PORT > 65535 )); then
  echo "Messages HTTPS port must be between 1 and 65535." >&2
  exit 2
fi
[[ -f "$PAGE_PATH/index.html" && -f "$PAGE_PATH/messages-link.js" && -f "$PAGE_PATH/healthz" ]] || {
  echo "Messages page is incomplete in release: $RELEASE_PATH" >&2
  exit 1
}

tailscale serve status --json >"$STATUS_BEFORE"
readarray -t PREVIOUS < <(node - "$STATUS_BEFORE" "$PORT" <<'NODE'
const fs = require("node:fs");
const [path, port] = process.argv.slice(2);
const status = JSON.parse(fs.readFileSync(path, "utf8"));
const web = status.Web ?? {};
const entry = Object.entries(web).find(([key]) => key.endsWith(`:${port}`));
const handler = entry?.[1]?.Handlers?.["/"];
const funnel = Object.keys(status.AllowFunnel ?? {}).some((key) => key.endsWith(`:${port}`));
console.log(funnel ? "funnel" : "private");
console.log(handler?.Path ?? handler?.Proxy ?? "");
NODE
)

if [[ "${PREVIOUS[0]:-}" == "funnel" ]]; then
  echo "Refusing to replace a public Funnel endpoint on HTTPS port $PORT." >&2
  exit 1
fi
PREVIOUS_TARGET="${PREVIOUS[1]:-}"

restore_previous() {
  local original_status=$?
  trap - ERR
  if [[ "$ACTIVATION_STARTED" == true ]]; then
    echo "==> Restoring previous Messages-link Serve configuration" >&2
    if [[ -n "$PREVIOUS_TARGET" ]]; then
      sudo -n tailscale serve --bg --yes --https="$PORT" "$PREVIOUS_TARGET" || true
    else
      sudo -n tailscale serve --https="$PORT" off || true
    fi
  fi
  rm -f "$STATUS_BEFORE"
  exit "$original_status"
}
trap restore_previous ERR

ACTIVATION_STARTED=true
sudo -n tailscale serve --bg --yes --https="$PORT" "$PAGE_PATH"

STATUS_AFTER="$(tailscale serve status --json)"
node - "$STATUS_AFTER" "$PORT" "$PAGE_PATH" <<'NODE'
const [raw, port, expectedPath] = process.argv.slice(2);
const status = JSON.parse(raw);
const entry = Object.entries(status.Web ?? {}).find(([key]) => key.endsWith(`:${port}`));
if (entry?.[1]?.Handlers?.["/"]?.Path !== expectedPath) {
  throw new Error("Tailscale Serve does not reference the selected release");
}
if (Object.keys(status.AllowFunnel ?? {}).some((key) => key.endsWith(`:${port}`))) {
  throw new Error("Messages-link endpoint unexpectedly permits Funnel access");
}
NODE

DNS_NAME="$(tailscale status --json | node -e '
let input=""; process.stdin.on("data", c => input += c); process.stdin.on("end", () => {
  const value = JSON.parse(input).Self?.DNSName;
  if (typeof value !== "string" || !value.endsWith(".ts.net.")) process.exit(1);
  process.stdout.write(value.slice(0, -1));
});
')"
curl --fail --silent --show-error --max-time 10 \
  "https://$DNS_NAME:$PORT/healthz" | grep -Fx "ok" >/dev/null

ACTIVATION_STARTED=false
trap - ERR
rm -f "$STATUS_BEFORE"
echo "==> Private Messages-link page ready at https://$DNS_NAME:$PORT/"
