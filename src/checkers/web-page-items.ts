import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { fileURLToPath } from "node:url";

import type { HeartbeatObservationV1, JsonObject } from "../heartbeat.js";

/**
 * Reusable page watcher. The job supplies `checker.args`:
 *   - `url` (required): public HTTPS page to read.
 *   - `contains` (optional): string or list; keep only text blocks containing
 *     one of these phrases (case-insensitive).
 * The checker emits the page's visible text blocks as `value.items`, each with a
 * stable content-hash ID, so a `semantic-match` rule sees only new or edited
 * blocks. It reads server-rendered HTML only; pages built by JavaScript yield no
 * text and fail loudly.
 */

const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_ITEM_TEXT_CHARS = 300;
const ITEMS_BUDGET_BYTES = 3_300;
const MAX_OBSERVATION_BYTES = 4_000;

export interface WebPageArgs {
  url: URL;
  contains: string[];
}

export interface WebPageItem extends JsonObject {
  id: string;
  text: string;
}

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

function assertPublicHttpsUrl(url: URL): void {
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    isIP(host) !== 0 ||
    !host.includes(".") ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".ts.net")
  ) {
    throw new Error("url must be a public https:// address without credentials");
  }
}

export function parseWebPageArgs(raw: string | undefined): WebPageArgs {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw ?? "");
  } catch {
    throw new Error('checker.args must include "url"');
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error('checker.args must include "url"');
  }
  const { url, contains } = parsed as Record<string, unknown>;
  if (typeof url !== "string") throw new Error('checker.args must include "url"');
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new Error("url must be a public https:// address without credentials");
  }
  assertPublicHttpsUrl(target);
  const phrases =
    contains === undefined ? [] : Array.isArray(contains) ? contains : [contains];
  if (!phrases.every((phrase) => typeof phrase === "string" && phrase.trim().length > 0)) {
    throw new Error('"contains" must be a non-empty string or list of strings');
  }
  return { url: target, contains: phrases.map((phrase) => phrase.trim().toLowerCase()) };
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "-",
  mdash: "-",
  hellip: "...",
  rsquo: "'",
  lsquo: "'",
  rdquo: '"',
  ldquo: '"',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const code =
        entity[1] === "x" || entity[1] === "X"
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : " ";
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/** Visible text blocks in page order, with page chrome and scripts removed. */
export function extractTextBlocks(html: string): string[] {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(
      /<(script|style|noscript|template|svg|head|nav|footer|iframe)\b[\s\S]*?<\/\1\s*>/gi,
      " ",
    )
    // Source line breaks are not visible breaks; only block elements are.
    .replace(/\s+/g, " ")
    .replace(
      /<\/?(p|div|li|ul|ol|h[1-6]|tr|td|th|table|section|article|header|main|aside|blockquote|pre|br|hr|dd|dt|dl|figcaption|form|label|button|option)\b[^>]*>/gi,
      "\n",
    )
    .replace(/<[^>]*>/g, " ");
  const seen = new Set<string>();
  const blocks: string[] = [];
  for (const line of decodeEntities(text).split("\n")) {
    const block = line.replace(/\s+/g, " ").trim();
    if (block.length < 2 || seen.has(block)) continue;
    seen.add(block);
    blocks.push(block);
  }
  return blocks;
}

export function pageItems(
  blocks: readonly string[],
  contains: readonly string[],
): { items: WebPageItem[]; matched: number; truncated: boolean } {
  const matching =
    contains.length === 0
      ? blocks
      : blocks.filter((block) => {
          const lower = block.toLowerCase();
          return contains.some((phrase) => lower.includes(phrase));
        });
  const items: WebPageItem[] = [];
  let bytes = 2;
  for (const block of matching) {
    const text =
      block.length > MAX_ITEM_TEXT_CHARS ? `${block.slice(0, MAX_ITEM_TEXT_CHARS - 3)}...` : block;
    const item = { id: createHash("sha256").update(block).digest("hex").slice(0, 12), text };
    const itemBytes = Buffer.byteLength(JSON.stringify(item), "utf8") + 1;
    if (bytes + itemBytes > ITEMS_BUDGET_BYTES || items.length >= 50) break;
    items.push(item);
    bytes += itemBytes;
  }
  return { items, matched: matching.length, truncated: items.length < matching.length };
}

export async function fetchPageHtml(url: URL, fetcher: Fetcher = fetch): Promise<string> {
  const response = await fetcher(url.href, {
    headers: { accept: "text/html,text/plain;q=0.9", "user-agent": "pi-telegram-page-watch/1" },
    redirect: "follow",
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`page returned HTTP ${response.status}`);
  if (response.url) assertPublicHttpsUrl(new URL(response.url));
  const type = response.headers.get("content-type") ?? "";
  if (type && !/^text\/(html|plain)\b/i.test(type)) {
    throw new Error(`page returned unsupported content type ${type.split(";")[0]}`);
  }
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_PAGE_BYTES) throw new Error("page is larger than 2 MB");
  const html = await response.text();
  if (Buffer.byteLength(html, "utf8") > MAX_PAGE_BYTES) throw new Error("page is larger than 2 MB");
  return html;
}

export async function observeWebPage(
  args: WebPageArgs,
  fetcher: Fetcher = fetch,
): Promise<HeartbeatObservationV1> {
  const blocks = extractTextBlocks(await fetchPageHtml(args.url, fetcher));
  if (blocks.length === 0) {
    throw new Error("page has no readable text; it may require JavaScript");
  }
  const { items, matched, truncated } = pageItems(blocks, args.contains);
  const build = (): HeartbeatObservationV1 => ({
    version: 1,
    value: { items },
    display: `${items.length} text block${items.length === 1 ? "" : "s"} on ${args.url.hostname}`,
    context: { url: args.url.href, matchedBlocks: matched, truncated: items.length < matched || truncated },
  });
  let observation = build();
  // Stay under the host's 4 KB stdout limit even with a long URL.
  while (items.length > 0 && Buffer.byteLength(JSON.stringify(observation), "utf8") > MAX_OBSERVATION_BYTES) {
    items.pop();
    observation = build();
  }
  return observation;
}

async function main(): Promise<void> {
  const observation = await observeWebPage(parseWebPageArgs(process.argv[2]));
  process.stdout.write(`${JSON.stringify(observation)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Web page check failed: ${message.slice(0, 500)}\n`);
    process.exitCode = 1;
  });
}
