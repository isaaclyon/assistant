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

  it("accepts non-secret Google runtime pointers without returning their values", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-google-config-"));
    const path = join(root, "instance.env");
    await writeFile(
      path,
      [
        "PI_TELEGRAM_CREDENTIAL_SCOPE=isaac-personal",
        "PI_TELEGRAM_GOG_BINARY=/home/linuxbrew/.linuxbrew/bin/gog",
        "PI_TELEGRAM_GOG_HOME=/private/gog-home",
        "PI_TELEGRAM_GOG_KEYRING_PASSWORD_FILE=/private/google-keyring-password",
        "PI_TELEGRAM_GOOGLE_ACCOUNT=owner@example.com",
        "PI_TELEGRAM_GOOGLE_PLACES_API_KEY_FILE=/private/google-places-api-key",
        "PI_TELEGRAM_GOOGLE_PLACES_SEARCH_MONTHLY_LIMIT=100",
        "PI_TELEGRAM_GOOGLE_PLACES_DETAILS_MONTHLY_LIMIT=200",
        "PI_TELEGRAM_GOOGLE_PLACES_CANDIDATES_MONTHLY_LIMIT=300",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );

    const result = await validateCredentialEnvironmentFile(path, "isaac-personal");

    expect(result.keys).toEqual([
      "PI_TELEGRAM_CREDENTIAL_SCOPE",
      "PI_TELEGRAM_GOG_BINARY",
      "PI_TELEGRAM_GOG_HOME",
      "PI_TELEGRAM_GOG_KEYRING_PASSWORD_FILE",
      "PI_TELEGRAM_GOOGLE_ACCOUNT",
      "PI_TELEGRAM_GOOGLE_PLACES_API_KEY_FILE",
      "PI_TELEGRAM_GOOGLE_PLACES_SEARCH_MONTHLY_LIMIT",
      "PI_TELEGRAM_GOOGLE_PLACES_DETAILS_MONTHLY_LIMIT",
      "PI_TELEGRAM_GOOGLE_PLACES_CANDIDATES_MONTHLY_LIMIT",
    ]);
    expect(JSON.stringify(result)).not.toContain("owner@example.com");
    expect(JSON.stringify(result)).not.toContain("google-keyring-password");
    expect(JSON.stringify(result)).not.toContain("google-places-api-key");
  });

  it("rejects invalid Google Places monthly limits", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-google-places-limits-"));
    const path = join(root, "instance.env");
    for (const value of ["-1", "1.5", "Infinity", "1000001"]) {
      await writeFile(
        path,
        `PI_TELEGRAM_CREDENTIAL_SCOPE=isaac-personal\nPI_TELEGRAM_GOOGLE_PLACES_SEARCH_MONTHLY_LIMIT=${value}\n`,
        { mode: 0o600 },
      );
      await expect(validateCredentialEnvironmentFile(path, "isaac-personal"))
        .rejects.toThrow(/Google Places monthly limit.*0 through 1000000/i);
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
