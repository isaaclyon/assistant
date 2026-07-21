import { fileURLToPath } from "node:url";

import type { HeartbeatObservationV1 } from "../heartbeat.js";

const PRODUCT_URL = "https://fellowproducts.com/products/espresso-series-1.js";

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export async function fetchFellowEspressoPrice(fetcher: Fetcher = fetch): Promise<number> {
  const response = await fetcher(PRODUCT_URL, {
    headers: { accept: "application/json", "user-agent": "pi-telegram-price-checker/1" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Fellow returned HTTP ${response.status}`);

  const product: unknown = await response.json();
  const variants =
    typeof product === "object" && product !== null && "variants" in product
      ? (product as { variants?: unknown }).variants
      : undefined;
  const prices = Array.isArray(variants)
    ? variants.flatMap((variant) => {
        if (
          typeof variant !== "object" ||
          variant === null ||
          !("available" in variant) ||
          variant.available !== true ||
          !("price" in variant) ||
          typeof variant.price !== "number" ||
          !Number.isSafeInteger(variant.price) ||
          variant.price < 0
        ) {
          return [];
        }
        return [variant.price];
      })
    : [];
  if (prices.length === 0) throw new Error("Fellow response contained no usable price");

  return Math.min(...prices) / 100;
}

async function main(): Promise<void> {
  const price = await fetchFellowEspressoPrice();
  const observation = {
    version: 1,
    value: price,
    display: new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(price),
    context: { url: PRODUCT_URL },
  } satisfies HeartbeatObservationV1;
  process.stdout.write(`${JSON.stringify(observation)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Fellow Espresso price check failed: ${message.slice(0, 500)}\n`);
    process.exitCode = 1;
  });
}
