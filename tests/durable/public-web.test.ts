import { expect, it } from 'vitest';
import { BACKGROUND_CONTEXT, type Context } from '@earendil-works/chord/context';
import type { ToolExecutionApi } from '@earendil-works/pi-durable';
import { boundOutput, createPublicWebBundle, decodeDuckDuckGoLink, parseSearchResults, WEB_OUTPUT_MAX_BYTES, type PublicWebDeps, type WebResponse } from '../../src/durable/public-web.js';

const api = {} as ToolExecutionApi;
const PUBLIC = [{ address: '93.184.216.34', family: 4 }];
function reply(status: number, headers: Record<string, string>, body: string | AsyncIterable<Uint8Array>): WebResponse {
  const iterable = typeof body === 'string' ? (async function* () { yield Buffer.from(body); })() : body;
  return { status, headers, body: iterable, destroy() { destroyed++; } };
}
let destroyed = 0;
function tools(deps: PublicWebDeps) {
  const bundle = createPublicWebBundle(deps);
  const run = (name: string, args: unknown, context: Context = BACKGROUND_CONTEXT) =>
    bundle.tools.find(t => t.tool.name === name)!.tool.execute(args as never, api, context) as Promise<{ output: Array<{ text: string }>; isError?: boolean }>;
  return { bundle, run, text: async (name: string, args: unknown, context?: Context) => { const r = await run(name, args, context); return { text: r.output[0]!.text, isError: Boolean(r.isError) }; } };
}
const ctxWith = (abortSignal: AbortSignal): Context => ({ ...BACKGROUND_CONTEXT, abortSignal });

it('declares two replay-safe tools in the public-web bundle', () => {
  const { bundle } = tools({});
  expect(bundle.name).toBe('public-web');
  expect(bundle.tools.map(t => [t.tool.name, t.tool.replay])).toEqual([['web_fetch', 'safe'], ['web_search', 'safe']]);
});

it('fetches and converts HTML with source and pinned addresses', async () => {
  const seen: unknown[] = [];
  const t = tools({ lookup: async () => PUBLIC, request: async (url, addresses) => { seen.push([url.href, addresses]); return reply(200, { 'content-type': 'text/html; charset=utf-8' }, '<p>Hello <b>web</b></p><script>x()</script>'); } });
  const r = await t.text('web_fetch', { url: 'https://example.com/a' });
  expect(r.isError).toBe(false);
  expect(r.text).toBe('Source: https://example.com/a\nContent-Type: text/html\n\nHello web');
  expect(seen).toEqual([['https://example.com/a', PUBLIC]]);
});

it('rejects credentials, non-HTTP schemes, local and private targets before any request', async () => {
  let requests = 0;
  const lookups: Record<string, string> = { 'internal.example': '10.0.0.5', 'rebind.example': '127.0.0.1' };
  const t = tools({ lookup: async h => [{ address: lookups[h] ?? '93.184.216.34', family: 4 }], request: async () => { requests++; return reply(200, { 'content-type': 'text/plain' }, 'x'); } });
  for (const url of ['https://user:pw@example.com/', 'file:///etc/passwd', 'ftp://example.com/', 'http://127.0.0.1/', 'http://localhost:8080/',
    'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://169.254.169.254/latest', 'http://192.168.1.1/', 'https://internal.example/', 'https://rebind.example/', 'not a url']) {
    const r = await t.text('web_fetch', { url });
    expect(r.isError, url).toBe(true);
  }
  expect(requests).toBe(0);
});

it('rejects hosts whose resolution fails or mixes public and private addresses', async () => {
  const t = tools({ lookup: async h => { if (h === 'gone.example') throw new Error('ENOTFOUND'); return [...PUBLIC, { address: '10.1.1.1', family: 4 }]; }, request: async () => { throw new Error('unreachable'); } });
  expect((await t.text('web_fetch', { url: 'https://mixed.example/' })).text).toContain('private');
  expect((await t.text('web_fetch', { url: 'https://gone.example/' })).text).toContain('resolve');
});

it('revalidates DNS on every redirect hop and blocks hops into private space', async () => {
  const resolved: string[] = [];
  const t = tools({
    lookup: async h => { resolved.push(h); return [{ address: h === 'evil.example' ? '192.168.0.9' : '93.184.216.34', family: 4 }]; },
    request: async url => url.hostname === 'a.example' ? reply(302, { location: 'https://evil.example/x' }, '') : reply(200, { 'content-type': 'text/plain' }, 'no'),
  });
  const r = await t.text('web_fetch', { url: 'https://a.example/' });
  expect(r).toMatchObject({ isError: true }); expect(r.text).toContain('private');
  expect(resolved).toEqual(['a.example', 'evil.example']);
});

it('follows up to five redirects and rejects the sixth', async () => {
  const chain = (hops: number) => tools({ lookup: async () => PUBLIC, request: async url => {
    const n = Number(url.pathname.slice(1) || 0);
    return n < hops ? reply(301, { location: `/${n + 1}` }, '') : reply(200, { 'content-type': 'text/plain' }, `done ${n}`);
  } });
  expect((await chain(5).text('web_fetch', { url: 'https://r.example/' })).text).toContain('done 5');
  const over = await chain(6).text('web_fetch', { url: 'https://r.example/' });
  expect(over).toMatchObject({ isError: true }); expect(over.text).toContain('Too many');
});

it('enforces the 2 MiB cap by declared length and while streaming, then destroys the response', async () => {
  destroyed = 0;
  const declared = tools({ lookup: async () => PUBLIC, request: async () => reply(200, { 'content-type': 'text/plain', 'content-length': String(3 * 1024 * 1024) }, 'x') });
  expect((await declared.text('web_fetch', { url: 'https://big.example/' })).text).toContain('2 MiB');
  expect(destroyed).toBe(1);
  const streamed = tools({ lookup: async () => PUBLIC, request: async () => reply(200, { 'content-type': 'text/plain' }, (async function* () { for (let i = 0; i < 100; i++) yield Buffer.alloc(64 * 1024, 97); })()) });
  expect((await streamed.text('web_fetch', { url: 'https://big.example/' })).text).toContain('2 MiB');
  expect(destroyed).toBe(2);
});

it('bounds output to 50 KB on a character boundary and marks truncation', async () => {
  const t = tools({ lookup: async () => PUBLIC, request: async () => reply(200, { 'content-type': 'text/plain' }, '€'.repeat(100_000)) });
  const r = await t.text('web_fetch', { url: 'https://long.example/' });
  expect(Buffer.byteLength(r.text)).toBeLessThanOrEqual(WEB_OUTPUT_MAX_BYTES);
  expect(r.text).toContain('truncated'); expect(r.text).not.toContain('\uFFFD');
  expect(boundOutput('short')).toBe('short');
});

it('does not print binary content', async () => {
  const t = tools({ lookup: async () => PUBLIC, request: async () => reply(200, { 'content-type': 'application/pdf' }, '%PDF-1.4') });
  expect((await t.text('web_fetch', { url: 'https://f.example/a.pdf' })).text).toContain('Binary content');
});

it('surfaces HTTP failures and times out the whole operation', async () => {
  const bad = tools({ lookup: async () => PUBLIC, request: async () => reply(503, {}, '') });
  expect(await bad.text('web_fetch', { url: 'https://x.example/' })).toMatchObject({ isError: true });
  const slow = tools({ timeoutMs: 30, lookup: async () => PUBLIC, request: async (_u, _a, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))) });
  const r = await slow.text('web_fetch', { url: 'https://slow.example/' });
  expect(r).toMatchObject({ isError: true }); expect(r.text).toContain('timed out');
});

it('times out while a body stalls', async () => {
  const t = tools({ timeoutMs: 30, lookup: async () => PUBLIC, request: async (_u, _a, signal) => reply(200, { 'content-type': 'text/plain' }, (async function* () {
    yield Buffer.from('partial'); await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  })()) });
  expect((await t.text('web_fetch', { url: 'https://stall.example/' })).text).toContain('timed out');
});

it('propagates caller cancellation as a rejection', async () => {
  const controller = new AbortController();
  const t = tools({ lookup: async () => PUBLIC, request: async (_u, _a, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))) });
  const pending = t.run('web_fetch', { url: 'https://slow.example/' }, ctxWith(controller.signal));
  setTimeout(() => controller.abort(new Error('cancelled')), 10);
  await expect(pending).rejects.toThrow('cancelled');
  const already = AbortSignal.abort(new Error('before'));
  await expect(t.run('web_search', { query: 'x' }, ctxWith(already))).rejects.toThrow('before');
});

const DDG = `<div><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fpage%3Fa%3D1&amp;rut=abc">Example <b>Title</b></a>
<a class="result__snippet" href="x">A &amp; B snippet</a></div>`;

it('searches DuckDuckGo with the query encoded, decoding result links and naming the source', async () => {
  const urls: string[] = [];
  const t = tools({ lookup: async () => PUBLIC, request: async url => { urls.push(url.href); return reply(200, { 'content-type': 'text/html' }, DDG); } });
  const r = await t.text('web_search', { query: 'cats & dogs' });
  expect(urls).toEqual(['https://html.duckduckgo.com/html/?q=cats%20%26%20dogs']);
  expect(r.isError).toBe(false);
  expect(r.text).toBe('Source: DuckDuckGo HTML search (html.duckduckgo.com)\n\n1. Example Title\nhttps://example.org/page?a=1\nA & B snippet');
});

it('reports bot-check pages and empty results as errors', async () => {
  const blocked = tools({ lookup: async () => PUBLIC, request: async () => reply(200, { 'content-type': 'text/html' }, '<div class="anomaly-modal">Unfortunately, bots use DuckDuckGo too.</div>') });
  expect(await blocked.text('web_search', { query: 'q' })).toMatchObject({ isError: true, text: expect.stringContaining('blocked') });
  const empty = tools({ lookup: async () => PUBLIC, request: async () => reply(200, { 'content-type': 'text/html' }, '<html>nothing</html>') });
  expect(await empty.text('web_search', { query: 'q' })).toMatchObject({ isError: true, text: expect.stringContaining('No results') });
});

it('limits search results to ten and the output to 50 KB', async () => {
  const rows = Array.from({ length: 30 }, (_, i) => `<a class="result__a" href="https://e.example/${i}">T${i}</a><a class="result__snippet">${'s'.repeat(10_000)}</a>`).join('');
  const t = tools({ lookup: async () => PUBLIC, request: async () => reply(200, { 'content-type': 'text/html' }, rows) });
  const r = await t.text('web_search', { query: 'q' });
  expect(r.text).toContain('10. T9'); expect(r.text).not.toContain('11. T10');
  expect(Buffer.byteLength(r.text)).toBeLessThanOrEqual(WEB_OUTPUT_MAX_BYTES);
});

it('close is idempotent', async () => {
  const { bundle } = tools({});
  await bundle.close(); await bundle.close();
});

it('bounds a stalled DNS wait and cancels DNS before requesting a socket', async () => {
  let requests=0;
  const t=tools({timeoutMs:20,lookup:()=>new Promise(()=>{}),request:async()=>{requests++;return reply(200,{},'');}});
  expect((await t.text('web_fetch',{url:'https://dns.example/'})).text).toContain('timed out');
  const controller=new AbortController();
  const pending=t.run('web_fetch',{url:'https://dns.example/'},ctxWith(controller.signal));
  controller.abort(new Error('DNS_CANCELLED'));
  await expect(pending).rejects.toThrow('DNS_CANCELLED');expect(requests).toBe(0);
});

it('destroys a response that arrives after its request deadline',async()=>{
  let respond!:(value:WebResponse)=>void;
  const t=tools({timeoutMs:20,lookup:async()=>PUBLIC,request:()=>new Promise(resolve=>{respond=resolve;})});
  expect((await t.text('web_fetch',{url:'https://late.example/'})).text).toContain('timed out');
  destroyed=0;respond(reply(200,{},'late'));await Promise.resolve();await Promise.resolve();
  expect(destroyed).toBe(1);
});


it('pairs optional snippets with their own search result and drops non-web targets',()=>{
 const rows=parseSearchResults('<a class="result__a" href="https://one.example/">One</a><a href="https://two.example/" class="result__a">Two</a><a class="result__snippet">Second snippet</a><a class="result__a" href="javascript:alert(1)">Invalid</a>');
 expect(rows).toEqual([{title:'One',url:'https://one.example/',snippet:''},{title:'Two',url:'https://two.example/',snippet:'Second snippet'}]);
 expect(decodeDuckDuckGoLink('https://evilduckduckgo.com/l/?uddg=https%3A%2F%2Fother.example%2F')).toBe('https://evilduckduckgo.com/l/?uddg=https%3A%2F%2Fother.example%2F');
 expect(decodeDuckDuckGoLink('https://duckduckgo.com/l/?uddg=javascript%3Aalert(1)')).toBe('');
});

it('destroys a response when the request aborts before body consumption begins',async()=>{
 const controller=new AbortController();destroyed=0;
 const t=tools({lookup:async()=>PUBLIC,request:async()=>{controller.abort(new Error('BEFORE_BODY'));return reply(200,{},(async function*(){await new Promise(()=>{});})());}});
 await expect(t.run('web_fetch',{url:'https://race.example/'},ctxWith(controller.signal))).rejects.toThrow('BEFORE_BODY');
 expect(destroyed).toBe(1);
});
