import { fileURLToPath } from "node:url";
import type { HeartbeatObservationV1 } from "../heartbeat.js";

// Fixed public sources keep checker arguments from becoming arbitrary network requests.
export const PRODUCTS = {
  "book-on-zines": { url: "https://victionary.com/products/a-book-on-zines", currency: "HKD", id: "9095217185010", kind: "shopify" },
  "puppy-love-matches": { url: "https://maisongodillot.com/en-us/products/matchbox-puppy-love-archivist", currency: "USD", id: "10002913526026", kind: "shopify" },
  "dog-gramaphone-matches": { url: "https://www.judyattherink.com/dog-and-gramaphone-square-safety-matches.html", currency: "USD", id: "B039", kind: "schema" },
  "steam-deck-512-oled": { url: "https://store.steampowered.com/steamdeck?cc=us&l=english", currency: "USD", id: "946113", kind: "steam" },
  "steam-deck-1tb-oled": { url: "https://store.steampowered.com/steamdeck?cc=us&l=english", currency: "USD", id: "946114", kind: "steam" },
} as const;
type ProductKey = keyof typeof PRODUCTS;
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
export function parseRetailArgs(raw: string | undefined): { product: ProductKey; baselineCents: number } {
  const args = record(JSON.parse(raw ?? "{}"));
  if (typeof args.product !== "string" || !Object.hasOwn(PRODUCTS, args.product)) throw new Error("Unknown product");
  if (typeof args.baselineCents !== "string" || !/^[1-9]\d*$/.test(args.baselineCents)) throw new Error("Invalid baseline");
  return { product: args.product as ProductKey, baselineCents: cents(Number(args.baselineCents)) };
}
async function read(url: string, fetcher: Fetcher): Promise<string> {
  const response = await fetcher(url, { signal: AbortSignal.timeout(15_000), redirect: "error", headers: { "user-agent": "pi-telegram-price-checker/1" } });
  if (!response.ok) throw new Error(`Retailer returned HTTP ${response.status}`);
  if (Number(response.headers.get("content-length")) > 2_000_000) throw new Error("Product response too large");
  const text = await response.text();
  if (Buffer.byteLength(text) > 2_000_000) throw new Error("Product response too large");
  return text;
}
export async function observeRetailProduct(args: ReturnType<typeof parseRetailArgs>, fetcher: Fetcher = fetch): Promise<HeartbeatObservationV1> {
  const product = PRODUCTS[args.product];
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
    if (String(data.id) !== product.id || !Array.isArray(data.variants) || data.variants.length !== 1) throw new Error("Product identity or variants changed");
    const variant = record(data.variants[0]);
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
    const data = record(JSON.parse(await read(`https://store.steampowered.com/api/packagedetails?packageids=${product.id}&cc=us&l=english`, fetcher)));
    const entry = record(data[product.id]);
    if (entry.success !== true) throw new Error("Steam package unavailable");
    const details = record(entry.data);
    const expected = args.product === "steam-deck-512-oled" ? "Steam Deck 512 GB OLED" : "Steam Deck 1 TB OLED";
    if (details.name !== expected) throw new Error("Steam model changed");
    const pricing = record(details.price);
    if (pricing.currency !== "USD") throw new Error("Unexpected currency");
    price = cents(pricing.final);
    // Package pricing does not establish hardware stock. The alert turn verifies it.
    availability = "requires-verification";
  }
  return {
    version: 1,
    // basis points, rounded UP: never turn a near-20% discount into a match.
    value: availability === "out-of-stock" ? 10000 : Math.ceil(price * 10000 / args.baselineCents),
    display: `${product.currency} ${(price / 100).toFixed(2)} (${availability})`,
    context: { url: product.kind === "shopify" ? `${product.url}?currency=${product.currency}` : product.url, product: args.product, currency: product.currency, priceCents: price, baselineCents: args.baselineCents, availability, shipping: "not included; verify before alert" },
  };
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  observeRetailProduct(parseRetailArgs(process.argv[2])).then((value) => process.stdout.write(`${JSON.stringify(value)}\n`)).catch(() => {
    process.stderr.write("Retail product price check failed\n");
    process.exitCode = 1;
  });
}
