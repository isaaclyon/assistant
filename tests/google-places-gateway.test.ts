import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { openGooglePlacesGateway } from "../src/google-places-gateway.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "google-places-gateway-"));
  roots.push(root);
  return openGooglePlacesGateway(join(root, "google-places.db"));
}

describe("Google Places gateway", () => {
  it("returns eligible cached values without another outbound attempt and refreshes expired entries", async () => {
    const gateway = await fixture();
    const fetch = vi.fn()
      .mockResolvedValueOnce({ id: "one", name: "Cafe" })
      .mockResolvedValueOnce({ id: "one", name: "Cafe refreshed" });
    const request = {
      operation: "search",
      profile: "search_identity",
      cacheArguments: { query: "cafe", language: "en", region: "US" },
      sku: "places_text_search_basic",
      monthlyLimit: 10,
      ttlMs: 1_000,
    } as const;

    const first = await gateway.request({ ...request, now: Date.UTC(2026, 0, 1) }, fetch);
    const cached = await gateway.request({ ...request, now: Date.UTC(2026, 0, 1) + 999 }, fetch);
    const refreshed = await gateway.request({ ...request, now: Date.UTC(2026, 0, 1) + 1_000 }, fetch);

    expect(first).toEqual({ status: "ok", cached: false, value: { id: "one", name: "Cafe" } });
    expect(cached).toEqual({ status: "ok", cached: true, value: { id: "one", name: "Cafe" } });
    expect(refreshed).toEqual({ status: "ok", cached: false, value: { id: "one", name: "Cafe refreshed" } });
    expect(fetch).toHaveBeenCalledTimes(2);
    gateway.close();
  });

  it("counts failed attempts, blocks before the threshold, and rolls accounting over by UTC month", async () => {
    const gateway = await fixture();
    const request = {
      operation: "details",
      profile: "details_identity",
      cacheArguments: { placeId: "ChIJ123" },
      sku: "places_details_basic",
      monthlyLimit: 1,
      ttlMs: 1_000,
    } as const;
    const failure = vi.fn().mockRejectedValue(new Error("remote failure"));

    await expect(gateway.request({ ...request, now: Date.UTC(2026, 0, 31) }, failure)).rejects.toThrow("remote failure");
    const blocked = await gateway.request({ ...request, now: Date.UTC(2026, 0, 31, 1) }, failure);
    const nextMonth = await gateway.request(
      { ...request, now: Date.UTC(2026, 1, 1) },
      vi.fn().mockResolvedValue({ id: "ChIJ123" }),
    );

    expect(blocked).toEqual({ status: "blocked", sku: "places_details_basic", month: "2026-01" });
    expect(nextMonth).toEqual({ status: "ok", cached: false, value: { id: "ChIJ123" } });
    expect(failure).toHaveBeenCalledTimes(1);
    gateway.close();
  });

  it("atomically prevents concurrent misses from exceeding the monthly threshold", async () => {
    const gateway = await fixture();
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const fetch = vi.fn(async () => {
      await waiting;
      return { id: "one" };
    });
    const request = {
      operation: "search",
      profile: "search_identity",
      cacheArguments: { query: "cafe" },
      sku: "places_text_search_basic",
      monthlyLimit: 2,
      ttlMs: 1_000,
      now: Date.UTC(2026, 0, 1),
    } as const;

    const pending = Array.from({ length: 4 }, () => gateway.request(request, fetch));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    release();
    const results = await Promise.all(pending);

    expect(results.filter((result) => result.status === "ok")).toHaveLength(2);
    expect(results.filter((result) => result.status === "blocked")).toHaveLength(2);
    expect(fetch).toHaveBeenCalledTimes(2);
    gateway.close();
  });

  it("meters but never persists content for a no-cache profile", async () => {
    const gateway = await fixture();
    const fetch = vi.fn()
      .mockResolvedValueOnce({ rating: 4.8, reviews: ["first"] })
      .mockResolvedValueOnce({ rating: 4.9, reviews: ["second"] });
    const request = {
      operation: "details",
      profile: "details_rich_details",
      cacheArguments: { placeId: "ChIJ123" },
      sku: "places_details_rich",
      monthlyLimit: 2,
      ttlMs: 1,
      now: Date.UTC(2026, 0, 1),
      cache: false,
    } as const;

    const first = await gateway.request(request, fetch);
    const second = await gateway.request(request, fetch);
    const blocked = await gateway.request(request, fetch);

    expect(first).toMatchObject({ status: "ok", cached: false, value: { rating: 4.8 } });
    expect(second).toMatchObject({ status: "ok", cached: false, value: { rating: 4.9 } });
    expect(blocked).toMatchObject({ status: "blocked", sku: "places_details_rich" });
    expect(fetch).toHaveBeenCalledTimes(2);
    gateway.close();
  });
});
