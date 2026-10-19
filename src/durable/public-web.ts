import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { Type } from '@earendil-works/pi-ai';
import { defineTool } from '@earendil-works/pi-durable';
import { createPinnedLookup, htmlToText, privateAddress } from '../../.pi/extensions/subagents/inspection.js';
import { textToolResult, type NativeBundle } from './registry.js';

export const WEB_OUTPUT_MAX_BYTES = 50 * 1024;
export const WEB_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;
export const WEB_TOTAL_TIMEOUT_MS = 20_000;
export const WEB_MAX_REDIRECTS = 5;
const SEARCH_RESULT_LIMIT = 10;
const SEARCH_SOURCE = 'DuckDuckGo HTML search (html.duckduckgo.com)';

export interface WebAddress { address: string; family: number }
export interface WebResponse {
  status: number;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  body: AsyncIterable<Uint8Array>;
  destroy(): void;
}
export interface PublicWebDeps {
  /** Resolves every address for a host. Default: system DNS. */
  lookup?(hostname: string): Promise<WebAddress[]>;
  /** Performs one request to a validated, address-pinned target. No redirect following. */
  request?(url: URL, addresses: readonly WebAddress[], signal: AbortSignal): Promise<WebResponse>;
  timeoutMs?: number;
}

class WebError extends Error {}

function defaultRequest(url: URL, addresses: readonly WebAddress[], signal: AbortSignal): Promise<WebResponse> {
  const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const client = request(url, {
      agent:false,
      headers: { connection:'close', 'user-agent': 'pi-read-only-research/1.0', accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5' },
      lookup: createPinnedLookup([...addresses]), signal,
    }, response => resolve({
      status: response.statusCode ?? 0, headers: response.headers, body: response, destroy: () => response.destroy(),
    }));
    client.once('error', reject);
    client.end();
  });
}

/** DNS promises have no cancellation API. Bound the wait and consume late
 * settlement; a late response must release its socket instead of escaping abort. */
function abortable<T>(run:()=>Promise<T>,signal:AbortSignal,onLate?:(value:T)=>void):Promise<T> {
 return new Promise((resolve,reject)=>{
  const abort=()=>{signal.removeEventListener('abort',abort);reject(signal.reason);};
  signal.addEventListener('abort',abort,{once:true});
  if(signal.aborted){abort();return;}
  Promise.resolve().then(()=>{signal.throwIfAborted();return run();}).then(value=>{
   signal.removeEventListener('abort',abort);
   if(signal.aborted){onLate?.(value);reject(signal.reason);}else resolve(value);
  },error=>{signal.removeEventListener('abort',abort);reject(error);});
 });
}

async function resolveTarget(input: string, deps: PublicWebDeps,signal:AbortSignal): Promise<{ url: URL; addresses: WebAddress[] }> {
  let url: URL;
  try { url = new URL(input); } catch { throw new WebError('Invalid URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new WebError('Only HTTP(S) URLs are allowed');
  if (url.username || url.password) throw new WebError('URLs with credentials are not allowed');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (!hostname) throw new WebError('Invalid URL');
  if (/^localhost\.?$|\.localhost\.?$/i.test(hostname)) throw new WebError('Local or private web targets are not allowed');
  const literal = isIP(hostname);
  let addresses: WebAddress[];
  try {
    addresses = literal ? [{ address: hostname, family: literal }] : await abortable(()=>(deps.lookup ?? (h => dnsLookup(h, { all: true })))(hostname),signal);
  } catch (error) { if(signal.aborted)throw error;throw new WebError(`Could not resolve host ${hostname}`); }
  if (addresses.length === 0 || addresses.some(({ address }) => privateAddress(address))) throw new WebError('Local or private web targets are not allowed');
  return { url, addresses };
}

/** Reads a bounded body, destroying the response as soon as the cap or the signal trips. */
async function readBody(response: WebResponse, signal: AbortSignal): Promise<Buffer> {
  if(signal.aborted){response.destroy();signal.throwIfAborted();}
  const onAbort = () => response.destroy();
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const value of response.body) {
      size += value.byteLength;
      if (size > WEB_RESPONSE_MAX_BYTES) { response.destroy(); throw new WebError('Web response exceeds the 2 MiB retrieval limit'); }
      chunks.push(Buffer.from(value));
    }
    signal.throwIfAborted();
    return Buffer.concat(chunks);
  } finally { signal.removeEventListener('abort', onAbort); }
}

export async function fetchBounded(input: string, deps: PublicWebDeps, signal: AbortSignal): Promise<{ url: string; contentType: string; body: Buffer }> {
  let target = await resolveTarget(input, deps,signal);
  for (let redirects = 0; redirects <= WEB_MAX_REDIRECTS; redirects++) {
    signal.throwIfAborted();
    const response = await abortable(()=>(deps.request ?? defaultRequest)(target.url, target.addresses, signal),signal,response=>response.destroy());
    if (response.status >= 300 && response.status < 400) {
      const raw = response.headers.location;
      const location = Array.isArray(raw) ? raw[0] : raw;
      response.destroy();
      if (!location) throw new WebError('Web redirect omitted its destination');
      if (redirects === WEB_MAX_REDIRECTS) break;
      let next: string;
      try { next = new URL(location, target.url).href; } catch { throw new WebError('Web redirect destination is invalid'); }
      target = await resolveTarget(next, deps,signal);
      continue;
    }
    if (response.status < 200 || response.status >= 300) { response.destroy(); throw new WebError(`Web request failed with HTTP ${response.status}`); }
    const declared = Number(response.headers['content-length'] ?? 0);
    if (declared > WEB_RESPONSE_MAX_BYTES) { response.destroy(); throw new WebError('Web response exceeds the 2 MiB retrieval limit'); }
    const type = response.headers['content-type'];
    return { url: target.url.href, contentType: (Array.isArray(type) ? type[0] : type) ?? 'application/octet-stream', body: await readBody(response, signal) };
  }
  throw new WebError(`Too many web redirects (limit ${WEB_MAX_REDIRECTS})`);
}

/** Truncates to the byte budget on a character boundary and says so. */
export function boundOutput(text: string, max = WEB_OUTPUT_MAX_BYTES): string {
  if (Buffer.byteLength(text) <= max) return text;
  const note = '\n[Output truncated at 50 KB]';
  let cut = Buffer.from(text).subarray(0, max - Buffer.byteLength(note)).toString('utf8');
  if (cut.endsWith('\uFFFD')) cut = cut.slice(0, -1);
  return cut + note;
}

export function decodeDuckDuckGoLink(href: string): string {
  const raw = href.replace(/&amp;/g, '&');
  try {
    const url = new URL(raw, 'https://duckduckgo.com');
    const target = (url.hostname==='duckduckgo.com'||url.hostname.endsWith('.duckduckgo.com')) && url.pathname === '/l/' ? url.searchParams.get('uddg') : null;
    const result=new URL(target??url.href);
    return ['http:','https:'].includes(result.protocol)?result.href:'';
  } catch { return ''; }
}

export function parseSearchResults(html: string): Array<{ title: string; url: string; snippet: string }> {
  const links=[...html.matchAll(/<a\b(?=[^>]*\bclass="[^"]*\bresult__a\b[^"]*")(?=[^>]*\bhref="([^"]*)")[^>]*>([\s\S]*?)<\/a>/gi)];
  return links.slice(0,SEARCH_RESULT_LIMIT).map((link,i)=>{
    // Stop before the next result so a missing snippet cannot borrow its text.
    const block=html.slice(link.index!+link[0].length,links[i+1]?.index??html.length);
    const snippet=block.match(/class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\//i);
    return {title:htmlToText(link[2]??'').slice(0,300),url:decodeDuckDuckGoLink(link[1]??''),snippet:htmlToText(snippet?.[1]??'').slice(0,800)};
  }).filter(row=>row.url);
}

function blockedPage(html: string): boolean {
  return /anomaly|unusual traffic|captcha|challenge-form|are you a human/i.test(html);
}

async function guarded(deps: PublicWebDeps, signal: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<string>) {
  const timeout = AbortSignal.timeout(deps.timeoutMs ?? WEB_TOTAL_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    return textToolResult(boundOutput(await run(combined)));
  } catch (error) {
    if (signal?.aborted) throw error;
    if (timeout.aborted) return textToolResult(`Web request timed out after ${(deps.timeoutMs ?? WEB_TOTAL_TIMEOUT_MS) / 1000} seconds`, true);
    if (error instanceof WebError) return textToolResult(error.message, true);
    return textToolResult(`Web request failed: ${error instanceof Error ? error.message : String(error)}`, true);
  }
}

export function createPublicWebBundle(deps: PublicWebDeps = {}): NativeBundle {
  return {
    name: 'public-web', version: 1,
    tools: [
      { version: 1, tool: defineTool({
        name: 'web_fetch', replay: 'safe',
        description: 'Retrieve bounded public HTTP(S) content as text (50 KB output, 2 MiB download, 20 s, 5 redirects). Local/private network and credential-bearing URLs are denied.',
        parameters: Type.Object({ url: Type.String({ minLength: 1, maxLength: 2048 }) }),
        execute: ({ url }, _api, context) => guarded(deps, context.abortSignal, async signal => {
          const result = await fetchBounded(url, deps, signal);
          const type = result.contentType.split(';')[0]!.trim().toLowerCase();
          if (!(type.startsWith('text/') || /json|xml|javascript/.test(type))) {
            return `Source: ${result.url}\nContent-Type: ${type}\n[Binary content (${result.body.byteLength} bytes) not shown]`;
          }
          const raw = result.body.toString('utf8');
          return `Source: ${result.url}\nContent-Type: ${type}\n\n${type.includes('html') ? htmlToText(raw) : raw}`;
        }),
      }) },
      { version: 1, tool: defineTool({
        name: 'web_search', replay: 'safe',
        description: "Search the public web through DuckDuckGo's HTML endpoint and return up to 10 result titles, URLs and snippets.",
        parameters: Type.Object({ query: Type.String({ minLength: 1, maxLength: 512 }) }),
        execute: ({ query }, _api, context) => guarded(deps, context.abortSignal, async signal => {
          const result = await fetchBounded(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, deps, signal);
          const html = result.body.toString('utf8');
          const rows = parseSearchResults(html);
          if (rows.length === 0) {
            throw new WebError(blockedPage(html)
              ? `Search blocked: ${SEARCH_SOURCE} returned a bot-check page instead of results. Try again later.`
              : `No results parsed from ${SEARCH_SOURCE} for this query.`);
          }
          return `Source: ${SEARCH_SOURCE}\n\n${rows.map((row, i) => `${i + 1}. ${row.title}\n${row.url}\n${row.snippet}`).join('\n\n')}`;
        }),
      }) },
    ],
    async close() {},
  };
}
