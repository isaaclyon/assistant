import { lookup } from "node:dns/promises";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { basename, relative, resolve, sep } from "node:path";

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SEARCH_FILES = 5_000;
const NON_PUBLIC_NETWORKS = new BlockList();

for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10],
  ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) NON_PUBLIC_NETWORKS.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 96], ["::1", 128], ["64:ff9b::", 96], ["64:ff9b:1::", 48],
  ["100::", 64], ["2001::", 23], ["2001:db8::", 32], ["2002::", 16],
  ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
] as const) NON_PUBLIC_NETWORKS.addSubnet(network, prefix, "ipv6");

function inside(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}${sep}`);
}
async function rootsReal(roots: string[]): Promise<string[]> {
  return Promise.all(roots.map((root) => realpath(root)));
}
function privateAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4
    ? NON_PUBLIC_NETWORKS.check(address, "ipv4")
    : family === 6
      ? NON_PUBLIC_NETWORKS.check(address, "ipv6")
      : true;
}

interface PublicWebTarget {
  url: URL;
  addresses: Array<{ address: string; family: number }>;
}

async function resolvePublicWebTarget(input: string): Promise<PublicWebTarget> {
  const url = new URL(input);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Only credential-free HTTP(S) URLs are allowed");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const literalFamily = isIP(hostname);
  const addresses = literalFamily ? [{ address: hostname, family: literalFamily }] : await lookup(hostname, { all: true });
  if (addresses.length === 0 || addresses.some(({ address }) => privateAddress(address))) throw new Error("Local or private web targets are not allowed");
  return { url, addresses };
}

export function createPinnedLookup(addresses: Array<{ address: string; family: number }>): LookupFunction {
  return (_hostname, options, callback) => {
    const candidates = options.family && options.family !== 0
      ? addresses.filter(({ family }) => family === options.family)
      : addresses;
    if (candidates.length === 0) {
      const error = Object.assign(new Error("No validated address matches the requested family"), { code: "ENOTFOUND" });
      callback(error, "", 0);
      return;
    }
    if (options.all) callback(null, candidates);
    else callback(null, candidates[0]!.address, candidates[0]!.family);
  };
}

async function requestPublicWeb(target: PublicWebTarget): Promise<IncomingMessage> {
  const request = target.url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolveResponse, reject) => {
    const client = request(target.url, {
      headers: { "user-agent": "pi-read-only-research/1.0" },
      lookup: createPinnedLookup(target.addresses),
      signal: AbortSignal.timeout(20_000),
    }, resolveResponse);
    client.once("error", reject);
    client.end();
  });
}

export async function validatePublicWebUrl(input: string): Promise<URL> {
  return (await resolvePublicWebTarget(input)).url;
}

export async function fetchPublicWeb(input: string): Promise<{ url: string; contentType: string; body: Buffer }> {
  let target = await resolvePublicWebTarget(input);
  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await requestPublicWeb(target);
    const status = response.statusCode ?? 0;
    if (status >= 300 && status < 400) {
      const location = response.headers.location;
      if (!location) throw new Error("Web redirect omitted its destination");
      response.resume();
      target = await resolvePublicWebTarget(new URL(location, target.url).href);
      continue;
    }
    if (status < 200 || status >= 300) {
      response.resume();
      throw new Error(`Web request failed with HTTP ${status}`);
    }
    const declared = Number(response.headers["content-length"] ?? 0);
    if (declared > MAX_FILE_BYTES) {
      response.destroy();
      throw new Error("Web response exceeds the retrieval limit");
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const value of response) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      size += chunk.byteLength;
      if (size > MAX_FILE_BYTES) {
        response.destroy();
        throw new Error("Web response exceeds the retrieval limit");
      }
      chunks.push(chunk);
    }
    return { url: target.url.href, contentType: response.headers["content-type"] ?? "application/octet-stream", body: Buffer.concat(chunks) };
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
      const candidateInsideRoot = inside(root, candidate);
      try {
        const target = await realpath(candidate);
        const stat = await lstat(candidate);
        if (!inside(root, target)) {
          if (candidateInsideRoot) throw new Error("Path resolves outside configured roots");
          continue;
        }
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
  const resolveDirectory = async (input: string): Promise<string> => {
    const canonicalRoots = await rootsReal(roots);
    for (const root of canonicalRoots) {
      const candidate = resolve(root, input);
      const candidateInsideRoot = inside(root, candidate);
      try {
        const target = await realpath(candidate);
        const stat = await lstat(candidate);
        if (!inside(root, target)) {
          if (candidateInsideRoot) throw new Error("Path resolves outside configured roots");
          continue;
        }
        if (stat.isSymbolicLink()) throw new Error("Symlink listings are not allowed");
        if (!stat.isDirectory()) throw new Error("Only directories may be listed");
        return target;
      } catch (error) {
        if (error instanceof Error && /outside|symlink|directories/.test(error.message)) throw error;
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
      const target = await resolveDirectory(path);
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
