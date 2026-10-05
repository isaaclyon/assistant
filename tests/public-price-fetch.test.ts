import { EventEmitter } from "node:events";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));
vi.mock("node:https", () => ({ request: mocks.request }));
import { fetchPublicPrice } from "../src/public-price-fetch.js";
beforeEach(() => { vi.resetAllMocks(); });
it.each(["127.0.0.1", "10.2.3.4", "100.100.100.100", "169.254.169.254", "192.168.1.1", "172.16.0.1", "0.0.0.0"])("rejects private DNS answers before connecting: %s", async address => {
  mocks.lookup.mockResolvedValue([{ address, family: 4 }]);
  await expect(fetchPublicPrice("https://shop.example.com/products/sample")).rejects.toThrow(/Non-public/);
  expect(mocks.request).not.toHaveBeenCalled();
});
it("pins the checked address to the connection and rejects redirects", async () => {
  mocks.lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  const response = Object.assign(new EventEmitter(), { statusCode: 302, resume: vi.fn() });
  mocks.request.mockImplementation((_url, options, callback) => {
    const resolved = vi.fn(); options.lookup("shop.example.com", {}, resolved);
    expect(resolved).toHaveBeenCalledWith(null, "93.184.216.34", 4);
    expect(options.family).toBe(4);
    return Object.assign(new EventEmitter(), { end: () => callback(response) });
  });
  await expect(fetchPublicPrice("https://shop.example.com/products/sample")).rejects.toThrow(/HTTP/);
  expect(mocks.lookup).toHaveBeenCalledTimes(1);
});
