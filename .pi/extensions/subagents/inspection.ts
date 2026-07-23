import { lookup } from "node:dns/promises";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { isIP } from "node:net";
import { basename, relative, resolve, sep } from "node:path";

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SEARCH_FILES = 5_000;

function inside(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}${sep}`);
}
async function rootsReal(roots: string[]): Promise<string[]> {
  return Promise.all(roots.map((root) => realpath(root)));
}
function privateAddress(address: string): boolean {
  if (address === "::1" || address === "0.0.0.0" || address === "::") return true;
  if (address.startsWith("10.") || address.startsWith("127.") || address.startsWith("192.168.") || address.startsWith("169.254.")) return true;
  const second = Number(address.split(".")[1]);
  if (address.startsWith("172.") && second >= 16 && second <= 31) return true;
  const lower = address.toLowerCase();
  return lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb");
}

export async function validatePublicWebUrl(input: string): Promise<URL> {
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error("Only credential-free HTTP(S) URLs are allowed");
  const addresses = isIP(url.hostname) ? [{ address: url.hostname }] : await lookup(url.hostname, { all: true });
  if (addresses.length === 0 || addresses.some(({ address }) => privateAddress(address))) throw new Error("Local or private web targets are not allowed");
  return url;
}

export async function fetchPublicWeb(input: string): Promise<{ url: string; contentType: string; body: Buffer }> {
  let url = await validatePublicWebUrl(input);
  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
      headers: { "user-agent": "pi-read-only-research/1.0" },
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("Web redirect omitted its destination");
      url = await validatePublicWebUrl(new URL(location, url).href);
      continue;
    }
    if (!response.ok) throw new Error(`Web request failed with HTTP ${response.status}`);
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > MAX_FILE_BYTES) throw new Error("Web response exceeds the retrieval limit");
    const reader = response.body?.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_FILE_BYTES) {
          await reader.cancel();
          throw new Error("Web response exceeds the retrieval limit");
        }
        chunks.push(Buffer.from(value));
      }
    }
    return { url: url.href, contentType: response.headers.get("content-type") ?? "application/octet-stream", body: Buffer.concat(chunks) };
  }
  throw new Error("Too many web redirects");
}

export function htmlToText(html: string): string {
  return html.replace(/<script\b[\s\S]*?<\/script>/gi, " ").replace(/<style\b[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
}

export function createRepositoryInspector(roots: string[]) {
  const resolveFile = async (input: string): Promise<{ root: string; path: string }> => {
    const canonicalRoots = await rootsReal(roots);
    for (const root of canonicalRoots) {
      const candidate = resolve(root, input);
      if (!inside(root, candidate)) continue;
      try {
        const target = await realpath(candidate);
        const stat = await lstat(candidate);
        if (!inside(root, target)) throw new Error("Path resolves outside configured roots");
        if (stat.isSymbolicLink()) throw new Error("Symlink reads are not allowed");
        if (!stat.isFile()) throw new Error("Only regular files may be read");
        if (stat.size > MAX_FILE_BYTES) throw new Error("File exceeds the read limit");
        return { root, path: target };
      } catch (error) {
        if (error instanceof Error && /outside|symlink|regular|limit/.test(error.message)) throw error;
      }
    }
    throw new Error("Path is outside configured roots or unavailable");
  };
  return {
    async read(path: string): Promise<string> {
      const file = await resolveFile(path);
      return readFile(file.path, "utf8");
    },
    async list(path = "."): Promise<string[]> {
      const canonicalRoots = await rootsReal(roots);
      const root = canonicalRoots[0]!;
      const target = await realpath(resolve(root, path));
      if (!inside(root, target)) throw new Error("Path resolves outside configured roots");
      return (await readdir(target, { withFileTypes: true })).filter((entry) => !entry.isSymbolicLink()).map((entry) => `${entry.isDirectory() ? "d" : "f"} ${entry.name}`).sort();
    },
    async search(query: string): Promise<{ matches: Array<{ path: string; line: number; text: string }>; truncated: boolean }> {
      if (!query || query.length > 512) throw new Error("Search query must be 1-512 characters");
      const canonicalRoots = await rootsReal(roots);
      const matches: Array<{ path: string; line: number; text: string }> = [];
      let scanned = 0;
      const needle = query.toLowerCase();
      for (const root of canonicalRoots) {
        const walk = async (dir: string): Promise<void> => {
          if (scanned >= MAX_SEARCH_FILES || matches.length >= 200) return;
          for (const entry of await readdir(dir, { withFileTypes: true })) {
            if (entry.isSymbolicLink() || entry.name === ".git" || entry.name === "node_modules") continue;
            const path = resolve(dir, entry.name);
            if (entry.isDirectory()) await walk(path);
            else if (entry.isFile() && scanned++ < MAX_SEARCH_FILES) {
              const stat = await lstat(path);
              if (stat.size > MAX_FILE_BYTES) continue;
              const text = await readFile(path, "utf8").catch(() => "");
              for (const [index, line] of text.split(/\r?\n/).entries()) {
                if (line.toLowerCase().includes(needle)) matches.push({ path: relative(root, path) || basename(path), line: index + 1, text: line.slice(0, 500) });
                if (matches.length >= 200) return;
              }
            }
          }
        };
        await walk(root);
      }
      return { matches, truncated: scanned >= MAX_SEARCH_FILES || matches.length >= 200 };
    },
    resolveFile,
  };
}
