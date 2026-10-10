import { describe, expect, it } from "vitest";
import { ApprovedLoginVault, parsePrivateLogin, type PrivateVaultCommand } from "../src/approved-login-vault.js";
import type { CredentialApproval } from "../src/trusted-telegram-store.js";

const sourceId = "a".repeat(26), destinationId = "b".repeat(26), selectedId = "c".repeat(26), copyId = "d".repeat(26);
const config = { binary: "/usr/bin/op", tokenFile: "/private/token", home: "/private", sourceVault: sourceId, sourceName: "Test source", destinationVault: destinationId };
const item = () => ({ id: selectedId, vault: { id: sourceId }, version: 1, category: "LOGIN", title: "Synthetic login",
  urls: [{ href: "https://example.test/login" }], fields: [
    { purpose: "USERNAME", value: "synthetic@example.test" }, { purpose: "PASSWORD", value: "synthetic-password" },
    { purpose: "NOTES", value: "unrelated private notes" }, { id: "otp", value: "synthetic-totp" },
  ], attachments: [{ id: "synthetic-attachment" }],
});
const claim = (state: "once" | "always" = "once"): CredentialApproval => ({ id: "operation", state, messageId: 123, expiresAt: 1000,
  details: { instance: "test", itemId: selectedId, vaultId: sourceId, itemVersion: 1, title: "Synthetic login", username: "synthetic@example.test",
    vaultName: "Test source", origin: "https://example.test", purpose: "Check account" } });

describe("approved source login and independent copy", () => {
  it("resolves Once without writing to the destination", async () => {
    const calls: string[][] = [];
    const vault = new ApprovedLoginVault(config, async args => { calls.push([...args]); return item(); });
    const result = await vault.resolveClaim(claim());
    expect(result.copiedItem).toBeUndefined();
    expect(result.credential.password).toBe("synthetic-password");
    expect(calls).toEqual([["item", "get", selectedId, "--vault", sourceId]]);
  });
  it("creates and verifies only the selected login fields, with an operation identity", async () => {
    let template: any;
    const command: PrivateVaultCommand = async (args, input) => {
      if (args[1] === "create") { template = JSON.parse(input!); return { id: copyId }; }
      if (args[2] === copyId) return { ...template, id: copyId, vault: { id: destinationId }, version: 1 };
      return item();
    };
    const result = await new ApprovedLoginVault(config, command).resolveClaim(claim("always"));
    expect(result.copiedItem).toBe(copyId);
    expect(Object.keys(template).sort()).toEqual(["category", "fields", "tags", "title", "urls"]);
    expect(template.fields).toHaveLength(2);
    expect(template.tags).toEqual(["bridge-approval-operation"]);
    expect(JSON.stringify(template)).not.toMatch(/unrelated|synthetic-totp|attachment/);
  });
  it("rejects changed versions and identity before a copy", async () => {
    for (const changes of [{ version: 2 }, { title: "Changed" }, { fields: [
      { purpose: "USERNAME", value: "other@example.test" }, { purpose: "PASSWORD", value: "synthetic-password" },
    ] }]) {
      let calls = 0;
      const vault = new ApprovedLoginVault(config, async () => { calls++; return { ...item(), ...changes }; });
      await expect(vault.resolveClaim(claim("always"))).rejects.toThrow(/changed/);
      expect(calls).toBe(1);
    }
  });
  it("never reads or writes for an unapproved or wrong-vault claim", async () => {
    let calls = 0;
    const vault = new ApprovedLoginVault(config, async () => { calls++; return item(); });
    for (const state of ["pending", "denied", "expired", "consuming", "delivered"] as const) {
      await expect(vault.resolveClaim({ ...claim(), state })).rejects.toThrow();
    }
    const wrongVault = claim(); wrongVault.details.vaultId = destinationId;
    await expect(vault.resolveClaim(wrongVault)).rejects.toThrow();
    expect(calls).toBe(0);
  });
  it("requires exact HTTPS origin and unambiguous credential fields", () => {
    for (const origin of ["http://example.test", "https://sub.example.test", "https://example.test:444", "https://example.test/login"]) {
      expect(() => parsePrivateLogin(item(), sourceId, selectedId, origin)).toThrow();
    }
    const duplicate = item(); duplicate.fields.push({ purpose: "PASSWORD", value: "other" });
    expect(() => parsePrivateLogin(duplicate, sourceId, selectedId, "https://example.test")).toThrow();
  });
  it("does not retry an ambiguous destination write", async () => {
    let writes = 0;
    const vault = new ApprovedLoginVault(config, async args => {
      if (args[1] === "create") { writes++; throw new Error("synthetic transport failure"); }
      return item();
    });
    await expect(vault.resolveClaim(claim("always"))).rejects.toThrow();
    expect(writes).toBe(1);
  });
});
