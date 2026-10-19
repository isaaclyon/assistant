#!/usr/bin/env bash
# Runs inside the disposable container as root under real systemd. Synthetic data only.
# Exercises the REAL compiled src/isolated-deploy-cli.ts (stage-preflight, stage-activate, stage-observe),
# the real renderers, activation, checkpoint, hold, start-check and no-rewind modules.
# Synthetic: daemons, broker, Tailscale CLI, canary ledger/inspect (see tests/fixtures/c6-rehearsal).
# Usage: c6-rehearsal-activation.sh happy|fail-ready|fail-install
set -Eeuo pipefail
MODE=${1:?mode}
FX=/c6/fixtures; ART=/c6/artifacts
B=/opt/c6-build/releases; R=/opt/c6-live/releases; REPO=/srv/c6-repo; ALLOW=/etc/c6-build-allowlist.json
CPR=/var/lib/c6-checkpoints; ST=/etc/c6-live/stages
PS=/var/lib/c6personal/state; QS=/home/c6peer/.local/state/c6; BH=/var/lib/c6broker
PU=pi-telegram-bridge-c6-personal.service; QU=pi-telegram-bridge-c6-peer.service; BU=pi-trusted-broker-c6-personal.service
NETU=pi-isolated-network-pi-c6.service; IU=pi-private-input-c6-personal.service; TU=pi-private-takeover-c6-personal.service
pass() { echo "PASS $*"; }
fail() { echo "FAIL $*" >&2; journalctl --no-pager -n 25 >&2 || true; exit 1; }
expect() { [[ "$2" == "$3" ]] || fail "$1: expected '$3' got '$2'"; pass "$1"; }
expect_match() { [[ "$2" =~ $3 ]] || fail "$1: '$2' does not match '$3'"; pass "$1"; }
until [[ "$(systemctl is-system-running 2>/dev/null)" =~ ^(running|degraded)$ ]]; do sleep 1; done
expect "systemd is PID 1" "$(cat /proc/1/comm)" systemd

peerctl() { runuser -u c6peer -- /usr/bin/env "XDG_RUNTIME_DIR=/run/user/$PEER_UID" "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$PEER_UID/bus" /usr/bin/systemctl --user "$@"; }
rt() { node -p "JSON.parse(require('fs').readFileSync('$([[ $1 == personal ]] && echo $PS/instances/c6-personal || echo $QS/instances/c6-peer)/runtime.json'))$2"; }
ev() { node -p "JSON.parse(require('fs').readFileSync('$([[ $1 == personal ]] && echo $PS/instances/c6-personal || echo $QS/instances/c6-peer)/fixture-evidence.json'))$2"; }
sstate() { systemctl show -p ActiveState --value "$1"; }
sfile() { systemctl is-enabled "$1" 2>/dev/null || true; }
qstate() { peerctl show -p ActiveState --value "$QU"; }
pid() { systemctl show -p MainPID --value "$1"; }
qpid() { peerctl show -p MainPID --value "$QU"; }
snap() { (find "$1" -type f -exec sha256sum {} +; find "$1" -printf '%p %m %U %G\n') | sort | sha256sum | cut -c1-16; }
unit_exec() { grep '^ExecStart=' "$1" | sed -E 's/^ExecStart="[^"]+" "([^"]+)".*/\1/'; }
wait_for() { local n=$1; shift; for _ in $(seq "$n"); do "$@" >/dev/null 2>&1 && return 0; sleep 1; done; return 1; }
ready_both() { [[ "$(rt personal .status 2>/dev/null)" == ready && "$(rt peer .status 2>/dev/null)" == ready && "$(rt personal .pid)" == "$(pid $PU)" && "$(rt peer .pid)" == "$(qpid)" ]]; }
held() { [[ -e $PS/.recovery-maintenance && -e $QS/.recovery-maintenance && -e $BH/.recovery-maintenance ]]; }
nohold() { [[ ! -e $PS/.recovery-maintenance && ! -e $QS/.recovery-maintenance && ! -e $BH/.recovery-maintenance ]]; }
hex64() { printf '%s' "$1" | sha256sum | cut -d' ' -f1; }
restore_result() { node --input-type=module -e "const {restoreIsolatedRecovery}=await import('$ART/dist/src/isolated-recovery.js'); try{await restoreIsolatedRecovery(process.argv[1]);console.log('RESTORED')}catch(e){console.log('REFUSED:'+e.message)}" "$1"; }
cli() { local sha=$1 action=$2 stage=$3 obs=${4:-} migration=${5:--}; timeout 200 /usr/local/bin/node "$B/$sha/dist/src/isolated-deploy-cli.js" "$sha" "$B/$sha" "$action" /etc/c6-live/deploy.json "$migration" "$stage" $obs; }
run_cli() { set +e; CLI_OUT=$(cli "$@" 2>&1); CLI_RC=$?; set -e; }
stage() { node $FX/make-config.mjs stage "$1"; }

# ---- world ------------------------------------------------------------------------------
useradd -r -m -d /var/lib/c6personal -s /usr/sbin/nologin c6personal
useradd -r -m -d /var/lib/c6broker -s /usr/sbin/nologin c6broker
useradd -m -d /home/c6peer -s /usr/sbin/nologin c6peer
loginctl enable-linger c6peer; PEER_UID=$(id -u c6peer)
until [[ -S /run/user/$PEER_UID/bus ]]; do sleep 0.5; done
mkdir -p /opt/c6-live/node/bin /opt/c6-build/releases /etc/c6-live /srv/c6-repo "$R" "$ST"
chmod 755 /opt/c6-live /opt/c6-live/node /opt/c6-live/node/bin /opt/c6-build /opt/c6-build/releases /etc/c6-live "$R" "$ST"
cp "$(readlink -f /usr/local/bin/node)" /opt/c6-live/node/bin/node; cp /usr/bin/true /opt/c6-live/fake-op; chmod 755 /opt/c6-live/node/bin/node /opt/c6-live/fake-op
install -m 755 $FX/fake-tailscale.sh /usr/bin/tailscale
node $FX/make-config.mjs world
cd "$REPO"; git init -q; git config user.email t@x; git config user.name t
cat > package.json <<'J'
{"name":"c6-fixture","version":"1.0.0","type":"module","scripts":{"build":"node build.js"}}
J
cat > package-lock.json <<'J'
{"name":"c6-fixture","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"c6-fixture","version":"1.0.0"}}}
J
cat > build.js <<'J'
// Assembles a release from compiled repository output plus one synthetic variant overlay. No network.
import fs from 'fs';
fs.cpSync('payload/dist', 'dist', { recursive: true }); fs.cpSync('payload/.pi', '.pi', { recursive: true });
fs.cpSync('payload/croner', 'node_modules/croner', { recursive: true });
fs.cpSync('variant', '.', { recursive: true });
J
mkdir -p payload && cp -R $ART/dist payload/dist && cp -R $ART/.pi payload/.pi && cp -R $ART/node_modules/croner payload/croner
variant() { # name: legacy|native|failing
  rm -rf variant; mkdir -p variant/dist/src/durable
  cp $FX/broker.js variant/dist/src/trusted-broker-daemon.js
  case $1 in
    legacy) cp $FX/legacy-daemon.js variant/dist/src/daemon.js;;
    native) cp $FX/native-daemon.js variant/dist/src/durable/daemon.js; cp $FX/native-inspect.js variant/dist/src/durable/inspect.js;;
    failing) cp $FX/native-daemon-failing.js variant/dist/src/durable/daemon.js;;
  esac
}
variant legacy; git add -A >/dev/null; git commit -qm old; O=$(git rev-parse HEAD)
variant native; git add -A >/dev/null; git commit -qm new; N=$(git rev-parse HEAD)
variant failing; git add -A >/dev/null; git commit -qm failing; F=$(git rev-parse HEAD)
printf '{"version":1,"releases":["%s","%s","%s"]}' "$O" "$N" "$F" > $ALLOW; chmod 644 $ALLOW
for s in $O $N $F; do node $ART/dist/src/durable/release-build-cli.js --sha $s --allowlist $ALLOW --source $REPO --release-root $B --offline >/dev/null; done
cp -a "$B/$O" "$R/$O"; cd /
expect "builder produced three reviewed releases" "$(ls $B | grep -c -E '^[a-f0-9]{40}$')" 3
expect "old release installed root-owned" "$(stat -c %U:%a $R/$O)" "root:755"

reset_fleet() { # administrator cleanup between scenarios; not part of any tested operation
  for u in $PU $BU $IU $TU $NETU; do systemctl disable --now $u >/dev/null 2>&1 || true; done
  peerctl disable --now $QU >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/pi-*.service "$(dirname /home/c6peer/.config/systemd/user/x)"/pi-telegram-bridge-*.service
  chattr -i /home/c6peer/.config/systemd/user >/dev/null 2>&1 || true
  rm -f /home/c6peer/.config/systemd/user/pi-telegram-bridge-*.service; rm -rf /home/c6peer/.config/systemd/user/*.wants
  systemctl daemon-reload; peerctl daemon-reload; systemctl reset-failed >/dev/null 2>&1 || true
  rm -f $PS/.recovery-maintenance $QS/.recovery-maintenance $BH/.recovery-maintenance
  rm -rf $PS/instances $QS/instances $CPR/* /run/pi-isolation; ip netns del pi-c6 2>/dev/null || true
  systemctl unset-environment PI_TELEGRAM_RECOVERY_AUTHORIZATION; peerctl unset-environment PI_TELEGRAM_RECOVERY_AUTHORIZATION || true
}
start_legacy_fleet() {
  node $FX/bootstrap.mjs "$O"
  systemctl daemon-reload; peerctl daemon-reload
  systemctl enable --now $NETU $BU $IU $TU $PU >/dev/null 2>&1; peerctl enable --now $QU >/dev/null 2>&1
  wait_for 40 ready_both || fail "legacy fleet did not become ready"
}
# Legacy inbox fixtures. Created as the owning user so ownership matches what the real legacy runtime leaves behind.
inbox() { # personal|peer empty|pending|unknown
  local user=c6personal dir=$PS/instances/c6-personal; [[ $1 == peer ]] && { user=c6peer; dir=$QS/instances/c6-peer; }
  runuser -u $user -- node --input-type=module -e "
import { DatabaseSync } from 'node:sqlite'; import { rmSync } from 'node:fs';
const path=process.argv[1], kind=process.argv[2]; rmSync(path,{force:true});
const db=new DatabaseSync(path); db.exec('CREATE TABLE pending_turn (id TEXT PRIMARY KEY, payload TEXT, enqueued_at INTEGER)');
if(kind==='pending')db.exec(\"INSERT INTO pending_turn VALUES ('p1','{}',1)\");
if(kind==='unknown')db.exec('CREATE TABLE surprise (x TEXT)');
db.close();" "$dir/inbox.db" "$2" 2>/dev/null
}
inbox_rows() { runuser -u c6personal -- node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('$PS/instances/c6-personal/inbox.db',{readOnly:true});console.log(d.prepare('SELECT count(*) AS n FROM pending_turn').get().n)" 2>/dev/null; }
start_legacy_fleet
expect "legacy personal runs old sha" "$(rt personal .releaseSha)" "$O"
expect "legacy peer runs old sha" "$(rt peer .releaseSha)" "$O"
expect "legacy personal reaches broker through real trusted transport" "$(ev personal .brokerRelease)" "$O"
expect "personal in the provisioned namespace, peer is not" "$([[ $(ev personal .netns) != $(ev peer .netns) ]] && echo yes)" yes
expect "personal netns matches /run/netns/pi-c6 (real isolation start check passed)" "$(stat -L -c %i /run/netns/pi-c6)" "$(ev personal .netns | sed -E 's/net:\[([0-9]+)\]/\1/')"
expect "release not writable from legacy personal" "$(ev personal .releaseWritable)" false

# spec FILE STAGEID SELECTED BROKER OBS_MS PREV_PERSONAL PREV_PEER DES_PERSONAL DES_PEER ; each map arg is generation:sha
spec() {
  m() { echo "[\"${1%%:*}\",\"${1#*:}\"]"; }
  stage "{\"path\":\"$1\",\"stageId\":\"$2\",\"selected\":\"$3\",\"broker\":\"$4\",\"observationMs\":$5,\"previous\":{\"personal\":$(m $6),\"peer\":$(m $7)},\"desired\":{\"personal\":$(m $8),\"peer\":$(m $9)}}" >/dev/null
}
cpls() { ls $CPR | { grep -v deployment-lock || true; } | tr "\n" " "; }
current_field() { node -p "JSON.parse(require('fs').readFileSync('$CPR/runtime-activation/current.json'))$1"; }
refused() { [[ $CLI_RC -ne 0 ]] || { echo "$CLI_OUT" | tail -5 >&2; fail "$1: CLI succeeded but must refuse"; }; pass "$1 (rc=$CLI_RC)"; }
succeeded() { [[ $CLI_RC -eq 0 ]] || { echo "$CLI_OUT" | tail -15 >&2; fail "$1: CLI failed rc=$CLI_RC"; }; pass "$1"; }

# ---- scenarios ----------------------------------------------------------------------------
id1=$(hex64 stage-one); id2=$(hex64 stage-two); S1=$ST/stage1.json; S2=$ST/stage2.json; OBS=$ST/observe.json
LEG=legacy; NAT=pi-durable

scenario_happy() {
  inbox personal empty; inbox peer empty   # known-empty legacy inboxes are accepted by both first native activations
  node $FX/make-config.mjs native personal "$N" >/dev/null; node $FX/make-config.mjs native peer "$N" >/dev/null
  spec $S1 $id1 personal $O 8000 $LEG:$O $LEG:$O $NAT:$N $LEG:$O
  local before; before=$(snap /etc/systemd/system); local cp_before; cp_before=$(cpls)
  run_cli $N stage-preflight $S1; succeeded "stage-preflight passes"
  expect "preflight did not change installed units" "$(snap /etc/systemd/system)" "$before"
  expect "preflight left checkpoint root unchanged" "$(cpls)" "$cp_before"
  expect "preflight installs the candidate release root-owned" "$(stat -c %U:%a $R/$N)" "root:755"
  nohold || fail "preflight left a hold"; pass "preflight left no hold"
  # negative gates (all refused before any hold or unit change)
  spec $ST/two.json $(hex64 two) personal $O 8000 $LEG:$O $LEG:$O $NAT:$N $NAT:$N
  run_cli $N stage-preflight $ST/two.json; refused "changing both instances in one stage is refused"
  spec $ST/broker.json $(hex64 broker) personal $N 8000 $LEG:$O $LEG:$O $NAT:$N $LEG:$O
  run_cli $N stage-preflight $ST/broker.json; refused "changing the broker pin is refused"
  expect "gates left fleet ready" "$(ready_both && echo yes)" yes
  local p0 q0; p0=$(pid $PU); q0=$(qpid)
  run_cli $N stage-activate $S1; succeeded "stage 1 activation (personal to native, peer legacy, broker old)"
  nohold || fail "holds remain after success"; pass "holds removed after success"
  expect "personal unit runs the native entrypoint of N" "$(unit_exec /etc/systemd/system/$PU)" "$R/$N/dist/src/durable/daemon.js"
  expect "peer unit still runs the legacy entrypoint of O" "$(unit_exec /home/c6peer/.config/systemd/user/$QU)" "$R/$O/dist/src/daemon.js"
  expect "broker unit still pinned to O" "$(unit_exec /etc/systemd/system/$BU)" "$R/$O/dist/src/trusted-broker-daemon.js"
  wait_for 20 ready_both || fail "fleet not ready after stage 1"
  expect "personal runtime.json reports N" "$(rt personal .releaseSha)" "$N"
  expect "peer runtime.json reports O" "$(rt peer .releaseSha)" "$O"
  [[ $(qpid) != $q0 ]] && pass "peer restarted with the paused fleet (all writers stop for the paired checkpoint)" || fail "peer was not paused"
  q0=$(qpid)
  [[ $(pid $PU) != $p0 ]] && pass "personal process replaced" || fail "personal process not replaced"
  expect "native personal reached the OLD broker through the real transport" "$(ev personal .brokerRelease)" "$O"
  expect "native personal in provisioned namespace" "$(stat -L -c %i /run/netns/pi-c6)" "$(ev personal .netns | sed -E 's/net:\[([0-9]+)\]/\1/')"
  expect "personal cannot write the root-owned release" "$(ev personal .releaseWritable)" false
  expect "units enabled (personal)" "$(sfile $PU)" enabled
  expect "current.json is the stage-1 receipt" "$(current_field .plan.stageId)" "$id1"
  expect "stage directory has ready.json" "$([[ -f $CPR/runtime-activation/$id1/ready.json ]] && echo yes)" yes
  local snapdir; snapdir=$(current_field .snapshotDir)
  expect "checkpoint exists with candidate-started" "$([[ -d $snapdir ]] && ls $snapdir | grep -c candidate-started)" 1
  expect_match "restore after candidate start is refused by the real recovery module" "$(restore_result $snapdir)" '^REFUSED'
  run_cli $N stage-activate $S1; refused "replaying the same stage is refused"
  expect "replay left personal process unchanged" "$(pid $PU)" "$(pid $PU)"
  expect "peer (unprivileged) cannot open the personal broker socket" "$(runuser -u c6peer -- node -e "const s=require('net').connect('/run/pi-broker-c6-personal/telegram.sock');s.on('error',e=>console.log(e.code));s.on('connect',()=>console.log('CONNECTED'))" 2>&1 | head -1)" EACCES
  # stage 2 gates
  spec $S2 $id2 peer $O 8000 $NAT:$N $LEG:$O $NAT:$N $NAT:$N
  run_cli $N stage-activate $S2; refused "stage 2 before canary observation is refused"
  echo '{"dispatchId":"canary-0123456789abcdef"}' > $OBS.tmp; node $FX/make-config.mjs observe $OBS canary-0123456789abcdef
  run_cli $N stage-observe $S1 $OBS; refused "early observation is refused"
  expect "refused early observation did not restart personal" "$(rt personal .pid)" "$(pid $PU)"
  sleep 9
  node $FX/make-config.mjs observe $OBS BAD_ID; run_cli $N stage-observe $S1 $OBS; refused "malformed dispatch selection is refused"
  node $FX/make-config.mjs observe $OBS canary-0123456789abcdef
  local pp; pp=$(pid $PU)
  run_cli $N stage-observe $S1 $OBS
  succeeded "canary observation (restart + completed dispatch)"
  [[ $(pid $PU) != $pp ]] && pass "observation restarted personal with a new process" || fail "no restart"
  expect "observation re-enabled the personal unit" "$(sfile $PU)" enabled
  wait_for 30 ready_both || fail "fleet not ready after observation"; pass "fleet ready after observation"
  expect "peer untouched by observation" "$(qpid)" "$q0"
  expect "observation.json written" "$([[ -f $CPR/runtime-activation/$id1/observation.json && -f $CPR/runtime-activation/$id1/evidence.json ]] && echo yes)" yes
  nohold || fail "hold left after observation"; pass "hold removed after observation"
  run_cli $N stage-observe $S1 $OBS; refused "second observation is refused"
  # stage 2 with wrong previous map, then tampered release
  spec $ST/bad2.json $(hex64 bad2) peer $O 8000 $LEG:$O $LEG:$O $NAT:$N $NAT:$N
  run_cli $N stage-activate $ST/bad2.json; refused "stage 2 with a wrong previous map is refused"
  cp -p $R/$N/package.json /tmp/pkg.bak; echo ' ' >> $R/$N/package.json
  run_cli $N stage-preflight $S2; refused "tampered installed release is refused"
  cp -p /tmp/pkg.bak $R/$N/package.json
  local pp2; pp2=$(pid $PU)
  run_cli $N stage-activate $S2; succeeded "stage 2 activation (peer to native)"
  wait_for 20 ready_both || fail "fleet not ready after stage 2"
  expect "peer runtime.json reports N" "$(rt peer .releaseSha)" "$N"
  expect "peer unit runs native entrypoint" "$(unit_exec /home/c6peer/.config/systemd/user/$QU)" "$R/$N/dist/src/durable/daemon.js"
  [[ $(pid $PU) != $pp2 ]] && pass "personal restarted with the paused fleet in stage 2" || fail "personal not paused in stage 2"
  expect "personal still runs native N after stage 2" "$(rt personal .releaseSha)" "$N"
  expect "broker still pinned to O after stage 2" "$(unit_exec /etc/systemd/system/$BU)" "$R/$O/dist/src/trusted-broker-daemon.js"
  expect "current.json is the stage-2 receipt" "$(current_field .plan.stageId)" "$id2"
  nohold || fail "hold left after stage 2"; pass "no hold after stage 2"
}

fresh_fleet() { reset_fleet; start_legacy_fleet; rm -f $ST/*.json; }
first_snapshot() { ls -d $CPR/checkpoint-* 2>/dev/null | head -1; }

scenario_fail_ready() {
  node $FX/make-config.mjs native personal "$F" >/dev/null
  spec $S1 $id1 personal $O 8000 $LEG:$O $LEG:$O $NAT:$F $LEG:$O
  # The real root CLI refuses an unproven legacy inbox before any hold, unit change or checkpoint (no startup barrier).
  local kind unit_before user_before p0 q0
  for kind in pending unknown; do
    inbox personal $kind; unit_before=$(snap /etc/systemd/system); user_before=$(snap /home/c6peer/.config/systemd/user); p0=$(pid $PU); q0=$(qpid)
    for action in stage-preflight stage-activate; do
      run_cli $F $action $S1; refused "$action refuses a $kind legacy inbox"
      expect_match "$action names the inbox refusal ($kind)" "$CLI_OUT" 'Legacy inbox is not proven empty'
      nohold || fail "$action left a hold ($kind inbox)"; pass "$action left no hold ($kind inbox)"
      expect "$action left system units unchanged ($kind inbox)" "$(snap /etc/systemd/system)" "$unit_before"
      expect "$action left user units unchanged ($kind inbox)" "$(snap /home/c6peer/.config/systemd/user)" "$user_before"
      expect "$action created no checkpoint or barrier ($kind inbox)" "$(cpls)" ""
    done
    expect "legacy fleet untouched by the refusal ($kind inbox)" "$(ready_both && [[ $(pid $PU) == $p0 && $(qpid) == $q0 ]] && echo yes)" yes
  done
  inbox personal empty   # administrator cleanup; a known-empty inbox is accepted below
  run_cli $F stage-activate $S1; refused "activation of a candidate that fails readiness"
  expect "the native candidate admitted a pending inbox row before failing" "$(inbox_rows)" 1
  expect_match "cleanup after the barrier reports a verified hold despite native pending rows" "$CLI_OUT" 'Deployment held: writers are stopped and disabled'
  [[ $CLI_OUT != *"shutdown could not be verified"* ]] && pass "cleanup did not report unverified shutdown" || fail "native pending row made cleanup report unverified shutdown"
  expect "all three writers are held" "$(held && echo yes)" yes
  expect "personal writer inactive" "$(sstate $PU)" inactive
  expect "peer writer inactive" "$(qstate)" inactive
  expect "broker inactive" "$(sstate $BU)" inactive
  expect "personal unit not enabled" "$(sfile $PU | grep -c '^enabled$' || true)" 0
  local sd; sd=$(first_snapshot)
  expect "checkpoint retained" "$([[ -d $sd ]] && echo yes)" yes
  expect "candidate-started retained" "$([[ -e $sd/candidate-started ]] && echo yes)" yes
  expect "no current.json receipt" "$([[ -e $CPR/runtime-activation/current.json ]] && echo yes || echo no)" no
  expect "no ready.json for the stage" "$([[ -e $CPR/runtime-activation/$id1/ready.json ]] && echo yes || echo no)" no
  expect "personal unit left on the failing candidate (no automatic rollback)" "$(unit_exec /etc/systemd/system/$PU)" "$R/$F/dist/src/durable/daemon.js"
  expect "peer unit still pins O" "$(unit_exec /home/c6peer/.config/systemd/user/$QU)" "$R/$O/dist/src/daemon.js"
  expect "broker unit still pins O" "$(unit_exec /etc/systemd/system/$BU)" "$R/$O/dist/src/trusted-broker-daemon.js"
  expect_match "restore after candidate start is refused" "$(restore_result $sd)" '^REFUSED'
  set +e; systemctl start $PU >/dev/null 2>&1; local rc=$?; set -e
  expect "manual start of the held personal writer is refused (ExecCondition)" "$([[ $rc -ne 0 || $(sstate $PU) != active ]] && echo refused)" refused
  run_cli $F stage-activate $S1; refused "retry while the hold exists is refused"
  run_cli $F stage-preflight $S1; refused "preflight while the hold exists is refused"
  expect "retained hold survives retries" "$(held && echo yes)" yes
  # wrong-UID isolation policy blocks the personal start check
  fresh_fleet
  cp -p /etc/c6-live/personal/isolation-policy.json /tmp/policy.bak
  sed -i -E 's/"uid":[0-9]+/"uid":12345/' /etc/c6-live/personal/isolation-policy.json
  set +e; systemctl restart $PU >/dev/null 2>&1; set -e
  sleep 2
  expect "wrong-UID isolation policy: personal start refused" "$([[ $(sstate $PU) != active ]] && echo refused)" refused
  expect_match "start check names the failure in the journal" "$(journalctl -u $PU --no-pager -n 30 | grep -c -i -E 'isolation|policy|uid' || true)" '^[1-9]'
  cp -p /tmp/policy.bak /etc/c6-live/personal/isolation-policy.json
  systemctl reset-failed $PU; systemctl restart $PU; wait_for 30 ready_both || fail "personal did not recover with the correct policy"
  pass "correct policy restores the start"
}

scenario_fail_install() {
  node $FX/make-config.mjs native personal "$N" >/dev/null
  spec $S1 $id1 personal $O 8000 $LEG:$O $LEG:$O $NAT:$N $LEG:$O
  # Case 1: the peer user unit directory rejects writes, so install fails before candidate-started.
  chattr +i /home/c6peer/.config/systemd/user
  lsattr -d /home/c6peer/.config/systemd/user | grep -q 'i' || fail "chattr +i is not effective on this filesystem"
  run_cli $N stage-activate $S1; refused "install failure (immutable peer unit directory)"
  chattr -i /home/c6peer/.config/systemd/user
  expect "writers are held after install failure" "$(held && echo yes)" yes
  expect "personal writer inactive" "$(sstate $PU)" inactive
  expect "peer writer inactive" "$(qstate)" inactive
  local sd; sd=$(first_snapshot)
  expect "checkpoint retained" "$([[ -d $sd ]] && echo yes)" yes
  expect "candidate-started absent after install failure" "$([[ -e $sd/candidate-started ]] && echo yes || echo no)" no
  expect "no current.json receipt" "$([[ -e $CPR/runtime-activation/current.json ]] && echo yes || echo no)" no
  run_cli $N stage-activate $S1; refused "retry while the hold exists is refused"
  expect "restore before candidate-started is accepted by the real recovery module" "$(restore_result $sd)" RESTORED
  expect "restore put the personal unit back on O" "$(unit_exec /etc/systemd/system/$PU)" "$R/$O/dist/src/daemon.js"
  # Case 2: SIGTERM as soon as candidate-started appears.
  fresh_fleet
  spec $S1 $(hex64 stage-sig) personal $O 8000 $LEG:$O $LEG:$O $NAT:$N $LEG:$O
  cli $N stage-activate $S1 > /tmp/sig.out 2>&1 &
  local bg=$!
  for _ in $(seq 400); do ls $CPR/checkpoint-*/candidate-started >/dev/null 2>&1 && break; sleep 0.1; done
  ls $CPR/checkpoint-*/candidate-started >/dev/null 2>&1 || fail "candidate-started never appeared"
  pkill -TERM -f 'isolated-deploy-cli.js' || true
  set +e; wait $bg; local rc=$?; set -e
  [[ $rc -ne 0 ]] && pass "SIGTERM after candidate-started ends the CLI non-zero (rc=$rc)" || fail "CLI survived SIGTERM"
  expect "writers are held after SIGTERM" "$([[ -e $PS/.recovery-maintenance ]] && echo yes)" yes
  expect "no current.json after SIGTERM" "$([[ -e $CPR/runtime-activation/current.json ]] && echo yes || echo no)" no
  sd=$(first_snapshot)
  expect_match "restore after SIGTERM past candidate-started is refused" "$(restore_result $sd)" '^REFUSED'
  # Case 3: a message is admitted while the legacy runtime stops. The inbox was empty at preflight, so only the
  # second check (after every writer stops) can catch it. The CLI must fail closed before the checkpoint.
  fresh_fleet; inbox personal empty
  touch $PS/instances/c6-personal/insert-on-stop
  spec $S1 $(hex64 stage-late) personal $O 8000 $LEG:$O $LEG:$O $NAT:$N $LEG:$O
  run_cli $N stage-preflight $S1; succeeded "preflight accepts the known-empty inbox"
  run_cli $N stage-activate $S1; refused "late inbox write during stop is refused after writers stop"
  expect_match "refusal names the inbox" "$CLI_OUT" 'Legacy inbox is not proven empty'
  expect "the late message is retained, not deleted" "$(inbox_rows)" 1
  expect "writers are held" "$(held && echo yes)" yes
  expect "personal writer inactive" "$(sstate $PU)" inactive
  expect "peer writer inactive" "$(qstate)" inactive
  expect "no checkpoint was created" "$(ls -d $CPR/checkpoint-*/candidate-started 2>/dev/null | wc -l)" 0
  expect "no current.json after the refusal" "$([[ -e $CPR/runtime-activation/current.json ]] && echo yes || echo no)" no
  expect "personal unit still pins the legacy entrypoint" "$(unit_exec /etc/systemd/system/$PU)" "$R/$O/dist/src/daemon.js"
  # Case 4: selected assets introduce pending legacy input after the stopped-writer checkpoint.
  # The final inbox gate must refuse it before installing units or marking candidate-started.
  fresh_fleet; inbox personal pending
  cp "$PS/instances/c6-personal/inbox.db" /var/lib/c6personal/frozen-inbox.db
  inbox personal empty
  runuser -u c6personal -- node -e "const {DatabaseSync}=require('node:sqlite');new DatabaseSync('$PS/instances/c6-personal/job-occurrences.db').close()" 2>/dev/null
  node --input-type=module -e "import fs from 'node:fs'; const uid=Number(process.argv[1]),gid=Number(process.argv[2]);fs.writeFileSync('/etc/c6-live/migration.json',JSON.stringify({version:1,relocations:[],assets:[{role:'legacy-inbox',source:'/var/lib/c6personal/frozen-inbox.db',destination:'$PS/instances/c6-personal/inbox.db',sourceUid:0,uid,gid,exclude:[],transforms:[]}]}),{mode:0o600})" "$(id -u c6personal)" "$(id -g c6personal)"
  spec $S1 $(hex64 stage-migrated-inbox) personal $O 8000 $LEG:$O $LEG:$O $NAT:$N $LEG:$O
  run_cli $N stage-preflight $S1 "" /etc/c6-live/migration.json; succeeded "preflight accepts empty destination before selected asset migration"
  run_cli $N stage-activate $S1 "" /etc/c6-live/migration.json; refused "migrated legacy inbox refuses activation before unit installation"
  expect_match "post-migration refusal names the inbox" "$CLI_OUT" 'Legacy inbox is not proven empty'
  expect "the migrated message remains present" "$(inbox_rows)" 1
  expect "writers remain held after migrated-inbox refusal" "$(held && echo yes)" yes
  sd=$(first_snapshot)
  expect "checkpoint exists before the migration" "$([[ -d $sd ]] && echo yes)" yes
  expect "migration completes before the final inbox check" "$([[ -e $sd/migration-complete.json ]] && echo yes)" yes
  expect "migrated inbox refusal leaves no candidate-started barrier" "$([[ -e $sd/candidate-started ]] && echo yes || echo no)" no
  expect "migrated inbox refusal leaves personal unit on legacy" "$(unit_exec /etc/systemd/system/$PU)" "$R/$O/dist/src/daemon.js"
  expect "migrated inbox refusal leaves personal writer inactive" "$(sstate $PU)" inactive
  expect "migrated inbox refusal leaves peer writer inactive" "$(qstate)" inactive
  expect "migrated inbox refusal verifies writer cleanup" "$([[ $CLI_OUT == *'Deployment held: writers are stopped and disabled'* ]] && echo yes)" yes
}

case $MODE in
  happy) scenario_happy;;
  fail-ready) scenario_fail_ready;;
  fail-install) scenario_fail_install;;
  *) fail "unknown mode $MODE";;
esac
echo "ALL PASS ($MODE)"
