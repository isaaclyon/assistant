#!/usr/bin/env bash
# Disposable Linux/systemd rehearsal for the offline native release builder and the root staged
# activation adapter. Uses only synthetic data. Mounts no host credentials, sockets or private state.
# Usage: scripts/c6-rehearsal.sh [builder|happy|fail-ready|fail-install|all]
# Needs Docker and Node 24 on PATH. Each mode is bounded to 240 s inside its own container;
# run modes one at a time (each takes well under 285 s). `all` runs them in sequence (over 5 min; agree a longer bound first).
set -Eeuo pipefail
cd "$(dirname "$0")/.."
MODE=${1:-all}
if [[ $MODE == all ]]; then for m in builder happy fail-ready fail-install; do "$0" "$m"; done; exit 0; fi
NAME=c6-rehearsal-$MODE-$$; OUT=$(mktemp -d)
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true; rm -rf "$OUT"' EXIT
docker image inspect c6-rehearsal:v2 >/dev/null 2>&1 || docker build -q -t c6-rehearsal:v2 -f scripts/c6-rehearsal.Dockerfile scripts >/dev/null
# Compile the real native build (release builder, root CLI, renderers, recovery and start-check modules). A compile
# error fails the rehearsal. Only compiled output, the public package croner and repository .pi resources are mounted.
mkdir -p "$OUT/artifacts"
npx tsc -p tsconfig.native-build.json --outDir "$OUT/artifacts/dist" --declaration false >"$OUT/tsc.log" 2>&1 || { tail -20 "$OUT/tsc.log" >&2; echo "native compile failed" >&2; exit 1; }
[[ -f "$OUT/artifacts/dist/src/isolated-deploy-cli.js" && -f "$OUT/artifacts/dist/src/durable/release-build-cli.js" ]] || { echo "native compile produced no entrypoints" >&2; exit 1; }
cp -R .pi "$OUT/artifacts/.pi"; mkdir -p "$OUT/artifacts/node_modules"; cp -R node_modules/croner "$OUT/artifacts/node_modules/croner"
echo '{"type":"module"}' > "$OUT/artifacts/package.json"
MOUNTS=(-v "$OUT/artifacts:/c6/artifacts:ro" -v "$PWD/tests/fixtures/c6-rehearsal:/c6/fixtures:ro")
if [[ $MODE == builder ]]; then
  MOUNTS+=(-v "$PWD/scripts/c6-rehearsal-inner.sh:/c6/inner.sh:ro"); RUN=(bash /c6/inner.sh)
else
  MOUNTS+=(-v "$PWD/scripts/c6-rehearsal-activation.sh:/c6/activation.sh:ro"); RUN=(bash /c6/activation.sh "$MODE")
fi
docker run -d --name "$NAME" --privileged --cgroupns=host --tmpfs /run --tmpfs /run/lock --tmpfs /tmp "${MOUNTS[@]}" c6-rehearsal:v2 >/dev/null
python3 - "$NAME" "${RUN[@]}" <<'PY'
import subprocess, sys
try: sys.exit(subprocess.run(["docker","exec",sys.argv[1],*sys.argv[2:]],timeout=240).returncode)
except subprocess.TimeoutExpired: print("rehearsal timed out",file=sys.stderr); sys.exit(124)
PY
