import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { notifyFleetDeployment } from "../src/deployment-notification.js";

const SHA = "1234567890abcdef1234567890abcdef12345678";

describe("fleet deployment notification", () => {
  it("notifies the engineering instance after a successful deployment", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-deploy-notification-"));
    const agentDir = join(root, "agent");
    const manifestPath = join(root, "instances.json");
    await mkdir(agentDir);
    await writeFile(
      manifestPath,
      JSON.stringify({
        version: 1,
        instances: [
          {
            id: "isaac",
            displayName: "Isaac Bot",
            principal: "isaac",
            telegramProfile: "isaac",
            telegramSurface: { type: "private" },
            workspaceCwd: "/srv/isaac",
            capabilityProfile: "personal-isaac",
            credentialScope: "isaac-personal",
            memoryView: "owner-and-household",
            jobsRole: "coordinator",
          },
          {
            id: "builder",
            displayName: "Builder Bot",
            principal: "engineering",
            telegramProfile: "builder",
            telegramSurface: { type: "private" },
            workspaceCwd: "/srv/builder",
            capabilityProfile: "builder",
            credentialScope: "engineering",
            memoryView: "none",
            jobsRole: "disabled",
          },
        ],
      }),
      { mode: 0o600 },
    );
    await chmod(manifestPath, 0o600);
    await writeFile(
      join(agentDir, "telegram.json"),
      JSON.stringify({
        profiles: {
          isaac: { botToken: "isaac-token", allowedUserId: 42 },
          builder: { botToken: "builder-token", allowedUserId: 42 },
        },
      }),
    );
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    await expect(
      notifyFleetDeployment({ manifestPath, agentDir, releaseSha: SHA, fetchImpl }),
    ).resolves.toEqual({ targetInstanceId: "builder", instanceCount: 2 });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.telegram.org/botbuilder-token/sendMessage",
      expect.objectContaining({
        body: JSON.stringify({
          chat_id: 42,
          text: "✅ Deployment complete: 1234567. All 2 bridge instances are ready.",
        }),
      }),
    );
  });
});
