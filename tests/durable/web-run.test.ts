import { expect, test, vi } from 'vitest';
import { Value } from 'typebox/value';
import { createWebRunBundle, WEB_RUN_PARAMETERS } from '../../src/durable/web-run.js';

const jwt = (account: unknown) => `h.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: account } })).toString('base64url')}.s`;
const codex = { provider: 'openai-codex', id: 'gpt-5-codex', name: 'GPT Codex', api: 'openai-codex-responses', baseUrl: 'https://chatgpt.com/backend-api/codex' };
type Ref = { provider: string; modelId: string } | undefined;

function harness(over: { model?: unknown; ref?: Ref; check?: unknown; auth?: unknown; fetch?: (url: string, init: RequestInit) => Promise<Response>; sessionId?: (id: string) => string | Promise<string>; timeoutMs?: number } = {}) {
  const model = 'model' in over ? over.model : codex;
  const models = {
    getModel: vi.fn(() => model),
    checkAuth: vi.fn(async () => 'check' in over ? over.check : { type: 'oauth' }),
    getAuth: vi.fn(async () => 'auth' in over ? over.auth : { auth: { apiKey: jwt('acct_1') } }),
  };
  const fetchMock = vi.fn(over.fetch ?? (async () => new Response(JSON.stringify({ output_text: 'hello' }))));
  const bundle = createWebRunBundle({ models: models as never, fetch: fetchMock as never, sessionId: over.sessionId ?? (id => `store-A:${id}`), timeoutMs: over.timeoutMs ?? 200 });
  const tool = bundle.tools[0]!.tool;
  const ref: Ref = 'ref' in over ? over.ref : { provider: 'openai-codex', modelId: 'gpt-5-codex' };
  const run = (args: unknown, signal?: AbortSignal, conversationId = 'c1') =>
    tool.execute(args as never, { conversationId, agent: async () => ({ model: ref }) } as never, { abortSignal: signal } as never);
  return { run, models, fetchMock, tool };
}
const text = (r: { output?: unknown }) => (r.output as Array<{ text: string }>).map(b => b.text).join('');
const sent = (fetchMock: ReturnType<typeof vi.fn>) => {
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  return { url, init, body: JSON.parse(init.body as string) };
};

test('tool is unsafe to replay and its flat schema keeps legacy fields, extras and bounds', () => {
  const { tool } = harness();
  expect(tool.name).toBe('web_run');
  expect(tool.replay).toBe('unsafe');
  expect(Value.Check(WEB_RUN_PARAMETERS, { search_query: [{ q: 'x', extra: 1 }], open: [{ ref_id: 'turn0', lineno: 3 }], click: [{ ref_id: 'a', id: 1 }], find: [{ ref_id: 'a', pattern: 'p' }], image_query: [{ q: 'cat', domains: ['a.com'] }], response_length: 'short', settings: { search_context_size: 'low', more: true }, unknown: 'ok' })).toBe(true);
  expect(Value.Check(WEB_RUN_PARAMETERS, { response_length: 'huge' })).toBe(false);
  expect(Value.Check(WEB_RUN_PARAMETERS, { search_query: [{ q: 'x'.repeat(5000) }] })).toBe(false);
  expect(Value.Check(WEB_RUN_PARAMETERS, { search_query: Array.from({ length: 21 }, () => ({ q: 'x' })) })).toBe(false);
});

test('posts the legacy body to the fixed endpoint with only the fixed headers', async () => {
  const { run, fetchMock } = harness();
  const result = await run({ search_query: [{ q: 'x' }], max_output_tokens: 99999, settings: { search_context_size: 'high', external_web_access: false } });
  expect(result.isError).toBe(false);
  expect(text(result)).toBe('hello');
  const { url, init, body } = sent(fetchMock);
  expect(url).toBe('https://chatgpt.com/backend-api/codex/alpha/search');
  expect(init.method).toBe('POST');
  expect(init.redirect).toBe('error');
  expect(init.headers).toEqual({ authorization: `Bearer ${jwt('acct_1')}`, 'chatgpt-account-id': 'acct_1', originator: 'codex_cli_rs', version: '0.0.0', 'user-agent': 'codex_cli_rs/0.0.0 (codex-compatible)', 'content-type': 'application/json' });
  expect(body).toEqual({ id: 'store-A:c1', model: 'gpt-5-codex', commands: { search_query: [{ q: 'x' }] }, settings: { search_context_size: 'high', external_web_access: false, allowed_callers: ['direct'] }, max_output_tokens: 2500 });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('defaults settings, uses a stable per-store session id, ignores ambient model env, and follows the agent model', async () => {
  vi.stubEnv('PI_CODEX_MODEL', 'ambient-model');
  vi.stubEnv('HTTPS_PROXY', 'http://127.0.0.1:1');
  try {
    const a = harness();
    await a.run({ open: [{ ref_id: 'r' }] }); await a.run({ open: [{ ref_id: 'r' }] }, undefined, 'c2');
    const calls = a.fetchMock.mock.calls.map(c => JSON.parse((c[1] as RequestInit).body as string));
    expect(calls[0]).toMatchObject({ id: 'store-A:c1', model: 'gpt-5-codex', settings: { allowed_callers: ['direct'], external_web_access: true } });
    expect(calls[1].id).toBe('store-A:c2');
    const b = harness({ sessionId: id => `store-B:${id}` });
    await b.run({ find: [{ ref_id: 'r', pattern: 'p' }] });
    expect(sent(b.fetchMock).body.id).toBe('store-B:c1');
    const m = harness({ model: { ...codex, id: 'other-model' }, ref: { provider: 'openai-codex', modelId: 'other-model' } });
    await m.run({ open: [{ ref_id: 'r' }] });
    expect(sent(m.fetchMock).body.model).toBe('other-model');
    expect(m.models.getModel).toHaveBeenCalledWith('openai-codex', 'other-model');
  } finally { vi.unstubAllEnvs(); }
});

test.each([
  ['no model selected', { ref: undefined }],
  ['non-codex provider', { model: { ...codex, provider: 'openai', api: 'openai-responses' } }],
  ['other api', { model: { ...codex, api: 'openai-responses' } }],
  ['foreign base url', { model: { ...codex, baseUrl: 'https://evil.example/backend-api' } }],
  ['api-key auth', { check: { type: 'api-key' } }],
])('unsupported: %s makes no request', async (_name, over) => {
  const { run, fetchMock } = harness(over as never);
  const result = await run({ search_query: [{ q: 'x' }] });
  expect(result.isError).toBe(true);
  expect(text(result)).toMatch(/requires an OpenAI Codex subscription/);
  expect(fetchMock).not.toHaveBeenCalled();
});

test.each([
  ['missing auth', { auth: undefined }],
  ['no token', { auth: { auth: {} } }],
  ['token without account claim', { auth: { auth: { apiKey: 'plain-secret-token' } } }],
  ['foreign auth base url', { auth: { auth: { apiKey: jwt('a'), baseUrl: 'https://evil.example' } } }],
])('auth failure: %s is a fixed error with no leak', async (_name, over) => {
  const { run, fetchMock } = harness(over as never);
  const result = await run({ search_query: [{ q: 'x' }] });
  expect(result.isError).toBe(true);
  expect(text(result)).toBe('web_run is unavailable right now.');
  expect(fetchMock).not.toHaveBeenCalled();
});

test('response forms normalize, whitelist fields and fall back to results when text is empty', async () => {
  const respond = (value: unknown) => harness({ fetch: async () => new Response(JSON.stringify(value)) }).run({ search_query: [{ q: 'x' }] });
  expect(text(await respond({ output: 'legacy text', results: [{ title: 'ignored' }], secret: 'LEAK' }))).toBe('legacy text');
  const fallback = text(await respond({ output_text: '  ', search_results: [{ title: 'T', url: 'https://a.example', token: 'LEAK', nested: { x: 1 } }, 'junk'], secret: 'LEAK' }));
  expect(JSON.parse(fallback)).toEqual({ search_results: [{ title: 'T', url: 'https://a.example' }] });
  expect(fallback).not.toContain('LEAK');
  expect(JSON.parse(text(await respond({ output: '', results: 'nope' })))).toEqual({ search_results: [] });
  for (const bad of [{ other: 'LEAK' }, ['x'], 'str', null]) {
    const result = await respond(bad);
    expect(result.isError).toBe(true);
    expect(text(result)).toBe('web_run search returned an invalid response.');
  }
  const notJson = await harness({ fetch: async () => new Response('<html>LEAK') }).run({});
  expect(text(notJson)).toBe('web_run search returned an invalid response.');
});

test('output over 50 KiB is truncated with an explicit note', async () => {
  const big = 'é'.repeat(40_000);
  const result = await harness({ fetch: async () => new Response(JSON.stringify({ output_text: big })) }).run({});
  expect(Buffer.byteLength(text(result))).toBeLessThanOrEqual(50 * 1024);
  expect(text(result)).toContain('[Output truncated at 50 KB]');
});

test('known HTTP failures map to fixed messages without raw bodies or retries', async () => {
  const status = async (code: number, body: string, headers: Record<string, string> = {}) => {
    const h = harness({ fetch: async () => new Response(body, { status: code, headers }) });
    const result = await h.run({ search_query: [{ q: 'x' }] });
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(true);
    expect(text(result)).not.toMatch(/LEAK|acct_1|Bearer/);
    return text(result);
  };
  expect(await status(403, 'x', { 'cf-mitigated': 'challenge' })).toBe('web_run search failed: HTTP 403 Cloudflare challenge.');
  expect(await status(403, '<html>Cloudflare LEAK</html>')).toBe('web_run search failed: HTTP 403 Cloudflare challenge.');
  expect(await status(403, 'plain LEAK')).toBe('web_run search failed: HTTP 403.');
  expect(await status(404, '{"error":"Not Found"} LEAK')).toMatch(/HTTP 404 \(endpoint unavailable/);
  expect(await status(500, 'LEAK acct_1')).toBe('web_run search failed: HTTP 500.');
  const redirected = harness({ fetch: async () => { throw new TypeError('redirect LEAK acct_1'); } });
  expect(text(await redirected.run({}))).toBe('web_run search request failed.');
});

test('declared and streamed bodies over 8 MiB fail as too large and the stream is cancelled', async () => {
  const declared = await harness({ fetch: async () => new Response('{}', { headers: { 'content-length': String(9 * 1024 * 1024) } }) }).run({});
  expect(text(declared)).toBe('web_run search response exceeded the 8 MiB limit.');
  const cancel = vi.fn();
  const chunk = new Uint8Array(1024 * 1024);
  const stream = new ReadableStream<Uint8Array>({ pull: c => c.enqueue(chunk), cancel });
  const streamed = await harness({ fetch: async () => new Response(stream) }).run({});
  expect(text(streamed)).toBe('web_run search response exceeded the 8 MiB limit.');
  expect(cancel).toHaveBeenCalled();
});

test('an oversized request body fails before fetch', async () => {
  const { run, fetchMock } = harness();
  const result = await run({ search_query: [{ q: 'x', blob: 'y'.repeat(300 * 1024) }] });
  expect(text(result)).toBe('web_run request exceeds the 256 KiB limit.');
  expect(fetchMock).not.toHaveBeenCalled();
});

test('deadline covers uncooperative auth, fetch, session id and body, and cancels late results', async () => {
  const never = () => new Promise<never>(() => {});
  const timedOut = 'web_run search timed out after 0.05 seconds.';
  const auth = harness({ timeoutMs: 50 }); auth.models.checkAuth.mockImplementation(never as never);
  expect(text(await auth.run({}))).toBe(timedOut);
  const session = harness({ timeoutMs: 50, sessionId: never });
  expect(text(await session.run({}))).toBe(timedOut);
  expect(session.fetchMock).not.toHaveBeenCalled();
  const hung = harness({ timeoutMs: 50, fetch: never });
  expect(text(await hung.run({}))).toBe(timedOut);
  const cancel = vi.fn();
  let late!: (r: Response) => void;
  const lateFetch = harness({ timeoutMs: 50, fetch: () => new Promise<Response>(resolve => { late = resolve; }) });
  expect(text(await lateFetch.run({}))).toBe(timedOut);
  late(new Response(new ReadableStream({ cancel })));
  await vi.waitFor(() => expect(cancel).toHaveBeenCalled());
  const bodyCancel = vi.fn();
  const body = harness({ timeoutMs: 50, fetch: async () => new Response(new ReadableStream({ pull: () => new Promise(() => {}), cancel: bodyCancel })) });
  expect(text(await body.run({}))).toBe(timedOut);
  await vi.waitFor(() => expect(bodyCancel).toHaveBeenCalled());
});

test('parent abort rejects instead of returning a tool result, before and during the request', async () => {
  const controller = new AbortController();
  controller.abort(new Error('stop'));
  const pre = harness();
  await expect(pre.run({}, controller.signal)).rejects.toThrow('stop');
  expect(pre.fetchMock).not.toHaveBeenCalled();
  const live = new AbortController();
  const h = harness({ timeoutMs: 5000, fetch: () => new Promise<Response>(() => {}) });
  const pending = h.run({}, live.signal);
  await vi.waitFor(() => expect(h.fetchMock).toHaveBeenCalled());
  live.abort(new Error('user stop'));
  await expect(pending).rejects.toThrow('user stop');
});
