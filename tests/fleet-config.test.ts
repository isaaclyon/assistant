import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { prepareBridgeFleet } from "../src/fleet-config.js";

const SHA = "1234567890abcdef1234567890abcdef12345678";

function instance(
  id: "isaac" | "emma" | "shared" | "builder",
  workspaceRoot = "/srv/workspaces",
): Record<string, unknown> {
  const household = id === "shared";
  const builder = id === "builder";
  return {
    id,
    displayName: `${id} bot`,
    principal: household ? "household" : builder ? "engineering" : id,
    telegramProfile: id,
    telegramSurface: household
      ? {
          type: "household-group",
          chatId: -100123,
          actors: { isaac: 101, emma: 202 },
        }
      : { type: "private" },
    workspaceCwd: join(workspaceRoot, id),
    capabilityProfile: household
      ? "household-shared"
      : builder
        ? "builder"
        : `personal-${id}`,
    credentialScope: household ? "household" : builder ? "engineering" : `${id}-personal`,
    memoryView: household ? "household" : builder ? "none" : "owner-and-household",
    jobsRole: id === "isaac" ? "coordinator" : builder ? "disabled" : "target-only",
  };
}

async function fixture(): Promise<{
  root: string;
  manifestPath: string;
  configRoot: string;
  stateRoot: string;
  agentDir: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "bridge-fleet-config-"));
  const configRoot = join(root, "config");
  const stateRoot = join(root, "state");
  const agentDir = join(root, "agent");
  const workspaceRoot = join(root, "workspaces");
  const manifestPath = join(configRoot, "instances.json");
  await mkdir(join(configRoot, "instances"), { recursive: true, mode: 0o700 });
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  for (const id of ["isaac", "emma", "shared", "builder"] as const) {
    await mkdir(join(workspaceRoot, id), { recursive: true, mode: 0o700 });
  }
  await writeFile(
    manifestPath,
    JSON.stringify({
      version: 1,
      instances: [
        instance("isaac", workspaceRoot),
        instance("emma", workspaceRoot),
        instance("shared", workspaceRoot),
        instance("builder", workspaceRoot),
      ],
    }),
    { mode: 0o600 },
  );
  await writeFile(
    join(agentDir, "telegram.json"),
    JSON.stringify({
      profiles: Object.fromEntries(
        ["isaac", "emma", "shared", "builder"].map((id) => [
          id,
          { botToken: `${id}:test-token` },
        ]),
      ),
    }),
    { mode: 0o600 },
  );
  const scopes = {
    isaac: "isaac-personal",
    emma: "emma-personal",
    shared: "household",
    builder: "engineering",
  } as const;
  for (const [id, scope] of Object.entries(scopes)) {
    await writeFile(
      join(configRoot, "instances", `${id}.env`),
      `PI_TELEGRAM_CREDENTIAL_SCOPE=${scope}\nPI_TELEGRAM_BRIDGE_WEBHOOK_PORT=0\n`,
      { mode: 0o600 },
    );
  }
  return { root, manifestPath, configRoot, stateRoot, agentDir };
}

describe("fleet preflight configuration", () => {
  it("validates four external instances and renders one-release units without secrets", async () => {
    const paths = await fixture();
    const fleet = await prepareBridgeFleet({
      ...paths,
      resourceRoot: process.cwd(),
      releaseSha: SHA,
      nodePath: "/opt/node/bin/node",
    });

    expect(fleet.configs.map((config) => config.instanceId)).toEqual([
      "isaac",
      "emma",
      "shared",
      "builder",
    ]);
    expect(fleet.units).toHaveLength(4);
    expect(fleet.units.every((unit) => unit.contents.includes(SHA))).toBe(true);
    expect(JSON.stringify(fleet)).not.toContain("test-token");
  });

  it("fails before unit rendering when a credential file or Telegram profile is missing", async () => {
    const paths = await fixture();
    await writeFile(
      join(paths.configRoot, "instances", "shared.env"),
      "PI_TELEGRAM_CREDENTIAL_SCOPE=emma-personal\n",
      { mode: 0o600 },
    );
    await expect(
      prepareBridgeFleet({
        ...paths,
        resourceRoot: process.cwd(),
        releaseSha: SHA,
        nodePath: "/opt/node/bin/node",
      }),
    ).rejects.toThrow(/expected household/i);
  });

  it("rejects duplicate fixed webhook endpoints before rendering units", async () => {
    const paths = await fixture();
    for (const id of ["isaac", "emma"]) {
      const path = join(paths.configRoot, "instances", `${id}.env`);
      const current = await readFile(path, "utf8");
      await writeFile(
        path,
        current.replace("PI_TELEGRAM_BRIDGE_WEBHOOK_PORT=0", "PI_TELEGRAM_BRIDGE_WEBHOOK_PORT=8776"),
        { mode: 0o600 },
      );
      await chmod(path, 0o600);
    }

    await expect(
      prepareBridgeFleet({
        ...paths,
        resourceRoot: process.cwd(),
        releaseSha: SHA,
        nodePath: "/opt/node/bin/node",
      }),
    ).rejects.toThrow(/duplicate webhook endpoint.*8776/i);
  });

  it.each(["resourceRoot", "stateRoot", "configRoot", "agentDir"] as const)(
    "rejects a mutable workspace nested under %s",
    async (rootName) => {
      const paths = await fixture();
      const manifest = JSON.parse(await readFile(paths.manifestPath, "utf8"));
      const protectedRoot =
        rootName === "resourceRoot" ? process.cwd() : paths[rootName];
      const workspaceCwd =
        rootName === "resourceRoot"
          ? join(protectedRoot, "src")
          : join(protectedRoot, "mutable-isaac");
      if (rootName !== "resourceRoot") {
        await mkdir(workspaceCwd, { recursive: true, mode: 0o700 });
      }
      manifest.instances[0].workspaceCwd = workspaceCwd;
      await writeFile(paths.manifestPath, JSON.stringify(manifest), { mode: 0o600 });

      await expect(
        prepareBridgeFleet({
          ...paths,
          resourceRoot: process.cwd(),
          releaseSha: SHA,
          nodePath: "/opt/node/bin/node",
        }),
      ).rejects.toThrow(/workspace.*prohibited/i);
    },
  );

  it("rejects a missing workspace before unit rendering", async () => {
    const paths = await fixture();
    await rm(join(paths.root, "workspaces", "emma"), { recursive: true });

    await expect(
      prepareBridgeFleet({
        ...paths,
        resourceRoot: process.cwd(),
        releaseSha: SHA,
        nodePath: "/opt/node/bin/node",
      }),
    ).rejects.toThrow(/emma workspace.*directory/i);
  });

  it("rejects two workspace paths that canonicalize to the same directory", async () => {
    const paths = await fixture();
    const manifest = JSON.parse(await readFile(paths.manifestPath, "utf8"));
    const alias = join(paths.root, "workspace-alias");
    await symlink(join(paths.root, "workspaces", "isaac"), alias);
    manifest.instances[1].workspaceCwd = alias;
    await writeFile(paths.manifestPath, JSON.stringify(manifest), { mode: 0o600 });

    await expect(
      prepareBridgeFleet({
        ...paths,
        resourceRoot: process.cwd(),
        releaseSha: SHA,
        nodePath: "/opt/node/bin/node",
      }),
    ).rejects.toThrow(/canonical workspace.*isaac.*emma/i);
  });

  it("requires exactly one jobs coordinator in an installable fleet", async () => {
    const paths = await fixture();
    const manifest = JSON.parse(await readFile(paths.manifestPath, "utf8"));
    for (const candidate of manifest.instances) candidate.jobsRole = "target-only";
    await writeFile(paths.manifestPath, JSON.stringify(manifest), { mode: 0o600 });

    await expect(
      prepareBridgeFleet({
        ...paths,
        resourceRoot: process.cwd(),
        releaseSha: SHA,
        nodePath: "/opt/node/bin/node",
      }),
    ).rejects.toThrow(/exactly one jobs coordinator/i);
  });
});
