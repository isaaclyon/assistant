import { describe, expect, it } from "vitest";
import { observeRetailProduct, parseRetailArgs, PRODUCTS } from "../src/checkers/retail-product-price.js";

const args = (product = "puppy-love-matches", baselineCents = "1300") => parseRetailArgs(JSON.stringify({ product, baselineCents }));
const shopify = (price: unknown, available = true, currency = "USD", id = 10002913526026) => async (url: string) => new Response(new URL(url).pathname.endsWith(".js") ? JSON.stringify({ id, variants: [{ price, available }] }) : `Shopify.currency = {"active":"${currency}","rate":"1"};`);
describe("retail product prices", () => {
  it("matches exactly 20% off with a fixed baseline", async () => {
    const result = await observeRetailProduct(args(), shopify(1040));
    expect(result.value).toBe(8000);
    expect(result.context).toMatchObject({ currency: "USD", baselineCents: 1300, priceCents: 1040 });
  });
  it("does not round a smaller discount into eligibility", async () => {
    expect((await observeRetailProduct(args(), shopify(1041))).value).toBeGreaterThan(8000);
  });
  it("does not qualify an out-of-stock item", async () => {
    expect((await observeRetailProduct(args(), shopify(500, false))).value).toBe(10000);
  });
  it.each([shopify("1040"), shopify(0), shopify(1040, true, "EUR"), shopify(1040, true, "USD", 123)])("rejects invalid prices, currency and identity", async (fetcher) => {
    await expect(observeRetailProduct(args(), fetcher)).rejects.toThrow();
  });
  it("reads the exact schema product rather than unrelated prices", async () => {
    const data = [{ "@type": "Product", sku: "other", offers: { price: "1.00" } }, { "@type": "Product", sku: "B039", url: PRODUCTS["dog-gramaphone-matches"].url, offers: { price: "12.00", priceCurrency: "USD", availability: "https://schema.org/InStock" } }];
    const result = await observeRetailProduct(args("dog-gramaphone-matches", "1500"), async () => new Response(`<script type="application/ld+json">${JSON.stringify(data)}</script>`));
    expect(result.value).toBe(8000);
  });
  it.each([
    ["https://schema.org/OutOfStock", "USD", false],
    ["https://schema.org/PreOrder", "USD", true],
    ["https://schema.org/InStock", "EUR", true],
  ])("handles schema availability and currency conservatively", async (availability, priceCurrency, fails) => {
    const data = { "@type": "Product", sku: "B039", url: PRODUCTS["dog-gramaphone-matches"].url, offers: { price: "10.00", priceCurrency, availability } };
    const result = observeRetailProduct(args("dog-gramaphone-matches", "1500"), async () => new Response(`<script type="application/ld+json">${JSON.stringify(data)}</script>`));
    if (fails) await expect(result).rejects.toThrow();
    else expect((await result).value).toBe(10000);
  });
  it("reads a US Steam model and flags stock for verification", async () => {
    const result = await observeRetailProduct(args("steam-deck-512-oled", "78900"), async () => new Response(JSON.stringify({ "946113": { success: true, data: { name: "Steam Deck 512 GB OLED", price: { currency: "USD", final: 63120 } } } })));
    expect(result.value).toBe(8000);
    expect(result.context?.availability).toBe("requires-verification");
  });
  it.each([
    { name: "Steam Deck 1 TB OLED", price: { currency: "USD", final: 63120 } },
    { name: "Steam Deck 512 GB OLED", price: { currency: "EUR", final: 63120 } },
    { name: "Steam Deck 512 GB OLED", price: { currency: "USD", final: "63120" } },
  ])("rejects Steam model and pricing mismatches", async (data) => {
    await expect(observeRetailProduct(args("steam-deck-512-oled", "78900"), async () => new Response(JSON.stringify({ "946113": { success: true, data } })))).rejects.toThrow();
  });
  it("tracks the book in its native HKD currency", async () => {
    const fetcher = shopify(30400, true, "HKD", 9095217185010);
    const requested: string[] = [];
    const result = await observeRetailProduct(args("book-on-zines", "38000"), async (url) => {
      requested.push(url);
      return fetcher(url);
    });
    expect(result.value).toBe(8000);
    expect(result.display).toContain("HKD 304.00");
    expect(requested).toHaveLength(2);
    expect(requested.every((url) => new URL(url).searchParams.get("currency") === "HKD")).toBe(true);
  });
  it("rejects variant changes rather than switching the baseline to a different edition", async () => {
    await expect(observeRetailProduct(args(), async (url) => new Response(new URL(url).pathname.endsWith(".js") ? JSON.stringify({ id: 10002913526026, variants: [{ price: 500, available: true }, { price: 1500, available: true }] }) : 'Shopify.currency = {"active":"USD"};'))).rejects.toThrow(/variants/);
  });
  it("rejects HTTP failures instead of recording no discount", async () => {
    await expect(observeRetailProduct(args(), async () => new Response("", { status: 429 }))).rejects.toThrow(/HTTP/);
  });
  it.each([{ product: "https://localhost", baselineCents: "100" }, { product: "book-on-zines", baselineCents: "0" }, { product: "book-on-zines", baselineCents: "1.2" }, { product: "book-on-zines", baselineCents: "9007199254740992" }])("rejects invalid configuration", (value) => {
    expect(() => parseRetailArgs(JSON.stringify(value))).toThrow();
  });
});
