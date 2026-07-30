import { chmod, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

const provider = join(
  process.cwd(),
  ".pi/skills/agent-browser/scripts/onepassword-credentials.mjs",
);

async function runProvider(
  args: string[],
  env: NodeJS.ProcessEnv,
  input: string,
): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [provider, ...args], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve({ stdout, stderr })
        : reject(new Error(`provider exited ${code}: ${stderr}`)),
    );
    child.stdin.end(input);
  });
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "onepassword-provider-test-"));
  const configRoot = join(root, "config");
  const secretsDir = join(configRoot, "onepassword");
  const opLog = join(root, "op-log.json");
  await mkdir(secretsDir, { recursive: true, mode: 0o700 });
  await writeFile(
    join(secretsDir, "isaac-personal.json"),
    `${JSON.stringify({ version: 1, vault: "Agent Logins" })}\n`,
    { mode: 0o600 },
  );
  await writeFile(join(secretsDir, "isaac-personal.token"), "service-token", {
    mode: 0o600,
  });

  const op = join(root, "op");
  await writeFile(
    op,
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(process.env.OP_TEST_LOG, JSON.stringify({
  args: process.argv.slice(2),
  token: process.env.OP_SERVICE_ACCOUNT_TOKEN
}));
process.stdout.write(JSON.stringify({
  id: "item-id",
  title: "OpenTable",
  category: "LOGIN",
  urls: [{ href: "https://www.opentable.com/" }],
  fields: [
    { id: "username", label: "username", value: "person@example.com" },
    { id: "password", label: "password", value: "fake-password" },
    { id: "TOTP", label: "one-time password", value: "otpauth://must-not-return" }
  ]
}));
`,
  );
  await chmod(op, 0o755);

  const env = { ...process.env };
  delete env.PI_TELEGRAM_CREDENTIAL_SCOPE;

  return {
    root,
    opLog,
    env: {
      ...env,
      PI_TELEGRAM_BRIDGE_CONFIG_ROOT: configRoot,
      PI_TELEGRAM_PRINCIPAL: "isaac",
      ONEPASSWORD_CLI: op,
      OP_TEST_LOG: opLog,
    },
  };
}

function request(url: string) {
  return JSON.stringify({
    protocol: "agent-browser.plugin.v1",
    type: "credential.resolve",
    capability: "credential.read",
    request: { itemRef: "OpenTable", profileName: "opentable", url },
  });
}

describe("1Password agent-browser credential provider", () => {
  it("returns only username/password for an HTTPS URL matching the item's domain", async () => {
    const setup = await fixture();
    const result = await runProvider(
      [],
      setup.env,
      request("https://opentable.com/login"),
    );

    expect(JSON.parse(result.stdout)).toEqual({
      protocol: "agent-browser.plugin.v1",
      success: true,
      credential: {
        username: "person@example.com",
        password: "fake-password",
        url: "https://opentable.com/login",
      },
    });
    expect(result.stderr).toBe("");
    const invocation = JSON.parse(await readFile(setup.opLog, "utf8"));
    expect(invocation).toEqual({
      args: ["item", "get", "OpenTable", "--vault", "Agent Logins", "--format", "json"],
      token: "service-token",
    });
    expect(JSON.stringify(invocation.args)).not.toContain("service-token");
    expect(result.stdout).not.toContain("otpauth://");
  });

  it("rejects non-HTTPS and mismatched domains without exposing resolved fields", async () => {
    const setup = await fixture();
    const insecure = await runProvider(
      [],
      setup.env,
      request("http://opentable.com/login"),
    );
    expect(JSON.parse(insecure.stdout)).toMatchObject({
      protocol: "agent-browser.plugin.v1",
      success: false,
    });

    const mismatch = await runProvider(
      [],
      setup.env,
      request("https://evil.example/login"),
    );
    expect(JSON.parse(mismatch.stdout)).toMatchObject({
      protocol: "agent-browser.plugin.v1",
      success: false,
    });
    expect(mismatch.stdout).not.toContain("person@example.com");
    expect(mismatch.stdout).not.toContain("fake-password");
  });

  it("fails closed when the token file is not private", async () => {
    const setup = await fixture();
    const tokenPath = join(
      setup.env.PI_TELEGRAM_BRIDGE_CONFIG_ROOT,
      "onepassword/isaac-personal.token",
    );
    await chmod(tokenPath, 0o640);
    const result = await runProvider(
      [],
      setup.env,
      request("https://opentable.com/login"),
    );
    expect(JSON.parse(result.stdout)).toMatchObject({
      protocol: "agent-browser.plugin.v1",
      success: false,
      error: { code: "CREDENTIAL_UNAVAILABLE" },
    });
    expect(result.stdout).not.toContain("service-token");
  });

  it("installs a token and vault configuration without putting the token in arguments", async () => {
    const root = await mkdtemp(join(tmpdir(), "onepassword-setup-test-"));
    const configRoot = join(root, "config");
    const result = await runProvider(
      [
        "setup",
        "--scope",
        "isaac-personal",
        "--vault",
        "Personal Agent Credentials",
        "--token-stdin",
      ],
      { ...process.env, PI_TELEGRAM_BRIDGE_CONFIG_ROOT: configRoot },
      "new-service-token\n",
    );

    expect(result.stdout).toContain("isaac-personal");
    expect(result.stdout).not.toContain("new-service-token");
    expect(
      await readFile(join(configRoot, "onepassword/isaac-personal.token"), "utf8"),
    ).toBe("new-service-token");
    expect(
      JSON.parse(
        await readFile(join(configRoot, "onepassword/isaac-personal.json"), "utf8"),
      ),
    ).toEqual({ version: 1, vault: "Personal Agent Credentials" });
  });
});
