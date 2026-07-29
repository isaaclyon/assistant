import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

async function deploymentFixture() {
  const root = await mkdtemp(join(tmpdir(), "messages-link-deployment-"));
  const release = join(root, "release");
  const page = join(release, "web/messages");
  const bin = join(root, "bin");
  const state = join(root, "serve-target");
  await mkdir(page, { recursive: true });
  await mkdir(bin);
  await Promise.all([
    writeFile(join(page, "index.html"), "page\n"),
    writeFile(join(page, "messages-link.js"), "export {};\n"),
    writeFile(join(page, "healthz"), "ok\n"),
    writeFile(state, "/srv/previous-page\n"),
  ]);

  const tailscale = join(bin, "tailscale");
  await writeFile(
    tailscale,
    `#!/usr/bin/env bash
set -eu
if [[ "\${1:-}" == "serve" && "\${2:-}" == "status" ]]; then
  target="$(cat "$FAKE_SERVE_STATE")"
  funnel=""
  foreground=""
  [[ "\${FAKE_FUNNEL:-0}" != "1" ]] || funnel='"test-node.example.ts.net:8443": true'
  [[ "\${FAKE_FOREGROUND:-0}" != "1" ]] || foreground=',"Foreground":{"session":{"TCP":{"8443":{"HTTPS":true}},"Web":{"test-node.example.ts.net:8443":{"Handlers":{"/":{"Path":"/tmp/foreground"}}}}}}'
  printf '{"Web":{"test-node.example.ts.net:8443":{"Handlers":{"/":{"Path":"%s"}}}},"AllowFunnel":{%s}%s}\\n' "$target" "$funnel" "$foreground"
elif [[ "\${1:-}" == "status" ]]; then
  printf '{"Self":{"DNSName":"test-node.example.ts.net."}}\\n'
elif [[ "\${1:-}" == "serve" && "\${2:-}" == "--bg" ]]; then
  if [[ "\${FAKE_RESTORE_FAIL:-0}" == "1" && "\${@: -1}" == "/srv/previous-page" ]]; then exit 1; fi
  printf '%s\\n' "\${@: -1}" >"$FAKE_SERVE_STATE"
elif [[ "\${1:-}" == "serve" && "\${@: -1}" == "off" ]]; then
  : >"$FAKE_SERVE_STATE"
else
  exit 2
fi
`,
  );
  const sudo = join(bin, "sudo");
  await writeFile(sudo, "#!/usr/bin/env bash\n[[ \"$1\" != \"-n\" ]] || shift\nexec \"$@\"\n");
  const curl = join(bin, "curl");
  await writeFile(
    curl,
    "#!/usr/bin/env bash\n[[ \"${FAKE_CURL_FAIL:-0}\" != \"1\" ]] || exit 22\nprintf 'ok\\n'\n",
  );
  await Promise.all([chmod(tailscale, 0o755), chmod(sudo, 0o755), chmod(curl, 0o755)]);

  return {
    release,
    state,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      FAKE_SERVE_STATE: state,
    },
  };
}

describe("Messages-link deployment", () => {
  it("activates the release-owned page only after bridge readiness", async () => {
    const deploy = await readFile("scripts/deploy-local.sh", "utf8");
    const fleet = deploy.indexOf('bash "$RELEASE_PATH/scripts/activate-fleet.sh"');
    const fleetMessages = deploy.indexOf(
      'bash "$RELEASE_PATH/scripts/activate-messages-link.sh"',
      fleet,
    );
    const singletonReady = deploy.indexOf('wait_for_service_ready "$ACTIVATION_TIME"');
    const singletonMessages = deploy.indexOf(
      'bash "$RELEASE_PATH/scripts/activate-messages-link.sh"',
      fleetMessages + 1,
    );
    const singletonCommitted = deploy.indexOf(
      "ACTIVATION_STARTED=false",
      singletonReady,
    );

    expect(fleetMessages).toBeGreaterThan(fleet);
    expect(singletonMessages).toBeGreaterThan(singletonReady);
    expect(singletonMessages).toBeGreaterThan(singletonCommitted);
  });

  it("uses tailnet-only Serve, verifies health, and restores prior config on failure", async () => {
    const script = await readFile("scripts/activate-messages-link.sh", "utf8");

    expect(script).toContain("tailscale serve");
    expect(script).not.toContain("tailscale funnel");
    expect(script).toContain('"$RELEASE_PATH/web/messages"');
    expect(script).toContain("healthz");
    expect(script).toContain("restore_previous");
    expect(script).toContain("AllowFunnel");
    expect(script).toContain("Foreground");
    expect(script).toContain("CRITICAL: previous Messages-link");
    expect(script).toContain("trap 'restore_previous 143' TERM");
  });

  it("activates the exact release and restores the previous target when health fails", async () => {
    const success = await deploymentFixture();
    const activated = spawnSync(
      "bash",
      ["scripts/activate-messages-link.sh", success.release],
      { cwd: process.cwd(), env: success.env, encoding: "utf8" },
    );
    expect(activated.stderr).toBe("");
    expect(activated.status).toBe(0);
    expect((await readFile(success.state, "utf8")).trim()).toBe(
      join(success.release, "web/messages"),
    );

    const failed = await deploymentFixture();
    const result = spawnSync(
      "bash",
      ["scripts/activate-messages-link.sh", failed.release],
      {
        cwd: process.cwd(),
        env: { ...failed.env, FAKE_CURL_FAIL: "1" },
        encoding: "utf8",
      },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Restoring previous");
    expect((await readFile(failed.state, "utf8")).trim()).toBe("/srv/previous-page");
  });

  it("refuses to replace an endpoint with Funnel permission", async () => {
    const fixture = await deploymentFixture();
    const result = spawnSync(
      "bash",
      ["scripts/activate-messages-link.sh", fixture.release],
      {
        cwd: process.cwd(),
        env: { ...fixture.env, FAKE_FUNNEL: "1" },
        encoding: "utf8",
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Refusing to replace a public Funnel endpoint");
    expect((await readFile(fixture.state, "utf8")).trim()).toBe("/srv/previous-page");
  });

  it("refuses foreground conflicts and reports failed rollback", async () => {
    const foreground = await deploymentFixture();
    const refused = spawnSync(
      "bash",
      ["scripts/activate-messages-link.sh", foreground.release],
      {
        cwd: process.cwd(),
        env: { ...foreground.env, FAKE_FOREGROUND: "1" },
        encoding: "utf8",
      },
    );
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("Refusing to replace a foreground Serve endpoint");
    expect((await readFile(foreground.state, "utf8")).trim()).toBe(
      "/srv/previous-page",
    );

    const rollback = await deploymentFixture();
    const failed = spawnSync(
      "bash",
      ["scripts/activate-messages-link.sh", rollback.release],
      {
        cwd: process.cwd(),
        env: {
          ...rollback.env,
          FAKE_CURL_FAIL: "1",
          FAKE_RESTORE_FAIL: "1",
        },
        encoding: "utf8",
      },
    );
    expect(failed.status).not.toBe(0);
    expect(failed.stderr).toContain(
      "CRITICAL: previous Messages-link Serve configuration was not restored",
    );
    expect((await readFile(rollback.state, "utf8")).trim()).toBe(
      join(rollback.release, "web/messages"),
    );
  });
});
