import { expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Server } from 'node:http';
// Runtime imports keep the native prototype's typecheck bounded; these are the
// actual retained host sources, exercised by Vite's TypeScript loader.
const source = (name: string) => resolve('src', `${name}.ts`);
const { serveTrustedTelegram, trustedTelegramFetch } = await import(source('trusted-telegram-ipc'));
const { TrustedTelegramTransport } = await import(source('trusted-telegram-transport'));
const { TrustedTelegramStore } = await import(source('trusted-telegram-store'));
const close = (server: Server) => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });

test('real trusted IPC client reconnects to reopened broker and acknowledges replay by offset', async () => {
 const dir = mkdtempSync('/tmp/c1-broker-');
 const socket = join(dir, 'broker.sock'), database = join(dir, 'broker.sqlite');
 const update = { update_id: 7, message: { message_id: 100, chat: { id: 42, type: 'private' }, from: { id: 42 }, text: 'Synthetic broker replay' } };
 const upstreamCalls: string[] = [];
 const upstream: typeof fetch = async (url) => {
   const method = new URL(String(url)).pathname.split('/').at(-1)!; upstreamCalls.push(method);
   return Response.json({ ok: true, result: method === 'getUpdates' ? [update] : method === 'getMe' ? { id: 123, is_bot: true } : true });
 };
 let store = new TrustedTelegramStore(database, 42);
 let server: Server | undefined;
 const client = trustedTelegramFetch(socket);
 const call = async (method: string, body = {}) => {
   const response = await client(`https://api.telegram.org/bot0:surrogate/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
   return { status: response.status, payload: await response.json() };
 };
 try {
   let transport = new TrustedTelegramTransport('123:synthetic', store, upstream);
   await transport.pollOnce();
   server = await serveTrustedTelegram(socket, transport);
   expect((await call('getMe')).payload.result.id).toBe(123);
   expect((await call('getUpdates')).payload.result).toEqual([update]);
   await close(server!); server = undefined; store.close();
   await expect(call('getMe')).rejects.toThrow('Trusted Telegram transport unavailable');
   store = new TrustedTelegramStore(database, 42);
   transport = new TrustedTelegramTransport('123:synthetic', store, upstream);
   server = await serveTrustedTelegram(socket, transport);
   // Same real client reopens the HTTP socket; getMe repeats identity bootstrap.
   expect((await call('getMe')).payload.result.id).toBe(123);
   expect((await call('getUpdates')).payload.result).toEqual([update]);
   expect((await call('getUpdates', { offset: 8 })).payload.result).toEqual([]);
   expect((await call('getUpdates')).payload.result).toEqual([]);
   expect((await call('setWebhook', { url: 'https://example.test' })).status).toBe(403);
   expect(upstreamCalls).toEqual(['getUpdates', 'getMe', 'getMe']);
 } finally { if (server) await close(server); store.close(); rmSync(dir, { recursive: true, force: true }); }
});
