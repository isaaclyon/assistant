import { describe, expect, it } from "vitest";
import { observeRetailProduct, parseRetailArgs, type PriceSource } from "../src/checkers/retail-product-price.js";
import { publicPriceUrl } from "../src/public-price-fetch.js";

const source: PriceSource = { kind: "shopify", url: "https://shop.example.com/products/sample", id: "123", currency: "USD" };
const args = (extra: Partial<PriceSource> = {}, mode = "ratio") => parseRetailArgs(JSON.stringify({ source: JSON.stringify({ ...source, ...extra }), baselineCents: "1300", mode }));
const shopify = (price: unknown, available = true, currency = "USD", id = 123) => async (url: string) =>
  new Response(new URL(url).pathname.endsWith(".js") ? JSON.stringify({ id, variants: [{ id: 456, price, available }] }) : `Shopify.currency = {"active":"${currency}"};`);

describe("configured price adapters", () => {
  it("uses an arbitrary configured product and exact inclusive discount boundary", async () => {
    expect((await observeRetailProduct(args(), shopify(1040))).value).toBe(8000);
    expect((await observeRetailProduct(args(), shopify(1041))).value).toBeGreaterThan(8000);
    expect((await observeRetailProduct(args({}, "price"), shopify(1040))).value).toBe(10.4);
  });
  it("never matches unavailable stock", async () => {
    expect((await observeRetailProduct(args(), shopify(500, false))).value).toBe(Number.MAX_SAFE_INTEGER);
  });
  it.each([shopify("1040"), shopify(0), shopify(1040, true, "EUR"), shopify(1040, true, "USD", 999)])("rejects price, currency and identity mismatches", async fetcher => {
    await expect(observeRetailProduct(args(), fetcher)).rejects.toThrow();
  });
  it("pins a configured variant, rejects ambiguity, and supports explicit lowest available selection", async () => {
    const fetcher = async (url: string) => new Response(new URL(url).pathname.endsWith(".js") ? JSON.stringify({ id: 123,
      variants: [{ id: 1, available: false, price: 100 }, { id: 2, available: true, price: 1040 }, { id: 3, available: true, price: 1500 }] }) : 'Shopify.currency = {"active":"USD"};');
    await expect(observeRetailProduct(args(), fetcher)).rejects.toThrow(/variants/);
    expect((await observeRetailProduct(args({ variantId: "3" }), fetcher)).context?.priceCents).toBe(1500);
    expect((await observeRetailProduct(args({ variantPolicy: "lowest-available" }), fetcher)).context?.priceCents).toBe(1040);
    await expect(observeRetailProduct(args({ variantId: "99" }), fetcher)).rejects.toThrow(/variants/);
  });
  it("pins the configured presentment currency in both Shopify requests", async () => {
    const urls: string[] = [];
    await observeRetailProduct(args(), async url => { urls.push(url); return shopify(1040)(url); });
    expect(urls).toHaveLength(2);
    expect(urls.every(url => new URL(url).searchParams.get("currency") === "USD")).toBe(true);
  });
  it("matches the exact schema offer and fails on ambiguous identity", async () => {
    const product = { "@type": "Product", sku: "123", url: source.url, offers: { price: "10.40", priceCurrency: "USD", availability: "https://schema.org/InStock" } };
    const page = (nodes: unknown[]) => async () => new Response(`<script type="application/ld+json">${JSON.stringify(nodes)}</script>`);
    expect((await observeRetailProduct(args({ kind: "schema" }), page([product]))).value).toBe(8000);
    await expect(observeRetailProduct(args({ kind: "schema" }), page([product, product]))).rejects.toThrow(/ambiguous/);
  });
  it("validates configured Steam package name and currency and flags unknown stock", async () => {
    const configured = args({ kind: "steam", url: "https://store.steampowered.com/sub/123", name: "Sample package", country: "us" });
    const page = (name: string, currency: string) => async () => new Response(JSON.stringify({ "123": { success: true, data: { name, price: { currency, final: 1040 } } } }));
    expect((await observeRetailProduct(configured, page("Sample package", "USD"))).context?.availability).toBe("requires-verification");
    await expect(observeRetailProduct(configured, page("Wrong package", "USD"))).rejects.toThrow();
    await expect(observeRetailProduct(configured, page("Sample package", "EUR"))).rejects.toThrow();
  });
  it.each(["https://localhost/a", "https://127.0.0.1/a", "http://shop.example.com/a", "https://host.ts.net/a", "https://user:pass@shop.example.com/a"])("rejects non-public source URLs %s", url => {
    expect(() => publicPriceUrl(url)).toThrow();
  });
  it("rejects unsupported config, precision and HTTP failures", async () => {
    expect(() => args({ currency: "JPY" })).toThrow();
    expect(() => parseRetailArgs('{"product":"old-product","baselineCents":"100"}')).toThrow();
    await expect(observeRetailProduct(args(), async () => new Response("", { status: 429 }))).rejects.toThrow();
  });
});
