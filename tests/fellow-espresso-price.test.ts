import { describe, expect, it, vi } from "vitest";

import { fetchFellowEspressoPrice } from "../src/checkers/fellow-espresso-price.js";

describe("Fellow Espresso price checker", () => {
  it("returns the lowest available variant price in dollars", async () => {
    const fetcher = vi.fn(async () =>
      new Response(
        JSON.stringify({
          variants: [
            { available: false, price: 99900 },
            { available: true, price: 149995 },
            { available: true, price: 139995 },
          ],
        }),
        { status: 200 },
      ),
    );

    await expect(fetchFellowEspressoPrice(fetcher)).resolves.toBe(1399.95);
  });

  it("fails when Fellow does not return usable available-variant pricing", async () => {
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify({ variants: [{ available: true, price: "149995" }] }), {
        status: 200,
      }),
    );

    await expect(fetchFellowEspressoPrice(fetcher)).rejects.toThrow(/usable price/i);
  });

  it("fails on an unsuccessful response", async () => {
    const fetcher = vi.fn(async () => new Response("rate limited", { status: 429 }));

    await expect(fetchFellowEspressoPrice(fetcher)).rejects.toThrow(/HTTP 429/);
  });
});
