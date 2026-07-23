import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { Type } from "typebox";

import { createRepositoryInspector, fetchPublicWeb, htmlToText } from "./inspection.js";

const roots = (() => {
  try {
    const value = JSON.parse(process.env.PI_SUBAGENT_READ_ROOTS ?? "[]") as unknown;
    return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
  } catch { return []; }
})();
const inspector = createRepositoryInspector(roots);
const MAX_TEXT_BYTES = 50 * 1024;

function text(content: string, details: unknown = {}) {
  if (Buffer.byteLength(content) > MAX_TEXT_BYTES) {
    let end = Math.min(content.length, MAX_TEXT_BYTES);
    while (end > 0 && Buffer.byteLength(content.slice(0, end)) > MAX_TEXT_BYTES) end--;
    content = `${content.slice(0, Math.max(0, end - 32))}\n[output truncated]`;
  }
  return { content: [{ type: "text" as const, text: content }], details };
}

export default function childSubagentExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "repo_read", label: "Read repository file", description: "Read one regular file within the configured repository roots. Cannot write or follow escaping symlinks.",
    parameters: Type.Object({ path: Type.String() }),
    async execute(_id, { path }) { return text(await inspector.read(path)); },
  });
  pi.registerTool({
    name: "repo_image", label: "View repository image", description: "View a PNG, JPEG, GIF, or WebP image file within the configured repository roots.",
    parameters: Type.Object({ path: Type.String() }),
    async execute(_id, { path }) {
      const file = await inspector.resolveFile(path);
      const mime = ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" } as Record<string, string>)[extname(file.path).toLowerCase()];
      if (!mime) throw new Error("Unsupported repository image type");
      return { content: [{ type: "image" as const, data: (await readFile(file.path)).toString("base64"), mimeType: mime }], details: { path } };
    },
  });
  pi.registerTool({
    name: "repo_list", label: "List repository directory", description: "List a directory within the configured repository root without following symlinks.",
    parameters: Type.Object({ path: Type.Optional(Type.String()) }),
    async execute(_id, { path }) { return text((await inspector.list(path)).join("\n")); },
  });
  pi.registerTool({
    name: "repo_search", label: "Search repository", description: "Bounded literal text search across regular repository files.",
    parameters: Type.Object({ query: Type.String() }),
    async execute(_id, { query }) {
      const result = await inspector.search(query);
      return text(result.matches.map((match) => `${match.path}:${match.line}: ${match.text}`).join("\n") || "No matches.", { count: result.matches.length, truncated: result.truncated });
    },
  });
  pi.registerTool({
    name: "web_fetch", label: "Retrieve public web page", description: "Retrieve bounded public HTTP(S) content. Local/private network and credential-bearing URLs are denied.",
    parameters: Type.Object({ url: Type.String() }),
    async execute(_id, { url }) {
      const result = await fetchPublicWeb(url);
      if (result.contentType.startsWith("image/")) {
        return { content: [{ type: "image" as const, data: result.body.toString("base64"), mimeType: result.contentType.split(";")[0]! }], details: { url: result.url } };
      }
      const raw = result.body.toString("utf8");
      return text(result.contentType.includes("html") ? htmlToText(raw) : raw, { url: result.url, contentType: result.contentType });
    },
  });
  pi.registerTool({
    name: "web_search", label: "Search the public web", description: "Search the public web through DuckDuckGo's HTML endpoint and return bounded result links/snippets.",
    parameters: Type.Object({ query: Type.String({ maxLength: 512 }) }),
    async execute(_id, { query }) {
      const result = await fetchPublicWeb(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`);
      const html = result.body.toString("utf8");
      const rows = [...html.matchAll(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\//gi)].slice(0, 10);
      return text(rows.map((row, index) => `${index + 1}. ${htmlToText(row[2] ?? "")}\n${row[1]}\n${htmlToText(row[3] ?? "")}`).join("\n\n") || "No search results parsed.");
    },
  });
  pi.registerTool({
    name: "system_info", label: "Inspect runtime", description: "Return a small non-sensitive snapshot of the child runtime platform. Does not expose environment variables or execute commands.",
    parameters: Type.Object({}),
    async execute() { return text(JSON.stringify({ platform: process.platform, arch: process.arch, node: process.version, cwd: process.cwd() })); },
  });
}
