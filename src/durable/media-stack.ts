import { connect } from 'node:net';
import { StringEnum, Type } from '@earendil-works/pi-ai';
import { defineTool } from '@earendil-works/pi-durable';
import type { NativeConfig } from './config.js';
import { textToolResult, type NativeBundle } from './registry.js';

const RESPONSE_LIMIT = 160 * 1024;
const TIMEOUT_MS = 35_000;
const object = <T extends Parameters<typeof Type.Object>[0]>(properties: T) => Type.Object(properties, { additionalProperties: false });

const readParameters = object({
  operation: StringEnum(['health', 'queue', 'upcoming', 'library_search', 'request_search', 'request_list'] as const),
  query: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  kind: Type.Optional(StringEnum(['any', 'movie', 'series'] as const)),
  days: Type.Optional(Type.Integer({ minimum: 1, maximum: 14 })),
  filter: Type.Optional(StringEnum(['all', 'pending', 'approved', 'processing', 'available', 'unavailable', 'failed'] as const)),
  take: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
});
const requestParameters = object({
  media_type: StringEnum(['movie', 'tv'] as const),
  media_id: Type.Integer({ minimum: 1, maximum: 2147483647 }),
  seasons: Type.Optional(Type.Array(Type.Integer({ minimum: 0, maximum: 500 }), { minItems: 1, maxItems: 50 })),
  all_seasons: Type.Optional(Type.Boolean()),
});

const readDescription = 'Read the home media stack (Sonarr, Radarr, Prowlarr, Seerr): service health, download queues, upcoming releases, library lookups, Seerr title search and the Seerr request list. Read-only. Search with request_search to get media_id values for media_request. No shell, raw API or settings access.';
const requestDescription = 'Ask Seerr to request one movie or TV title that the user clearly asked for. Use request_search first and pass the exact media_type and media_id. TV needs seasons (list) or all_seasons. A duplicate is reported, not repeated. Does not delete, restart or change settings.';

type Outcome = { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } };
const unavailable = (code: string, message: string): Outcome => ({ ok: false, error: { code, message } });

/** One request per connection; the gateway owns SSH, host identity and the allowlist. */
export function callMediaGateway(socketPath: string, operation: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<Outcome> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let data = Buffer.alloc(0);
    let done = false;
    const settle = (value: Outcome) => { if (!done) { done = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); socket.destroy(); resolve(value); } };
    const onAbort = () => { if (!done) { done = true; clearTimeout(timer); socket.destroy(); reject(signal?.reason ?? new Error('Aborted')); } };
    const timer = setTimeout(() => settle(unavailable('MEDIA_TIMEOUT', 'The media gateway did not answer in time')), TIMEOUT_MS);
    signal?.addEventListener('abort', onAbort, { once: true });
    socket.on('connect', () => socket.write(`${JSON.stringify({ op: operation, args })}\n`));
    socket.on('data', (chunk) => {
      data = Buffer.concat([data, chunk]);
      if (data.length > RESPONSE_LIMIT) settle(unavailable('MEDIA_RESPONSE_TOO_LARGE', 'The media response is too large'));
    });
    socket.on('error', () => settle(unavailable('MEDIA_GATEWAY_UNAVAILABLE', 'The media gateway is unavailable')));
    socket.on('end', () => {
      try {
        const parsed = JSON.parse(data.toString('utf8'));
        if (parsed && typeof parsed === 'object' && typeof parsed.ok === 'boolean') return settle(parsed as Outcome);
      } catch { /* fall through */ }
      settle(unavailable('MEDIA_GATEWAY_UNAVAILABLE', 'The media gateway returned an invalid response'));
    });
  });
}

const present = (outcome: Outcome) => textToolResult(JSON.stringify(outcome.ok ? { ok: true, result: outcome.result, error: null } : { ok: false, result: null, error: outcome.error }), !outcome.ok);

/** Without gateway configuration the bundle registers no tools, so existing instances start unchanged. */
export function createMediaStackBundle(config: NativeConfig, call: typeof callMediaGateway = callMediaGateway): NativeBundle {
  const socketPath = config.mediaStack?.socketPath;
  if (!socketPath) return { name: 'media-stack', version: 1, tools: [], close: async () => {} };
  const run = (operation: string, args: Record<string, unknown>, signal?: AbortSignal) => call(socketPath, operation, args, signal);
  return {
    name: 'media-stack', version: 1, close: async () => {},
    tools: [
      { version: 1, tool: defineTool({ name: 'media_stack', description: readDescription, parameters: readParameters, replay: 'safe',
        execute: async (raw, _api, context) => {
          const { operation, ...rest } = raw as Record<string, unknown> & { operation: string };
          return present(await run(operation, Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined)), context.abortSignal));
        } }) },
      { version: 1, tool: defineTool({ name: 'media_request', description: requestDescription, parameters: requestParameters, replay: 'unsafe',
        execute: async (raw, _api, context) => {
          const input = raw as { media_type: 'movie' | 'tv'; media_id: number; seasons?: number[]; all_seasons?: boolean };
          if (input.media_type === 'movie' && (input.seasons || input.all_seasons)) return present(unavailable('INPUT_INVALID', 'Seasons apply only to TV'));
          if (input.media_type === 'tv' && !input.all_seasons === !input.seasons) return present(unavailable('INPUT_INVALID', 'TV needs either seasons or all_seasons'));
          const args: Record<string, unknown> = { mediaType: input.media_type, mediaId: input.media_id };
          if (input.media_type === 'tv') args.seasons = input.all_seasons ? 'all' : input.seasons;
          return present(await run('request_create', args, context.abortSignal));
        } }) },
    ],
  };
}
