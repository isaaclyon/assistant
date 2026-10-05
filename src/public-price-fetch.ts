import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { request } from "node:https";

const blocked = new BlockList();
for (const [ip, bits] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10],
  ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24],
  ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const) blocked.addSubnet(ip, bits);

export function publicPriceUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.port || url.username || url.password || url.hash ||
      isIP(url.hostname) || !url.hostname.includes(".") ||
      /(?:\.(?:local|internal|localhost|ts\.net)|\.)$/.test(url.hostname)) throw new Error("Expected public HTTPS URL");
  return url;
}

/** Pin a public IPv4 resolution to the connection; redirects are never followed. */
export async function fetchPublicPrice(value: string): Promise<Response> {
  const url = publicPriceUrl(value);
  const addresses = await lookup(url.hostname, { family: 4, all: true });
  if (!addresses.length || addresses.some(item => blocked.check(item.address))) throw new Error("Non-public source address");
  return new Promise((resolve, reject) => {
    const req = request(url, {
      signal: AbortSignal.timeout(15_000),
      family: 4,
      lookup: (_host, _options, callback) => callback(null, addresses[0]!.address, 4),
      headers: { "user-agent": "pi-telegram-price-checker/1" },
    }, response => {
      if (response.statusCode !== 200) { response.resume(); reject(new Error("Source HTTP failure")); return; }
      const chunks: Buffer[] = []; let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 2_000_000) { response.destroy(new Error("Source response too large")); return; }
        chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => resolve(new Response(Buffer.concat(chunks).toString("utf8"))));
    });
    req.on("error", reject); req.end();
  });
}
