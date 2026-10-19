import { expect, test, vi } from 'vitest';
import { createNativeUsage, formatUsage, parseUsagePayload } from '../../src/durable/provider-usage.js';

const NOW = Date.UTC(2026, 0, 1, 0, 0, 0);
const jwt = (account: unknown) => `h.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: account } })).toString('base64url')}.s`;
const codex = { provider: 'openai-codex', id: 'gpt-5-codex', name: 'GPT Codex', api: 'openai-codex-responses', baseUrl: 'https://chatgpt.com/backend-api' };
const payload = {
  secret_extra: 'LEAK',
  rate_limit: { primary_window: { used_percent: 25, limit_window_seconds: 18000, reset_at: (NOW + 9_000_000) / 1000 }, secondary_window: { used_percent: 10, window_minutes: 10080 } },
  additional_rate_limits: [
    { metered_feature: 'gpt_5_codex', limit_name: 'GPT 5 Codex', rate_limit: { primary_window: { used_percent: 50, window_minutes: 60 } } },
    { metered_feature: 'other', limit_name: 'Other Model', rate_limit: { primary_window: { used_percent: 99, window_minutes: 60 } } },
  ],
};
function harness(over: { model?: unknown; check?: unknown; auth?: unknown; fetch?: typeof fetch; active?: () => unknown } = {}) {
  const model = 'model' in over ? over.model : codex;
  const models = {
    getModel: vi.fn(() => model), checkAuth: vi.fn(async () => 'check' in over ? over.check : { type: 'oauth' }),
    getAuth: vi.fn(async () => 'auth' in over ? over.auth : { auth: { apiKey: jwt('acct_1') } }),
  };
  const fetchMock = vi.fn(over.fetch ?? (async () => new Response(JSON.stringify(payload))));
  const usage = createNativeUsage({ models: models as never, getModel: (over.active ?? (() => ({ provider: 'openai-codex', modelId: 'gpt-5-codex' }))) as never, fetch: fetchMock as never, now: () => NOW, timeoutMs: 200 });
  return { usage, models, fetchMock };
}

test('requests the fixed endpoint with derived account header and formats shared plus active-model windows only', async () => {
  const { usage, fetchMock } = harness();
  const text = await usage();
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe('https://chatgpt.com/backend-api/wham/usage');
  expect(init.redirect).toBe('error');
  expect((init.headers as Record<string, string>)['chatgpt-account-id']).toBe('acct_1');
  expect(text).toContain('Usage · GPT Codex (openai-codex/gpt-5-codex)');
  expect(text).toContain('Shared Codex allowance');
  expect(text).toContain('5-hour: 75% remaining · 25% used');
  expect(text).toContain('Weekly: 90% remaining');
  expect(text).toContain('Resets in 2h 30m');
  expect(text).toContain('Pace target: 50% remaining · 25 percentage points under pace');
  expect(text).toContain('Model allowance');
  expect(text).toContain('60-minute: 50% remaining');
  expect(text).not.toContain('99%');
  expect(text).not.toContain('LEAK');
});

test('refuses unsupported models and non-oauth auth without any request', async () => {
  for (const h of [
    harness({ model: { ...codex, provider: 'openai' } }),
    harness({ model: { ...codex, baseUrl: 'https://evil.example/backend-api' } }),
    harness({ check: { type: 'api_key' } }),
  ]) {
    expect(await h.usage()).toMatch(/^Subscription allowance is unavailable/);
    expect(h.fetchMock).not.toHaveBeenCalled();
  }
  expect(await harness({ active: () => undefined }).usage()).toBe('No active model is selected.');
});

test('unavailable auth, bad account, bad base URL, http errors and malformed bodies never leak', async () => {
  const token = jwt('acct_1');
  const cases = [
    harness({ auth: undefined }), harness({ auth: { auth: { apiKey: 'not-a-jwt' } } }), harness({ auth: { auth: { apiKey: jwt('bad account') } } }),
    harness({ auth: { auth: { apiKey: token, baseUrl: 'https://evil.example' } } }),
    harness({ fetch: async () => new Response(`${token}`, { status: 500 }) }),
    harness({ fetch: async () => new Response('not json') }),
    harness({ fetch: async () => new Response('[1]') }),
    harness({ fetch: async () => { throw new Error(`boom ${token}`); } }),
  ];
  for (const h of cases) {
    const text = await h.usage();
    expect(text).toBe('Usage is unavailable right now. Try /usage again shortly.');
  }
  expect(cases[0]?.fetchMock).not.toHaveBeenCalled();
});

test('bounds streaming bodies and the overall deadline including auth', async () => {
  const big = new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(100_000)); } });
  expect(await harness({ fetch: async () => new Response(big) }).usage()).toMatch(/unavailable right now/);
  const slowAuth = harness();
  slowAuth.models.getAuth.mockImplementation(() => new Promise(() => undefined));
  expect(await slowAuth.usage()).toMatch(/unavailable right now/);
  const slowFetch = harness({ fetch: (_u, init) => new Promise((_r, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('x')))) });
  expect(await slowFetch.usage()).toMatch(/unavailable right now/);
});

test('detects an active model change during the request', async () => {
  let calls = 0;
  const h = harness({ active: () => ++calls === 1 ? { provider: 'openai-codex', modelId: 'gpt-5-codex' } : { provider: 'openai-codex', modelId: 'other' } });
  expect(await h.usage()).toBe('The active model changed while checking usage. Run /usage again.');
});

test('parser whitelists fields and formatter handles stale resets and missing data', () => {
  expect(parseUsagePayload(null)).toBeNull();
  expect(JSON.stringify(parseUsagePayload(payload))).not.toContain('LEAK');
  const stale = formatUsage({ id: 'x', name: 'X', provider: 'p' }, [{ limitId: 'codex', primary: { usedPercent: 0, windowMinutes: 300, resetsAt: NOW / 1000 - 5 } }], NOW);
  expect(stale).toContain('Reset time has passed');
  expect(stale).toContain('Even pace unavailable');
  expect(formatUsage({ id: 'x', name: 'X', provider: 'p' }, [{ limitId: 'codex' }], NOW)).toContain('No allowance data');
});


test('deadline bounds uncooperative transport, late responses, body reads and the final model recheck', async () => {
 const late=Promise.withResolvers<Response>(),cancel=vi.fn();
 const h=harness({fetch:()=>late.promise});
 expect(await h.usage()).toMatch(/unavailable right now/);
 late.resolve(new Response(new ReadableStream({cancel})));
 await vi.waitFor(()=>expect(cancel).toHaveBeenCalledOnce());
 const stalledBody=new ReadableStream({start(){},cancel});
 expect(await harness({fetch:async()=>new Response(stalledBody)}).usage()).toMatch(/unavailable right now/);
 expect(cancel).toHaveBeenCalledTimes(2);
 let count=0;
 const changed=harness({active:()=>++count===1?{provider:'openai-codex',modelId:'gpt-5-codex'}:new Promise(()=>{})});
 expect(await changed.usage()).toMatch(/unavailable right now/);
});
