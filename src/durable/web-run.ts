/* Adapted from @howaboua/pi-codex-web-run (MIT; see web-run-LICENSE.txt): the web_run parameter schema, request body
 * and response normalization. Transport, auth and error handling are native: fixed endpoint, explicit Models auth,
 * no proxy/cookie jar, no redirects, no retry, bounded and normalized output. */
import { Type, type Models } from '@earendil-works/pi-ai';
import { defineTool } from '@earendil-works/pi-durable';
import { boundOutput } from './public-web.js';
import { isCanonicalCodexBaseUrl } from './provider-usage.js';
import { textToolResult, type NativeBundle } from './registry.js';

export const WEB_RUN_URL = 'https://chatgpt.com/backend-api/codex/alpha/search';
export const WEB_RUN_MAX_OUTPUT_TOKENS = 2_500;
export const WEB_RUN_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const WEB_RUN_TIMEOUT_MS = 60_000;
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_ERROR_BODY_BYTES = 64 * 1024;
const JWT_CLAIM_PATH = 'https://api.openai.com/auth';
const RESULT_FIELDS = ['ref_id', 'id', 'title', 'url', 'snippet', 'text', 'source', 'domain', 'date', 'published_at', 'lineno'] as const;

const MESSAGES = {
  unsupported: 'web_run requires an OpenAI Codex subscription model in the explicitly selected native account.',
  unavailable: 'web_run is unavailable right now.',
  challenge: 'web_run search failed: HTTP 403 Cloudflare challenge.',
  notFound: 'web_run search failed: HTTP 404 (endpoint unavailable for this account).',
  invalid: 'web_run search returned an invalid response.',
  tooLarge: 'web_run search response exceeded the 8 MiB limit.',
  tooBig: 'web_run request exceeds the 256 KiB limit.',
  failed: 'web_run search request failed.',
} as const;
const timedOutMessage = (ms: number) => `web_run search timed out after ${ms / 1000} seconds.`;

export interface WebRunOptions {
  models: Pick<Models, 'getModel' | 'checkAuth' | 'getAuth'>;
  /** Stable server-side search session id for a conversation. Must be distinct per store/instance (for example,
   *  derived from the store identity plus the conversation id) so refs cannot collide across stores. */
  sessionId: (conversationId: string) => string | Promise<string>;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const str = (max: number) => Type.String({ maxLength: max });
const SearchQuery = Type.Object({
  q: str(2048),
  recency: Type.Optional(Type.Number({ description: 'Days' })),
  domains: Type.Optional(Type.Array(str(256), { maxItems: 50 })),
}, { additionalProperties: true });
export const WEB_RUN_PARAMETERS = Type.Object({
  search_query: Type.Optional(Type.Array(SearchQuery, { maxItems: 20 })),
  image_query: Type.Optional(Type.Array(SearchQuery, { maxItems: 20 })),
  open: Type.Optional(Type.Array(Type.Object({ ref_id: str(2048), lineno: Type.Optional(Type.Number()) }, { additionalProperties: true }), { description: 'ref_id or URL', maxItems: 20 })),
  click: Type.Optional(Type.Array(Type.Object({ ref_id: str(2048), id: Type.Number() }, { additionalProperties: true }), { maxItems: 20 })),
  find: Type.Optional(Type.Array(Type.Object({ ref_id: str(2048), pattern: str(1024) }, { additionalProperties: true }), { maxItems: 20 })),
  response_length: Type.Optional(Type.Union([Type.Literal('short'), Type.Literal('medium'), Type.Literal('long')])),
  settings: Type.Optional(Type.Object({
    search_context_size: Type.Optional(Type.Union([Type.Literal('low'), Type.Literal('medium'), Type.Literal('high')])),
  }, { additionalProperties: true })),
}, { additionalProperties: true });

class WebRunError extends Error {}
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export function buildWebRunRequest(params: Record<string, unknown>, options: { id: string; model: string }): Record<string, unknown> {
  const { settings: configured, max_output_tokens: _ignored, ...commands } = params;
  const settings: Record<string, unknown> = isRecord(configured) ? { ...configured } : {};
  settings['allowed_callers'] ??= ['direct'];
  settings['external_web_access'] ??= true;
  return { id: options.id, model: options.model, commands, settings, max_output_tokens: WEB_RUN_MAX_OUTPUT_TOKENS };
}

function cleanResults(value: unknown[]): Array<Record<string, string | number>> {
  const rows: Array<Record<string, string | number>> = [];
  for (const item of value.slice(0, 50)) {
    if (!isRecord(item)) continue;
    const row: Record<string, string | number> = {};
    for (const key of RESULT_FIELDS) {
      const v = item[key];
      if (typeof v === 'string') row[key] = v.slice(0, 2000);
      else if (typeof v === 'number' && Number.isFinite(v)) row[key] = v;
    }
    if (Object.keys(row).length) rows.push(row);
  }
  return rows;
}

/** Accepts {output_text, search_results} or {output, results}; any other field is dropped. */
export function normalizeWebRunResponse(value: unknown): string {
  if (!isRecord(value)) throw new WebRunError(MESSAGES.invalid);
  let text: unknown;
  let results: unknown;
  if (typeof value['output_text'] === 'string' || Array.isArray(value['search_results'])) { text = value['output_text']; results = value['search_results']; }
  else if (typeof value['output'] === 'string') { text = value['output']; results = value['results']; }
  else throw new WebRunError(MESSAGES.invalid);
  if (typeof text === 'string' && text.trim()) return text;
  return JSON.stringify({ search_results: Array.isArray(results) ? cleanResults(results) : [] }, null, 2);
}

function accountIdFromToken(token: string): string | undefined {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return undefined;
    const claims = (JSON.parse(Buffer.from(parts[1] ?? '', 'base64').toString('utf8')) as Record<string, unknown>)?.[JWT_CLAIM_PATH];
    const id = isRecord(claims) && typeof claims['chatgpt_account_id'] === 'string' ? claims['chatgpt_account_id'] : undefined;
    return id && /^[A-Za-z0-9._-]{1,128}$/.test(id) ? id : undefined;
  } catch { return undefined; }
}

/** Rejects when the signal aborts even if `promise` never settles; `onLate` receives a value that settles afterward. */
function race<T>(promise: Promise<T>, signal: AbortSignal, onLate?: (value: T) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('aborted'));
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    promise.then(value => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) { onLate?.(value); abort(); } else resolve(value);
    }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}

async function readText(response: Response, max: number, signal: AbortSignal): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) { void response.body?.cancel().catch(() => undefined); throw new WebRunError(MESSAGES.tooLarge); }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await race(reader.read(), signal);
      if (done) break;
      total += value.byteLength;
      if (total > max) throw new WebRunError(MESSAGES.tooLarge);
      chunks.push(value);
    }
    try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); } catch { throw new WebRunError(MESSAGES.invalid); }
  } catch (error) { cancel(); throw error; }
  finally { signal.removeEventListener('abort', cancel); try { reader.releaseLock(); } catch { /* pending read */ } }
}

async function search(args: Record<string, unknown>, options: WebRunOptions, conversationId: string, modelRef: { provider: string; modelId: string } | undefined, signal: AbortSignal): Promise<string> {
  const { models } = options;
  const model = modelRef ? models.getModel(modelRef.provider, modelRef.modelId) : undefined;
  if (!model || model.provider !== 'openai-codex' || model.api !== 'openai-codex-responses' || !isCanonicalCodexBaseUrl(model.baseUrl)) throw new WebRunError(MESSAGES.unsupported);
  const check = await race(models.checkAuth(model.provider, { signal }), signal);
  if (check?.type !== 'oauth') throw new WebRunError(MESSAGES.unsupported);
  const resolved = await race(models.getAuth(model, { signal }), signal);
  const token = resolved?.auth.apiKey;
  if ((resolved?.auth.baseUrl !== undefined && !isCanonicalCodexBaseUrl(resolved.auth.baseUrl)) || !token) throw new WebRunError(MESSAGES.unavailable);
  const accountId = accountIdFromToken(token);
  if (!accountId) throw new WebRunError(MESSAGES.unavailable);
  const id = await race(Promise.resolve(options.sessionId(conversationId)), signal);
  if (typeof id !== 'string' || !id) throw new WebRunError(MESSAGES.unavailable);
  const body = JSON.stringify(buildWebRunRequest(args, { id, model: model.id }));
  if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) throw new WebRunError(MESSAGES.tooBig);
  // Never retried: the server mutates its ref state per request.
  const pending = (options.fetch ?? fetch)(WEB_RUN_URL, {
    method: 'POST', redirect: 'error', signal, body,
    headers: {
      authorization: `Bearer ${token}`, 'chatgpt-account-id': accountId, originator: 'codex_cli_rs', version: '0.0.0',
      'user-agent': 'codex_cli_rs/0.0.0 (codex-compatible)', 'content-type': 'application/json',
    },
  });
  const response = await race(pending, signal, late => { void late.body?.cancel().catch(() => undefined); });
  if (response.status < 200 || response.status >= 300) {
    let text = '';
    if (response.status === 403) { try { text = await readText(response, MAX_ERROR_BODY_BYTES, signal); } catch (error) { if (signal.aborted) throw error; } }
    else void response.body?.cancel().catch(() => undefined);
    if (response.status === 403 && (response.headers.get('cf-mitigated')?.toLowerCase() === 'challenge' || /cloudflare/i.test(text))) throw new WebRunError(MESSAGES.challenge);
    if (response.status === 404) throw new WebRunError(MESSAGES.notFound);
    throw new WebRunError(`web_run search failed: HTTP ${Number.isInteger(response.status) ? response.status : 0}.`);
  }
  let parsed: unknown;
  const raw = await readText(response, WEB_RUN_MAX_RESPONSE_BYTES, signal);
  try { parsed = JSON.parse(raw); } catch { throw new WebRunError(MESSAGES.invalid); }
  return normalizeWebRunResponse(parsed);
}

/** Native web_run. Replay is unsafe: the search backend keeps per-session ref state that a rerun would change.
 *  The model comes from the conversation's own agent (api.agent(context).model), never from the environment. */
export function createWebRunBundle(options: WebRunOptions): NativeBundle {
  const timeoutMs = options.timeoutMs ?? WEB_RUN_TIMEOUT_MS;
  if(!Number.isFinite(timeoutMs)||timeoutMs<=0||timeoutMs>120_000)throw new RangeError('Invalid hosted web deadline');
  return {
    name: 'web-run', version: 1,
    tools: [{ version: 1, tool: defineTool({
      name: 'web_run', replay: 'unsafe',
      description: 'Search and browse the web through the Codex search service: search_query, image_query, open, click and find commands. Output is capped at 50 KB.',
      parameters: WEB_RUN_PARAMETERS,
      execute: async (args, api, context) => {
        const parent = context.abortSignal;
        const timer = new AbortController();
        const handle = setTimeout(() => timer.abort(), timeoutMs);
        const signal = parent ? AbortSignal.any([parent, timer.signal]) : timer.signal;
        try {
          const agent = await race(api.agent(context), signal);
          return textToolResult(boundOutput(await search(args as Record<string, unknown>, options, String(api.conversationId), agent.model, signal)));
        } catch (error) {
          if (parent?.aborted) throw error;
          if (timer.signal.aborted) return textToolResult(timedOutMessage(timeoutMs), true);
          return textToolResult(error instanceof WebRunError ? error.message : MESSAGES.failed, true);
        } finally { clearTimeout(handle); }
      },
    }) }],
    close: async () => {},
  };
}
