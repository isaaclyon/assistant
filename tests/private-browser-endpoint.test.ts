import { describe, expect, it } from "vitest";
import { privateBrowserEndpoint } from "../src/private-browser-endpoint.js";
const env = { PI_PRIVATE_BROWSER_BIND_ADDRESS: "10.253.250.2",
  PI_PRIVATE_INPUT_ORIGIN: "https://test.tail123.ts.net:8446", PI_PRIVATE_TAKEOVER_ORIGIN: "https://test.tail123.ts.net:8447" };
describe("administrator-provisioned private browser endpoints", () => {
  it("selects the fixed namespace listener for each authenticated flow", () => {
    expect(privateBrowserEndpoint("input", env)).toEqual({ origin: env.PI_PRIVATE_INPUT_ORIGIN, listen: { host: "10.253.250.2", port: 8446 } });
    expect(privateBrowserEndpoint("takeover", env)?.listen.port).toBe(8447);
    expect(privateBrowserEndpoint("input", {})).toBeUndefined();
  });
  it("never falls back to privileged setup for an isolated or partially configured runtime", () => {
    for (const incomplete of [{ PI_TELEGRAM_TRUSTED_SOCKET: "/run/broker/socket" },
      { PI_PRIVATE_INPUT_ORIGIN: env.PI_PRIVATE_INPUT_ORIGIN }, { ...env, PI_PRIVATE_TAKEOVER_ORIGIN: "" }]) {
      expect(() => privateBrowserEndpoint("input", incomplete)).toThrow();
    }
  });
  it("rejects broad binds, public origins, changed ports and URL decorations", () => {
    for (const host of ["0.0.0.0", "127.0.0.1", "10.253.256.2", "10.253.025.2"])
      expect(() => privateBrowserEndpoint("input", { ...env, PI_PRIVATE_BROWSER_BIND_ADDRESS: host })).toThrow();
    for (const origin of ["https://example.com:8446", "http://test.tail123.ts.net:8446", "https://test.tail123.ts.net:443",
      "https://test.tail123.ts.net:8446/", "https://test.tail123.ts.net:8446/#x"])
      expect(() => privateBrowserEndpoint("input", { ...env, PI_PRIVATE_INPUT_ORIGIN: origin })).toThrow();
  });
});
