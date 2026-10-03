import { setTimeout as delay } from "node:timers/promises";
import { loadCapabilityProfile } from "./capabilities.js";
import { hasGogRuntime, resolveGoogleRuntime, runGogJson } from "../.pi/lib/google-transport.js";

type Json = Record<string, any>;
type Method = "getProfile" | "messages.list" | "messages.get";
type Run = (method: Method, params: Json, signal: AbortSignal) => Promise<unknown>;
export interface MailChallenge { takeCode(requestedAt: number, signal: AbortSignal): Promise<string | undefined> }
const object = (value: unknown): Json | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;
const mailbox = (value: unknown): string | undefined => {
  if (typeof value !== "string" || value.length > 500 || /[\r\n]/.test(value)) return;
  const address = (value.match(/^[^<>]*<([^<>]+)>$/)?.[1] ?? value).trim().toLowerCase();
  return /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(address) ? address : undefined;
};
const siteDomain = (domain: string) => domain === "opentable.com" || domain.endsWith(".opentable.com");
const id = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{1,64}$/.test(value);

// Scan forward once. Unclosed markup fails to manual entry rather than letting
// a backtracking tag-removal regex monopolize the host on malformed HTML.
function inlineHtmlText(html: string): string {
  const lower = html.replace(/[A-Z]/g, character => character.toLowerCase()), output: string[] = [];
  let position = 0;
  while (position < html.length) {
    const open = html.indexOf("<", position);
    if (open < 0) { output.push(html.slice(position)); break; }
    output.push(html.slice(position, open), " ");
    if (html.startsWith("<!--", open)) {
      const end = html.indexOf("-->", open + 4);
      if (end < 0) throw new Error();
      position = end + 3; continue;
    }
    const end = html.indexOf(">", open + 1);
    if (end < 0) throw new Error();
    const hidden = lower.slice(open + 1, end).match(/^\s*(script|style)\b/)?.[1];
    if (hidden) {
      const close = lower.indexOf(`</${hidden}`, end + 1);
      const closeEnd = close < 0 ? -1 : html.indexOf(">", close);
      if (closeEnd < 0) throw new Error();
      position = closeEnd + 1;
    } else position = end + 1;
  }
  return output.join("");
}

/** Deterministic parsing only. Message text is data, never a prompt or an action. */
export function extractOpenTableCode(raw: unknown, recipient: string, requestedAt: number, now: number): string | undefined {
  try {
    const message = object(raw), payload = object(message?.payload);
    const received = Number(message?.internalDate);
    if (!Number.isSafeInteger(received) || received < requestedAt || received > now || now - received > 60_000 || !payload || !Array.isArray(payload.headers)) return;
    const header = (name: string): string | undefined => {
      const matches = payload.headers.filter((h: any) => h?.name?.toLowerCase() === name);
      return matches.length === 1 && typeof matches[0].value === "string" && matches[0].value.length <= 4_096 ? matches[0].value : undefined;
    };
    const from = mailbox(header("from")), to = mailbox(header("to"));
    if (!from || !to || to !== mailbox(recipient) || !siteDomain(from.split("@")[1]!)) return;
    const authentication = header("authentication-results")?.replace(/\r?\n[ \t]+/g, " ");
    // Trust only the receiving Gmail server's single authentication result, with
    // DMARC aligned to the actual From domain. Forwarded/uncertain mail is manual.
    if (!authentication?.startsWith("mx.google.com;")) return;
    const dmarc = authentication.split(";").find(part => /^\s*dmarc=pass\b/i.test(part));
    const verifiedDomain = dmarc?.match(/\bheader\.from=([a-z0-9.-]+)(?:\s|$)/i)?.[1]?.toLowerCase();
    if (verifiedDomain !== from.split("@")[1]) return;
    const subject = header("subject");
    if (!subject || !/\b(?:verification|security|sign[ -]?in|log[ -]?in)\s+code\b|\bcode\b.{0,40}\b(?:verify|verification|sign[ -]?in|log[ -]?in)\b|\bopentable\s+code\b/i.test(subject)) return;
    const plain: string[] = [], html: string[] = [];
    let parts = 0, bytes = 0;
    const visit = (part: Json, depth: number) => {
      if (++parts > 32 || depth > 6) throw new Error();
      if (part.filename) return; // Never fetch an attachment or follow a link.
      const data = part.body?.data;
      if (["text/plain", "text/html"].includes(part.mimeType) && typeof data === "string") {
        if (data.length > 200_000 || !/^[A-Za-z0-9_\-]*={0,2}$/.test(data)) throw new Error();
        const decoded = Buffer.from(data, "base64url"); bytes += decoded.length;
        if (bytes > 150_000) throw new Error();
        const text = new TextDecoder("utf-8", { fatal: true }).decode(decoded);
        (part.mimeType === "text/plain" ? plain : html).push(text);
      }
      if (Array.isArray(part.parts)) for (const child of part.parts) { const selected = object(child); if (!selected) throw new Error(); visit(selected, depth + 1); }
    };
    visit(payload, 0);
    let text = plain.length ? plain.join("\n") : inlineHtmlText(html.join("\n"))
      .replace(/&#(?:x([0-9a-f]+)|(\d+));/gi, (_all, hex, decimal) => String.fromCodePoint(parseInt(hex ?? decimal, hex ? 16 : 10)))
      .replace(/&(?:nbsp|amp|lt|gt|quot|apos);/gi, " ");
    if (!text) return;
    text = `${subject}\n${text}`.replace(/https?:\/\/\S+/gi, " ");
    const codes = new Set([...text.matchAll(/(?<![\w])\d{6}(?![\w])/g)].map(match => match[0]));
    return codes.size === 1 ? [...codes][0] : undefined;
  } catch { return; }
}

function messageIds(payload: unknown): string[] | undefined {
  const data = object(payload);
  if (!data || data.nextPageToken || (data.messages !== undefined && !Array.isArray(data.messages))) return;
  const rows = data.messages ?? [];
  if (rows.length > 6 || rows.some((row: any) => !id(row?.id))) return;
  const ids = rows.map((row: any) => row.id) as string[];
  return new Set(ids).size === ids.length ? ids : undefined;
}
const listParams = (after: number) => ({ userId: "me", maxResults: 6, includeSpamTrash: false,
  q: `from:opentable.com after:${Math.floor(after / 1000)} {subject:code subject:verification}` });

/** Call before triggering delivery. This object stays inside the private flow. */
export async function createMailChallenge(recipient: string, run: Run, signal: AbortSignal): Promise<MailChallenge | undefined> {
  try {
    const email = mailbox(recipient);
    if (!email || signal.aborted) return;
    const profile = object(await run("getProfile", { userId: "me", fields: "emailAddress" }, signal));
    if (mailbox(profile?.emailAddress) !== email) return;
    const baseline = messageIds(await run("messages.list", listParams(Date.now() - 60_000), signal));
    if (!baseline || signal.aborted) return;
    const previous = new Set(baseline);
    let used = false;
    return { async takeCode(requestedAt, parentSignal) {
      if (used) return;
      used = true;
      const bounded = AbortSignal.any([parentSignal, AbortSignal.timeout(8_000)]);
      try {
        for (let attempt = 0; attempt < 5 && !bounded.aborted; attempt++) {
          const listed = messageIds(await run("messages.list", listParams(requestedAt), bounded));
          if (!listed) return;
          const candidates = listed.filter(value => !previous.has(value));
          if (candidates.length > 1) return; // Never guess the newest of several.
          if (candidates.length === 1) {
            const message = object(await run("messages.get", { userId: "me", id: candidates[0], format: "full" }, bounded));
            if (bounded.aborted || message?.id !== candidates[0]) return;
            return extractOpenTableCode(message, email, requestedAt, Date.now());
          }
          if (attempt < 4) await delay(1_250, undefined, { signal: bounded });
        }
      } catch { return; } // No error, body, code, or command output escapes.
    } };
  } catch { return; }
}

export async function preparePrivateEmailCode(config: { resourceRoot: string; capabilityProfile: string }, recipient: string, signal: AbortSignal): Promise<MailChallenge | undefined> {
  try {
    const profile = await loadCapabilityProfile(config.resourceRoot, config.capabilityProfile);
    if (!profile.extensionPaths.some(path => path.endsWith("/.pi/extensions/google-workspace.ts"))) return;
    const runtime = await resolveGoogleRuntime();
    if (!hasGogRuntime(runtime) || !runtime.account || !/^[a-zA-Z0-9@._+\-]{1,254}$/.test(runtime.account)) return;
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(8_000)]);
    const run: Run = (method, params, stepSignal) => runGogJson({ binary: runtime.binary, passwordFile: runtime.passwordFile, gogHome: runtime.gogHome,
      args: ["--no-input", "--readonly", "--gmail-no-send", "--json", "--account", runtime.account!,
        "api", "call", "gmail", "v1", `gmail.users.${method}`, "--scope=https://www.googleapis.com/auth/gmail.readonly", `--params=${JSON.stringify(params)}`],
      signal: stepSignal, timeoutMs: 5_000, maxOutputBytes: 256_000 });
    return createMailChallenge(recipient, run, bounded);
  } catch { return; }
}
