#!/usr/bin/env bash
# Synthetic Tailscale CLI fixture used by the real proxy service during rehearsal.
S=/run/fake-tailscale; mkdir -p "$S"
case "$1 $2" in
  "status --json") echo '{"Self":{"DNSName":"c6host.c6net.ts.net."}}';;
  "serve status") python3 - "$S" <<'PY'
import glob, json, sys
web = {}
for f in glob.glob(sys.argv[1] + '/port-*.json'):
    d = json.load(open(f)); web[d['host']] = {'Handlers': {'/': {'Proxy': d['target']}}}
print(json.dumps({'Web': web}))
PY
  ;;
  "serve --yes")
    port=${4#--https=}; target=$5
    echo "{\"host\":\"c6host.c6net.ts.net:$port\",\"target\":\"$target\"}" > "$S/port-$port.json"
    trap 'rm -f "$S/port-$port.json"; exit 0' TERM INT
    while true; do sleep 1; done;;
  *) exit 1;;
esac
