import { describe, expect, it } from "vitest";
import { splitTelegramOwnership } from "../src/isolated-telegram-migration.js";
import type { TrustedBrokerConfig } from "../src/trusted-broker-config.js";
const template: TrustedBrokerConfig = { version: 1, instance: "personal", botToken: "0:placeholder", userId: 1, initialOffset: 0,
  socketPath: "/run/pi-broker-personal/telegram.sock", databasePath: "/var/lib/broker/state/telegram.db",
  vault: { binary: "/opt/op", tokenFile: "/var/lib/broker/token", home: "/var/lib/broker", sourceVault: "a".repeat(26), sourceName: "Synthetic", destinationVault: "b".repeat(26) } };
const profile = { botToken: "123:synthetic_personal_token", botId: 123, botUsername: "synthetic_bot", allowedUserId: 42, lastUpdateId: 100 };
describe("stopped Telegram poller ownership handoff", () => {
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
