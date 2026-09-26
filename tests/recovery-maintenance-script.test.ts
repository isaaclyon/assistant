import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function rehearsal(blockStop = false) {
  const home = await mkdtemp(join(tmpdir(), "recovery-shell-")); roots.push(home);
  const bin = join(home, "bin"); await mkdir(bin);
  const log = join(home, "calls");
  await writeFile(join(bin, "systemctl"), `#!/usr/bin/env bash
echo "systemctl $*" >> "$CALL_LOG"
case "$2" in
  list-unit-files) printf 'pi-telegram-bridge-isaac.service enabled\npi-telegram-bridge-retired.service disabled\n';;
  list-units) printf 'pi-telegram-bridge.service loaded active running\n';;
  disable) touch "$HOME/stopped-$4";;
  is-enabled) echo enabled;;
  is-active) echo active;;
  show)
    if [[ "$5" == MainPID ]]; then echo 0
    elif [[ "$BLOCK_STOP" == 1 ]]; then echo active
    else echo inactive; fi;;
esac
`, { mode: 0o700 });
  const fakeNode = join(bin, "fake-node");
  await writeFile(fakeNode, `#!/usr/bin/env bash
if [[ "$1" == */recovery-maintenance.js ]]; then
  echo "maintenance $2" >> "$CALL_LOG"
  if [[ "$2" == prepare ]]; then mkdir "$3"; fi
else
  exec "$REAL_NODE" "$@"
fi
`, { mode: 0o700 });
  const script = `set -Eeuo pipefail
source "$HELPER"
NODE_BINARY="$FAKE_NODE"
RELEASE_PATH="$HOME/release"
STATE_ROOT="$HOME/state"
UNIT_DIR="$HOME/units"
trap 'rc=$?; trap - ERR; recovery_hold; exit "$rc"' ERR
recovery_prepare isaac isaac
echo install >> "$CALL_LOG"
recovery_started
echo candidate >> "$CALL_LOG"
false
`;
  await expect(exec("bash", ["-c", script], { env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`,
    REAL_NODE: process.execPath, FAKE_NODE: fakeNode, CALL_LOG: log, BLOCK_STOP: blockStop ? "1" : "0",
    HELPER: resolve("scripts/recovery-maintenance.sh") } })).rejects.toMatchObject({ code: 1 });
  return { calls: await readFile(log, "utf8"), home };
}

describe("offline recovery shell barrier (fake systemd only)", () => {
  it("stops retired and singleton writers before snapshot and holds all stopped after startup failure", async () => {
    const { calls, home } = await rehearsal();
    for (const unit of ["isaac", "retired"]) {
      expect(calls.indexOf(`systemctl --user disable --now pi-telegram-bridge-${unit}.service`)).toBeLessThan(calls.indexOf("maintenance prepare"));
    }
    expect(calls.indexOf("systemctl --user disable --now pi-telegram-bridge.service")).toBeLessThan(calls.indexOf("maintenance prepare"));
    expect(calls.indexOf("maintenance prepare")).toBeLessThan(calls.indexOf("install"));
    expect(calls.indexOf("maintenance started")).toBeLessThan(calls.indexOf("candidate"));
    expect(calls.slice(calls.indexOf("candidate"))).toContain("disable --now pi-telegram-bridge-retired.service");
    expect(calls).not.toContain("restart");
    expect(await readFile(join(home, "state", ".recovery-maintenance"), "utf8")).toContain("snapshot");
  });
  it("never copies or migrates while a writer remains active", async () => {
    const { calls } = await rehearsal(true);
    expect(calls).not.toContain("maintenance prepare");
    expect(calls).not.toContain("candidate");
  });
});
