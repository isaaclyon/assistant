#!/usr/bin/env bash
# Runs inside the disposable container as root under real systemd. Synthetic data only.
set -Eeuo pipefail
BUILDER=/c6/artifacts/dist/src/durable/release-build-cli.js
R=/opt/c6/releases; REPO=/srv/c6-repo; ALLOW=/etc/c6/allowlist.json
pass() { echo "PASS $*"; }
fail() { echo "FAIL $*" >&2; ls -ld /opt/c6 "$R" "$R"/*  >&2; ls -l "$R"/*/dist/src/durable >&2; journalctl --no-pager -n 6 -u "c6-*" >&2 || true; exit 1; }
expect() { [[ "$2" == "$3" ]] || fail "$1: expected '$3' got '$2'"; pass "$1"; }
until [[ "$(systemctl is-system-running 2>/dev/null)" =~ ^(running|degraded)$ ]]; do sleep 1; done
expect "systemd is PID 1" "$(cat /proc/1/comm)" systemd
useradd -r -M -s /usr/sbin/nologin pi_personal; useradd -r -M -s /usr/sbin/nologin pi_peer
mkdir -p "$R" /etc/c6 "$REPO"; chmod 755 /opt/c6 "$R" /etc/c6; chown root:root "$R"
# Synthetic source project. The daemon and broker do nothing but prove lifecycle facts.
cd "$REPO"; git init -q; git config user.email t@x; git config user.name t
mkdir -p src; cat > package.json <<'J'
{"name":"c6-fixture","version":"1.0.0","scripts":{"build":"node build.js"}}
J
cat > package-lock.json <<'J'
{"name":"c6-fixture","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"c6-fixture","version":"1.0.0"}}}
J
cat > build.js <<'J'
const fs=require('fs');fs.mkdirSync('dist/src/durable',{recursive:true});
fs.copyFileSync('src/daemon.js','dist/src/durable/daemon.js');fs.copyFileSync('src/broker.js','dist/src/trusted-broker-daemon.js');
// The builder requires every default release entrypoint to exist; the others are inert stubs here.
for(const f of ['durable/inspect.js','recovery-start-check.js','isolation-start-check.js','isolation-network-service.js','isolation-proxy-service.js'])fs.writeFileSync('dist/src/'+f,'');
J
cat > src/broker.js <<'J'
const net=require('net'),fs=require('fs'),path=require('path');
const sha=path.basename(path.resolve(__dirname,'../..'));const sock='/run/c6-broker/telegram.sock';
try{fs.unlinkSync(sock)}catch{}
net.createServer(c=>c.on('data',d=>c.end(`ok ${sha} ${d.toString().trim()}\n`))).listen(sock,()=>fs.chmodSync(sock,0o666));
J
cat > src/daemon.js <<'J'
const net=require('net'),fs=require('fs'),path=require('path');
const root=path.resolve(__dirname,'../../..'),sha=path.basename(root),name=process.env.C6_NAME,dir=process.env.STATE_DIRECTORY;
let writable=true;try{fs.writeFileSync(path.join(root,'probe'),'x')}catch{writable=false}
const ns=fs.readlinkSync('/proc/self/ns/net');
function ready(brokerSha){fs.writeFileSync(path.join(dir,'ready.json'),JSON.stringify({sha,pid:process.pid,ns,writable,brokerSha,at:Date.now()}))}
const c=net.connect('/run/c6-broker/telegram.sock',()=>c.write(name));
c.on('data',d=>ready(d.toString().split(' ')[1]));c.on('error',()=>{fs.writeFileSync(path.join(dir,'ready.json'),JSON.stringify({sha,pid:process.pid,ns,writable,brokerSha:null}))});
setInterval(()=>fs.appendFileSync(path.join(dir,'work.log'),`${process.pid} done\n`),500);
J
git add -A; git commit -qm old; OLD=$(git rev-parse HEAD)
echo '// v2' >> src/daemon.js; git commit -qam new; NEW=$(git rev-parse HEAD)
echo 'throw new Error("x")' > build.js; git commit -qam bad; BAD=$(git rev-parse HEAD)
printf '{"version":1,"releases":["%s","%s","%s"]}' "$OLD" "$NEW" "$BAD" > "$ALLOW"; chmod 644 "$ALLOW"
build() { node "$BUILDER" --sha "$1" --allowlist "$ALLOW" --source "$REPO" --release-root "$R" --offline; }
build "$OLD" >/tmp/old.json; build "$NEW" >/tmp/new.json
OLD_DIGEST=$(node -p "require('/tmp/old.json').digest")
expect "second build reuses verified release" "$(build "$OLD" | node -p 'JSON.parse(require("fs").readFileSync(0)).created')" false
if build "$BAD" 2>/dev/null; then fail "bad build accepted"; fi
[[ ! -e "$R/$BAD" && -z "$(ls -A "$R" | grep -E '^\.staging' || true)" ]] && pass "failed build leaves no partial release"
if node "$BUILDER" --sha "$(printf 'd%.0s' $(seq 40))" --allowlist "$ALLOW" --source "$REPO" --release-root "$R" 2>/dev/null; then fail "unlisted sha accepted"; else pass "unlisted sha refused"; fi
# Units. Personal runs the NEW release in its own network namespace; the broker and the peer keep OLD.
ip netns add pi-personal
unit() { # name user release netns-line extra-exec
cat > "/etc/systemd/system/c6-$1.service" <<U
[Service]
User=$2
Environment=C6_NAME=$1
StateDirectory=c6-$1
$4
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
ExecStart=/usr/local/bin/node $3/dist/src/durable/daemon.js
Restart=no
U
}
cat > /etc/systemd/system/c6-broker.service <<U
[Service]
RuntimeDirectory=c6-broker
RuntimeDirectoryMode=0755
ProtectSystem=strict
NoNewPrivileges=yes
ExecStart=/usr/local/bin/node $R/$OLD/dist/src/trusted-broker-daemon.js
U
unit personal pi_personal "$R/$NEW" "NetworkNamespacePath=/run/netns/pi-personal"
unit peer pi_peer "$R/$OLD" ""
systemctl daemon-reload
# Ordered sequence: hold, stop, checkpoint, start. No rollback step exists.
touch /etc/c6/maintenance-hold; systemctl stop c6-personal c6-peer c6-broker 2>/dev/null || true
CHECKPOINT=$(find "$R/$OLD" "$R/$NEW" -type f -exec sha256sum {} + | sort | sha256sum)
systemctl start c6-broker c6-peer; sleep 1; systemctl start c6-personal
rd() { node -p "JSON.parse(require('fs').readFileSync('/var/lib/c6-$1/ready.json'))$2"; }
for i in $(seq 20); do [[ -s /var/lib/c6-personal/ready.json && -s /var/lib/c6-peer/ready.json ]] && break; sleep 0.5; done
expect "personal runs reviewed new sha" "$(rd personal .sha)" "$NEW"
expect "peer keeps old exact sha" "$(rd peer .sha)" "$OLD"
expect "broker pin independent (old)" "$(rd personal .brokerSha)" "$OLD"
[[ "$(rd personal .ns)" != "$(rd peer .ns)" ]] && pass "personal in separate network namespace" || fail netns
expect "release not writable by service" "$(rd personal .writable)" false
P1=$(rd personal .pid); PEER=$(rd peer .pid)
expect "systemd MainPID matches ready pid" "$(systemctl show -p MainPID --value c6-personal)" "$P1"
systemctl restart c6-personal
for i in $(seq 20); do [[ "$(rd personal .pid)" != "$P1" ]] && break; sleep 0.5; done
[[ "$(rd personal .pid)" != "$P1" ]] && pass "controlled restart produced a new pid" || fail restart
sleep 1.5; [[ $(grep -c "^$(rd personal .pid) done" /var/lib/c6-personal/work.log) -ge 2 ]] && pass "scheduled work completed after restart" || fail work
expect "peer untouched by selected-instance restart" "$(rd peer .pid)" "$PEER"
expect "peer unit never restarted" "$(systemctl show -p NRestarts --value c6-peer)" 0
expect "release trees unchanged by activation" "$(find "$R/$OLD" "$R/$NEW" -type f -exec sha256sum {} + | sort | sha256sum)" "$CHECKPOINT"
expect "old release digest unchanged" "$(build "$OLD" | node -p 'JSON.parse(require("fs").readFileSync(0)).digest')" "$OLD_DIGEST"
chmod u+w "$R/$OLD/package.json"; echo tamper >> "$R/$OLD/package.json"
if build "$OLD" 2>/dev/null; then fail "tampered release accepted"; else pass "tampered release rejected"; fi
echo "REHEARSAL OK"
