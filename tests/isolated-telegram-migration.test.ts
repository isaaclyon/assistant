import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrateTelegramOwnership, parsePrivateTelegramJson, splitTelegramOwnership } from "../src/isolated-telegram-migration.js";
import type { TrustedBrokerConfig } from "../src/trusted-broker-config.js";
const template: TrustedBrokerConfig = { version: 1, instance: "personal", botToken: "0:placeholder", userId: 1, initialOffset: 0,
  socketPath: "/run/pi-broker-personal/telegram.sock", databasePath: "/var/lib/broker/state/telegram.db",
  vault: { binary: "/opt/op", tokenFile: "/var/lib/broker/token", home: "/var/lib/broker", sourceVault: "a".repeat(26), sourceName: "Synthetic", destinationVault: "b".repeat(26) } };
const profile = { botToken: "123:synthetic_personal_token", botId: 123, botUsername: "synthetic_bot", allowedUserId: 42, lastUpdateId: 100 };
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
describe("stopped Telegram poller ownership handoff", () => {
  it("keeps credentials private through durable, idempotent file replacement", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "telegram-ownership-"))); roots.push(root);
    const checkpoint = join(root, "checkpoint"); await mkdir(checkpoint, { mode: 0o700 });
    const spec = { sourcePath: join(root, "source.json"), sourceUid: process.getuid!(), profile: "personal",
      runtimePath: join(root, "runtime.json"), runtimeUid: process.getuid!(), runtimeGid: process.getgid!(),
      brokerPath: join(root, "broker.json"), brokerUid: process.getuid!(), brokerGid: process.getgid!() };
    await writeFile(spec.sourcePath, JSON.stringify({ profiles: { personal: profile } }), { mode: 0o600 });
    await writeFile(spec.brokerPath, JSON.stringify(template), { mode: 0o600 });
    await expect(migrateTelegramOwnership(spec, checkpoint, async () => { throw new Error("poller active"); })).rejects.toThrow("poller active");
    await expect(readFile(spec.runtimePath)).rejects.toThrow();
    await migrateTelegramOwnership(spec, checkpoint, async () => {});
    await migrateTelegramOwnership(spec, checkpoint, async () => {});
    expect(await readFile(spec.runtimePath, "utf8")).not.toContain(profile.botToken);
    expect(JSON.parse(await readFile(spec.brokerPath, "utf8"))).toMatchObject({ botToken: profile.botToken, initialOffset: 101 });
    expect((await lstat(spec.runtimePath)).mode & 0o777).toBe(0o600);
    expect((await lstat(spec.brokerPath)).mode & 0o777).toBe(0o600);
    await writeFile(join(checkpoint, "candidate-started"), "{}", { mode: 0o600 });
    await expect(migrateTelegramOwnership(spec, checkpoint, async () => {})).rejects.toThrow("candidate started");
  });
  it("does not print malformed credential input in parse diagnostics", () => {
    expect(() => parsePrivateTelegramJson('{"botToken":"synthetic-secret')).toThrow("Private Telegram migration JSON is invalid");
  });
  it("retains the exact next offset and places only the selected token in the broker", () => {
    const result = splitTelegramOwnership({ botToken: "456:synthetic_other_token", profiles: { personal: profile, builder: { botToken: "789:synthetic_builder_token" } }, time: { timezone: "UTC" } }, "personal", template);
    expect(result.broker).toMatchObject({ botToken: profile.botToken, userId: 42, initialOffset: 101 });
    expect(result.runtime).toEqual({ time: { timezone: "UTC" }, profiles: { personal: { ...profile, botToken: "123:runtime" } } });
    expect(JSON.stringify(result.runtime)).not.toContain("synthetic_personal_token");
    expect(JSON.stringify(result)).not.toContain("synthetic_builder_token");
    expect(JSON.stringify(result)).not.toContain("synthetic_other_token");
  });
  it("retains pending updates when no offset has been stored", () => {
    const result = splitTelegramOwnership({ profiles: { personal: { ...profile, lastUpdateId: undefined } } }, "personal", template);
    expect(result.broker.initialOffset).toBe(0);
    expect(result.runtime.profiles).toEqual({ personal: { ...profile, lastUpdateId: -1, botToken: "123:runtime" } });
  });
  it("refuses implicit default profiles, unknown handlers and incomplete identities", () => {
    expect(() => splitTelegramOwnership({ botToken: profile.botToken }, "personal", template)).toThrow();
    expect(() => splitTelegramOwnership({ profiles: { personal: profile }, inboundHandlers: [] }, "personal", template)).toThrow();
    expect(() => splitTelegramOwnership({ profiles: { personal: { ...profile, allowedUserId: undefined } } }, "personal", template)).toThrow();
  });
});
