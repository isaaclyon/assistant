import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import {
  extractTextBlocks,
  observeWebPage,
  pageItems,
  parseWebPageArgs,
} from "../src/checkers/web-page-items.js";
import { parseSemanticItems } from "../src/heartbeat.js";

const PAGE = `<!doctype html><html><head><title>Venue</title><style>.x{}</style></head>
<body><nav><a href="/">Home</a><a href="/shows">Shows</a></nav>
<main><h1>Upcoming shows</h1>
<ul><li>Fri Oct 3 &ndash; The Lumineers &amp; friends. <b>Sold out</b></li>
<li>Sat Oct 4 &ndash; Tickets go on sale
  Monday at 10am</li></ul>
<script>window.track("x")</script><p>Box office opens&nbsp;at 5pm.</p></main>
<footer>&copy; Venue 2026</footer></body></html>`;

function htmlResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, ...init });
}

describe("web-page-items checker", () => {
  it("accepts only public https URLs and normalizes contains phrases", () => {
    expect(parseWebPageArgs(JSON.stringify({ url: "https://venue.example.com/shows", contains: "Oct 4" }))).toEqual({
      url: new URL("https://venue.example.com/shows"),
      contains: ["oct 4"],
    });
    for (const url of [
      "http://venue.example.com",
      "https://localhost/x",
      "https://127.0.0.1/",
      "https://[::1]/",
      "https://printer.local/",
      "https://lyon-server.tail1234.ts.net/",
      "https://user:pw@venue.example.com/",
      "https://intranet/",
    ]) {
      expect(() => parseWebPageArgs(JSON.stringify({ url }))).toThrow(/public https/);
    }
    expect(() => parseWebPageArgs(undefined)).toThrow(/"url"/);
    expect(() => parseWebPageArgs(JSON.stringify({ url: "https://a.example.com", contains: [""] }))).toThrow(
      /contains/,
    );
  });

  it("extracts visible text blocks without navigation, scripts, or footers", () => {
    expect(extractTextBlocks(PAGE)).toEqual([
      "Upcoming shows",
      "Fri Oct 3 - The Lumineers & friends. Sold out",
      "Sat Oct 4 - Tickets go on sale Monday at 10am",
      "Box office opens at 5pm.",
    ]);
  });

  it("emits stable content-hash items that a semantic-match rule accepts", async () => {
    const args = parseWebPageArgs(JSON.stringify({ url: "https://venue.example.com/shows", contains: ["oct"] }));
    const first = await observeWebPage(args, async () => htmlResponse(PAGE));
    const second = await observeWebPage(args, async () =>
      htmlResponse(PAGE.replace(/Tickets go on sale\s+Monday at 10am/, "Tickets on sale now")),
    );

    const firstItems = parseSemanticItems(first.value);
    const secondItems = parseSemanticItems(second.value);
    expect(firstItems.map((item) => item.text)).toEqual([
      "Fri Oct 3 - The Lumineers & friends. Sold out",
      "Sat Oct 4 - Tickets go on sale Monday at 10am",
    ]);
    expect(secondItems[0]!.id).toBe(firstItems[0]!.id);
    expect(secondItems[1]!.id).not.toBe(firstItems[1]!.id);
    expect(first.context).toMatchObject({ matchedBlocks: 2, truncated: false });
  });

  it("stays within the 4 KB observation limit and reports truncation", async () => {
    const blocks = Array.from({ length: 200 }, (_, index) => `Listing ${index} ${"detail ".repeat(20)}`);
    expect(pageItems(blocks, []).truncated).toBe(true);

    const longUrl = `https://venue.example.com/${"a".repeat(900)}`;
    const observation = await observeWebPage(parseWebPageArgs(JSON.stringify({ url: longUrl })), async () =>
      htmlResponse(blocks.map((block) => `<p>${block}</p>`).join("")),
    );
    expect(Buffer.byteLength(JSON.stringify(observation), "utf8")).toBeLessThanOrEqual(4000);
    expect(observation.context).toMatchObject({ matchedBlocks: 200, truncated: true });
  });

  it("fails loudly on HTTP errors, non-HTML, redirects to private hosts, and empty pages", async () => {
    const args = parseWebPageArgs(JSON.stringify({ url: "https://venue.example.com/" }));
    await expect(observeWebPage(args, async () => new Response("", { status: 503 }))).rejects.toThrow(/HTTP 503/);
    await expect(
      observeWebPage(args, async () => new Response("{}", { headers: { "content-type": "application/json" } })),
    ).rejects.toThrow(/content type/);
    const redirected = htmlResponse(PAGE);
    Object.defineProperty(redirected, "url", { value: "https://127.0.0.1/admin" });
    await expect(observeWebPage(args, async () => redirected)).rejects.toThrow(/public https/);
    await expect(
      observeWebPage(args, async () => htmlResponse('<html><body><div id="root"></div><script>app()</script></body></html>')),
    ).rejects.toThrow(/JavaScript/);
  });

  it("reads its arguments from argv and exits nonzero on bad arguments", async () => {
    const run = promisify(execFile);
    const failure = await run(process.execPath, [
      "--experimental-strip-types",
      "src/checkers/web-page-items.ts",
      JSON.stringify({ url: "http://insecure.example.com" }),
    ]).catch((error: { code?: number; stderr?: string }) => error);
    expect(failure).toMatchObject({ code: 1 });
    expect((failure as { stderr: string }).stderr).toMatch(/public https/);
  });
});
