import { fileURLToPath } from "node:url";
import type { HeartbeatObservationV1 } from "../heartbeat.js";
import { fetchPublicPrice, publicPriceUrl } from "../public-price-fetch.js";

export interface PriceSource {
  url: string; currency: string; id: string; kind: "shopify" | "schema" | "steam";
  variantId?: string; variantPolicy?: "lowest-available"; name?: string; country?: string;
}
type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;
type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid product data");
  return value as RecordValue;
}
function cents(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new Error("Invalid price");
  return value;
}
export function parseRetailArgs(raw: string | undefined): { source: PriceSource; baselineCents: number; mode: "ratio" | "price" } {
  const args = record(JSON.parse(raw ?? "{}"));
  if (Object.keys(args).some(key => !["source", "baselineCents", "mode"].includes(key)) || typeof args.source !== "string" || args.source.length > 1024) throw new Error("Invalid source configuration");
  const source = record(JSON.parse(args.source));
  if (Object.keys(source).some(key => !["url", "currency", "id", "kind", "variantId", "variantPolicy", "name", "country"].includes(key)) ||
      !["shopify", "schema", "steam"].includes(String(source.kind)) ||
      typeof source.url !== "string" || typeof source.id !== "string" || !source.id || source.id.length > 100 ||
      typeof source.currency !== "string" || !/^[A-Z]{3}$/.test(source.currency)) throw new Error("Invalid source");
  // These adapters use currencies with two decimal minor units only.
  if (!["USD", "EUR", "GBP", "CAD", "AUD", "HKD", "NZD", "CHF"].includes(source.currency)) throw new Error("Unsupported currency precision");
  const url = publicPriceUrl(source.url);
  if (source.variantId !== undefined && (typeof source.variantId !== "string" || !/^\d+$/.test(source.variantId))) throw new Error("Invalid variant");
  if (source.variantPolicy !== undefined && (source.kind !== "shopify" || source.variantPolicy !== "lowest-available" || source.variantId !== undefined)) throw new Error("Invalid variant policy");
  if (source.kind === "shopify" && (url.search || !/\/products\/[^/]+$/.test(url.pathname))) throw new Error("Expected canonical Shopify product URL");
  if (source.kind === "steam" && (url.origin !== "https://store.steampowered.com" || !/^\d+$/.test(source.id) ||
      typeof source.name !== "string" || !source.name || source.name.length > 200 ||
      typeof source.country !== "string" || !/^[a-z]{2}$/.test(source.country))) throw new Error("Invalid Steam package");
  if (args.mode !== undefined && args.mode !== "ratio" && args.mode !== "price") throw new Error("Invalid observation mode");
  if (typeof args.baselineCents !== "string" || !/^[1-9]\d*$/.test(args.baselineCents)) throw new Error("Invalid baseline");
  return { source: source as unknown as PriceSource, baselineCents: cents(Number(args.baselineCents)), mode: args.mode === "price" ? "price" : "ratio" };
}
async function read(url: string, fetcher: Fetcher): Promise<string> {
  const response = await fetcher(url, { signal: AbortSignal.timeout(15_000), redirect: "error", headers: { "user-agent": "pi-telegram-price-checker/1" } });
  if (!response.ok) throw new Error(`Retailer returned HTTP ${response.status}`);
  if (Number(response.headers.get("content-length")) > 2_000_000) throw new Error("Product response too large");
  const text = await response.text();
  if (Buffer.byteLength(text) > 2_000_000) throw new Error("Product response too large");
  return text;
}
export async function observeRetailProduct(args: ReturnType<typeof parseRetailArgs>, fetcher: Fetcher = fetchPublicPrice): Promise<HeartbeatObservationV1> {
  const product = args.source;
  let price: number;
  let availability = "in-stock";
  if (product.kind === "shopify") {
    // Shopify can choose different presentment currencies by client/location.
    // Pin both responses to the baseline currency rather than relying on defaults.
    const [body, page] = await Promise.all([
      read(`${product.url}.js?currency=${product.currency}`, fetcher),
      read(`${product.url}?currency=${product.currency}`, fetcher),
    ]);
    const currency = page.match(/Shopify\.currency\s*=\s*\{\s*"active"\s*:\s*"([A-Z]{3})"/)?.[1];
    if (currency !== product.currency) throw new Error("Unexpected or missing currency");
    const data = record(JSON.parse(body));
    if (String(data.id) !== product.id || !Array.isArray(data.variants)) throw new Error("Product identity or variants changed");
    let variants = product.variantId ? data.variants.map(record).filter(variant => String(variant.id) === product.variantId) : data.variants;
    if (product.variantPolicy === "lowest-available") {
      const all = data.variants.map(record);
      if (!all.length || all.some(variant => typeof variant.available !== "boolean")) throw new Error("Missing availability");
      for (const variant of all) cents(variant.price);
      const available = all.filter(variant => variant.available);
      variants = [(available.length ? available : all).sort((a, b) => Number(a.price) - Number(b.price))[0]];
    }
    if (variants.length !== 1) throw new Error("Missing or ambiguous variants");
    const variant = record(variants[0]);
    if (typeof variant.available !== "boolean") throw new Error("Missing availability");
    availability = variant.available ? "in-stock" : "out-of-stock";
    price = cents(variant.price);
  } else if (product.kind === "schema") {
    const html = await read(product.url, fetcher);
    const nodes: unknown[] = [];
    for (const match of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
      const parsed: unknown = JSON.parse(match[1]!);
      nodes.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    }
    const products = nodes.map(record).filter((node) => node["@type"] === "Product" && node.sku === product.id && node.url === product.url);
    if (products.length !== 1) throw new Error("Missing or ambiguous product");
    const offer = record(products[0]!.offers);
    if (offer.priceCurrency !== product.currency) throw new Error("Unexpected currency");
    if (offer.availability === "https://schema.org/InStock") availability = "in-stock";
    else if (["https://schema.org/OutOfStock", "https://schema.org/SoldOut"].includes(String(offer.availability))) availability = "out-of-stock";
    else throw new Error("Unknown availability");
    if (typeof offer.price !== "string" || !/^\d+\.\d{2}$/.test(offer.price)) throw new Error("Invalid price");
    price = cents(Math.round(Number(offer.price) * 100));
  } else {
    const data = record(JSON.parse(await read(`https://store.steampowered.com/api/packagedetails?packageids=${product.id}&cc=${product.country}&l=english`, fetcher)));
    const entry = record(data[product.id]);
    if (entry.success !== true) throw new Error("Steam package unavailable");
    const details = record(entry.data);
    if (details.name !== product.name) throw new Error("Steam model changed");
    const pricing = record(details.price);
    if (pricing.currency !== product.currency) throw new Error("Unexpected currency");
    price = cents(pricing.final);
    // Package pricing does not establish hardware stock. The alert turn verifies it.
    availability = "requires-verification";
  }
  return {
    version: 1,
    // basis points, rounded UP: never turn a near-20% discount into a match.
    value: availability === "out-of-stock" ? Number.MAX_SAFE_INTEGER : args.mode === "price" ? price / 100 : Number((BigInt(price) * 10000n + BigInt(args.baselineCents) - 1n) / BigInt(args.baselineCents)),
    display: `${product.currency} ${(price / 100).toFixed(2)} (${availability})`,
    context: { url: product.kind === "shopify" ? `${product.url}?currency=${product.currency}` : product.url, productId: product.id, currency: product.currency, priceCents: price, baselineCents: args.baselineCents, availability, shipping: "not included; verify before alert" },
  };
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  observeRetailProduct(parseRetailArgs(process.argv[2])).then((value) => process.stdout.write(`${JSON.stringify(value)}\n`)).catch(() => {
    process.stderr.write("Retail product price check failed\n");
    process.exitCode = 1;
  });
}
