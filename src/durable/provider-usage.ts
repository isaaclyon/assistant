import type { Models } from '@earendil-works/pi-ai';

/** Native read-only Codex subscription usage. Endpoint and payload shape follow the pinned
 *  @howaboua/pi-codex-conversion client (GET <base>/wham/usage); auth comes only from the explicit Models. */
const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const JWT_CLAIM_PATH = 'https://api.openai.com/auth';
const MAX_BODY_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const UNAVAILABLE = 'Usage is unavailable right now. Try /usage again shortly.';

export interface UsageModelRef { provider: string; modelId: string }
export interface NativeUsageOptions {
  models: Pick<Models, 'getModel' | 'getAuth' | 'checkAuth'>;
  getModel: () => UsageModelRef | undefined | Promise<UsageModelRef | undefined>;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}
interface Window { usedPercent?: number | undefined; windowMinutes?: number | undefined; resetsAt?: number | undefined }
interface Limit { limitId: string; limitName?: string; primary?: Window; secondary?: Window }

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const str = (v: unknown) => typeof v === 'string' && v.trim() ? v : undefined;
const normalize = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, '');

export function isCanonicalCodexBaseUrl(value: string | undefined): boolean {
  if (!value?.trim()) return false;
  try {
    const url = new URL(value);
    const path = url.pathname.replace(/\/+$/, '');
    return url.protocol === 'https:' && url.hostname === 'chatgpt.com' && url.port === '' && !url.username && !url.password && !url.search && !url.hash && (path === '/backend-api' || path === '/backend-api/codex');
  } catch { return false; }
}

function accountIdFromToken(token: string): string | undefined {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return undefined;
    const claims = (JSON.parse(Buffer.from(parts[1] ?? '', 'base64').toString('utf8')) as Record<string, unknown>)?.[JWT_CLAIM_PATH];
    const id = isRecord(claims) ? str(claims.chatgpt_account_id) : undefined;
    return id && /^[A-Za-z0-9._-]{1,128}$/.test(id) ? id : undefined;
  } catch { return undefined; }
}

function parseWindow(value: unknown): Window | undefined {
  if (!isRecord(value)) return undefined;
  const usedPercent = num(value.used_percent);
  const seconds = num(value.limit_window_seconds);
  const windowMinutes = num(value.window_minutes) ?? (seconds === undefined ? undefined : Math.ceil(seconds / 60));
  const resetsAt = num(value.resets_at) ?? num(value.reset_at);
  return usedPercent === undefined && windowMinutes === undefined && resetsAt === undefined ? undefined : { usedPercent, windowMinutes, resetsAt };
}
function parseRateLimit(value: unknown): { primary?: Window | undefined; secondary?: Window | undefined } {
  if (!isRecord(value)) return {};
  const primary = parseWindow(value.primary_window) ?? parseWindow(value.primary);
  const secondary = parseWindow(value.secondary_window) ?? parseWindow(value.secondary);
  if (primary?.windowMinutes === 10_080 && !secondary) return { secondary: primary };
  return { primary, secondary };
}
/** Whitelists allowance fields only; null when the payload is not an object. */
export function parseUsagePayload(payload: unknown): Limit[] | null {
  if (!isRecord(payload)) return null;
  const limits: Limit[] = [];
  const add = (limitId: string, limitName: string | undefined, source: unknown) => {
    const parsed = parseRateLimit(isRecord(source) && 'rate_limit' in source ? source.rate_limit : source);
    limits.push({ limitId, ...(limitName ? { limitName } : {}), ...(parsed.primary ? { primary: parsed.primary } : {}), ...(parsed.secondary ? { secondary: parsed.secondary } : {}) });
  };
  add('codex', undefined, payload.rate_limit);
  if (Array.isArray(payload.additional_rate_limits)) {
    for (const item of payload.additional_rate_limits) if (isRecord(item)) add(str(item.metered_feature) ?? 'additional', str(item.limit_name), item);
  }
  return limits;
}

function timeRemaining(ms: number): string {
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `${Math.floor(minutes / 1440)}d ${Math.floor(minutes % 1440 / 60)}h`;
}
function formatWindow(window: Window, now: number): string[] {
  const minutes = window.windowMinutes;
  const label = minutes === 300 ? '5-hour' : minutes === 10_080 ? 'Weekly' : minutes && minutes > 0 ? `${minutes}-minute` : 'Window';
  const used = window.usedPercent;
  const remaining = used !== undefined && Number.isFinite(used) ? 100 - Math.min(100, Math.max(0, used)) : undefined;
  const lines = [remaining === undefined ? `${label}: usage unavailable` : `${label}: ${Math.round(remaining)}% remaining · ${Math.round(100 - remaining)}% used`];
  const resetMs = window.resetsAt === undefined ? NaN : window.resetsAt * 1000;
  const durationMs = minutes === undefined ? NaN : minutes * 60_000;
  const timeLeft = resetMs - now;
  if (Number.isFinite(resetMs) && Math.abs(resetMs) < 8.64e15) {
    lines.push(timeLeft > 0 ? `Resets in ${timeRemaining(timeLeft)} (${new Date(resetMs).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })})` : 'Reset time has passed; refresh /usage.');
  }
  if (remaining !== undefined && Number.isFinite(durationMs) && durationMs > 0 && timeLeft > 0 && timeLeft <= durationMs) {
    const target = timeLeft / durationMs * 100;
    const difference = Math.round(remaining - target);
    lines.push(`Pace target: ${Math.round(target)}% remaining · ${difference === 0 ? 'on pace' : `${Math.abs(difference)} percentage points ${difference > 0 ? 'under' : 'over'} pace`}`);
  } else lines.push('Even pace unavailable for this window.');
  return lines;
}

/** Pure formatter over normalized limits. */
export function formatUsage(model: { id: string; name: string; provider: string }, limits: readonly Limit[], now: number): string {
  const lines = [`Usage · ${model.name} (${model.provider}/${model.id})`];
  const keys = new Set([normalize(model.id), normalize(model.name)]);
  for (const limit of limits.filter(l => l.limitId === 'codex' || keys.has(normalize(l.limitId)) || (l.limitName && keys.has(normalize(l.limitName))))) {
    const windows = [limit.primary, limit.secondary].filter((w): w is Window => Boolean(w));
    if (!windows.length) continue;
    lines.push('', limit.limitId === 'codex' ? 'Shared Codex allowance' : 'Model allowance');
    for (const window of windows) lines.push(...formatWindow(window, now));
  }
  if (lines.length === 1) lines.push('No allowance data is available for the active model.');
  else lines.push('', 'Pace assumes even use across each window. Shared allowance includes other Codex sessions.');
  return lines.join('\n');
}

async function readBounded(response: Response, signal: AbortSignal): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) { await response.body?.cancel().catch(() => undefined); throw new Error('too large'); }
  if (!response.body) throw new Error('no body');
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', abort, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await raceAbort(reader.read(), signal);
      signal.throwIfAborted();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) throw new Error('too large');
      chunks.push(value);
    }
  } catch (error) { void reader.cancel().catch(() => undefined); throw error; }
  finally { signal.removeEventListener('abort', abort); reader.releaseLock(); }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('aborted'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** Fresh on-demand read; returns only user-facing text and never raw credentials, payloads or errors. */
export function createNativeUsage(options: NativeUsageOptions): () => Promise<string> {
  const { models } = options;
  const transport = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const { signal } = controller;
    try {
      const ref = await raceAbort(Promise.resolve(options.getModel()), signal);
      if (!ref) return 'No active model is selected.';
      const model = models.getModel(ref.provider, ref.modelId);
      if (!model) return UNAVAILABLE;
      const label = `${model.name} (${model.provider})`;
      if (model.provider !== 'openai-codex' || model.api !== 'openai-codex-responses' || !isCanonicalCodexBaseUrl(model.baseUrl)) return `Subscription allowance is unavailable for ${label}.`;
      const check = await raceAbort(models.checkAuth(model.provider, { signal }), signal);
      if (check?.type !== 'oauth') return `Subscription allowance is unavailable for ${label}.`;
      const resolved = await raceAbort(models.getAuth(model, { signal }), signal);
      const token = resolved?.auth.apiKey;
      if ((resolved?.auth.baseUrl !== undefined && !isCanonicalCodexBaseUrl(resolved.auth.baseUrl)) || !token) return UNAVAILABLE;
      const accountId = accountIdFromToken(token);
      if (!accountId) return UNAVAILABLE;
      const pending = transport(USAGE_URL, {
        method: 'GET', redirect: 'error', signal,
        headers: { authorization: `Bearer ${token}`, 'chatgpt-account-id': accountId, accept: 'application/json', 'OAI-Language': 'en', originator: 'pi' },
      });
      // A transport that ignores abort may resolve late; release its body.
      void pending.then(response => { if (signal.aborted) void response.body?.cancel().catch(() => undefined); }, () => {});
      const response = await raceAbort(pending, signal);
      if (!response.ok) { await response.body?.cancel().catch(() => undefined); return UNAVAILABLE; }
      const limits = parseUsagePayload(JSON.parse(await readBounded(response, signal)));
      if (!limits) return UNAVAILABLE;
      const current = await raceAbort(Promise.resolve(options.getModel()), signal);
      if (current?.provider !== ref.provider || current.modelId !== ref.modelId) return 'The active model changed while checking usage. Run /usage again.';
      return formatUsage(model, limits, now());
    } catch { return UNAVAILABLE; }
    finally { clearTimeout(timer); }
  };
}
