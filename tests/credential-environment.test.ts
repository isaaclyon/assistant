import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { validateCredentialEnvironmentFile } from "../src/credential-environment.js";

describe("credential environment scopes", () => {
  it.each([
    [
      "isaac-personal",
      ["PI_CREDENTIAL_ISAAC_CALENDAR", "PI_CREDENTIAL_HOUSEHOLD_YNAB"],
    ],
    [
      "emma-personal",
      ["PI_CREDENTIAL_EMMA_CALENDAR", "PI_CREDENTIAL_HOUSEHOLD_YNAB"],
    ],
    ["household", ["PI_CREDENTIAL_HOUSEHOLD_YNAB"]],
    ["engineering", ["PI_CREDENTIAL_ENGINEERING_GITHUB"]],
  ])("accepts only declared %s scope keys without returning values", async (scope, keys) => {
    const root = await mkdtemp(join(tmpdir(), "bridge-credentials-"));
    const path = join(root, "instance.env");
    const secret = "must-never-appear-in-results";
    await writeFile(
      path,
      [
        `PI_TELEGRAM_CREDENTIAL_SCOPE=${scope}`,
        "PI_TELEGRAM_BRIDGE_WEBHOOK_PORT=0",
        "PI_TELEGRAM_SESSION_IDLE_HOURS=8",
        ...keys.map((key) => `${key}=${secret}`),
        "",
      ].join("\n"),
      { mode: 0o600 },
    );

    const result = await validateCredentialEnvironmentFile(path, scope);

    expect(result).toEqual({
      scope,
      webhookPort: 0,
      sessionIdleHours: 8,
      keys: [
        "PI_TELEGRAM_CREDENTIAL_SCOPE",
        "PI_TELEGRAM_BRIDGE_WEBHOOK_PORT",
        "PI_TELEGRAM_SESSION_IDLE_HOURS",
        ...keys,
      ],
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("rejects malformed or unreasonable session idle timeouts", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-idle-config-"));
    const path = join(root, "instance.env");
    for (const value of ["nope", "-1", "Infinity", "8761"]) {
      await writeFile(
        path,
        `PI_TELEGRAM_CREDENTIAL_SCOPE=engineering\nPI_TELEGRAM_SESSION_IDLE_HOURS=${value}\n`,
        { mode: 0o600 },
      );
      await expect(
        validateCredentialEnvironmentFile(path, "engineering"),
      ).rejects.toThrow(/session idle timeout.*0 through 8760/i);
    }
  });

  it("rejects a personal credential in Shared without exposing its value", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-shared-credentials-"));
    const path = join(root, "shared.env");
    const secret = "private-emma-secret";
    await writeFile(
      path,
      `PI_TELEGRAM_CREDENTIAL_SCOPE=household\nPI_CREDENTIAL_EMMA_CALENDAR=${secret}\n`,
      { mode: 0o600 },
    );

    let message = "";
    try {
      await validateCredentialEnvironmentFile(path, "household");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/not allowed for credential scope household/i);
    expect(message).not.toContain(secret);
  });

  it("rejects a scope mismatch and non-private file mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-credential-mode-"));
    const path = join(root, "instance.env");
    await writeFile(
      path,
      "PI_TELEGRAM_CREDENTIAL_SCOPE=emma-personal\nPI_CREDENTIAL_EMMA_TEST=value\n",
      { mode: 0o600 },
    );

    await expect(
      validateCredentialEnvironmentFile(path, "isaac-personal"),
    ).rejects.toThrow(/declares credential scope emma-personal/i);
    await chmod(path, 0o640);
    await expect(
      validateCredentialEnvironmentFile(path, "emma-personal"),
    ).rejects.toThrow(/mode 0600/i);
  });
});
