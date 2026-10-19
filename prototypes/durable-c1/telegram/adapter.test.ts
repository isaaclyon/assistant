import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { Harness, createRegistry } from '@earendil-works/pi-durable';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { openNodeJsonlStorage } from '@earendil-works/pi-durable/storage/jsonl/node';
import { nativeTelegramRuntime } from './native.mjs';
import { verifiedTelegramCandidate } from './candidate.mjs';
const { createDurableTelegramPrototype } = await import(/* @vite-ignore */ verifiedTelegramCandidate());
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })));
const target = { chatId: 12345, threadId: 9 };
const input = { target, actorId: 42, messageId: 100, text: 'Synthetic question', attachments: [{ fileId: 'synthetic-file', uniqueId: 'synthetic-unique', name: 'fixture.txt' }] };
function fixture(runtime: any, callOverride?: any) {
 const dir = mkdtempSync(join(tmpdir(), 'c1-telegram-')); dirs.push(dir);
 const calls: any[] = [];
 const transport = { call: callOverride ?? (async (method: string, body: any) => { calls.push({ method, body }); return { message_id: calls.length }; }) };
 const ownership = { locksPath: join(dir, 'locks.json'), cwd: dir, pid: 7001, isProcessAlive: (pid: number) => pid === 7001 || pid === 7002 };
 const config = { target, actorId: 42, transport, runtime, ownership };
 return { config, calls, adapter: createDurableTelegramPrototype(config) };
}
test('native Harness input reaches real fork previews/final; reconnect and reopened storage preserve conversation', async () => {
 const faux = fauxProvider({ tokensPerSecond: 100, tokenSize: { min: 5, max: 5 } });
 faux.setResponses([fauxAssistantMessage('A synthetic answer with enough words for a preview.'), fauxAssistantMessage('Second synthetic answer.')]);
 const models = createModels(); models.setProvider(faux.provider);
 const storageDir = mkdtempSync(join(tmpdir(), 'c1-native-')); dirs.push(storageDir);
 let harness = await Harness.open(await openNodeJsonlStorage(storageDir, context), { models, registry: createRegistry() }, context);
 let root = await harness.root(context, { agent: { model: { provider: faux.provider.id, modelId: faux.getModel().id } } });
 const original = root.id;
 const f = fixture(nativeTelegramRuntime(harness, root));
 try {
 expect(f.adapter.connect().ok).toBe(true);
 expect(await f.adapter.receive({ ...input, actorId: 99 })).toEqual({ accepted: false });
 expect(await f.adapter.receive({ ...input, target: { ...target, threadId: 8 } })).toEqual({ accepted: false });
 expect(await f.adapter.receive(input)).toEqual({ accepted: true });
 expect(f.calls.some(c => c.method === 'sendRichMessageDraft')).toBe(true);
 const final = f.calls.at(-1); expect(final.method).toBe('sendRichMessage');
 expect(final.body.reply_parameters.message_id).toBe(100);
 expect(final.body.rich_message.markdown).toBe('A synthetic answer with enough words for a preview.');
 for (const call of f.calls) { expect(call.body.chat_id).toBe(target.chatId); expect(call.body.message_thread_id).toBe(target.threadId); }
 f.adapter.disconnect(); await harness.close(context);
 harness = await Harness.open(await openNodeJsonlStorage(storageDir, context), { models, registry: createRegistry() }, context);
 root = await harness.root(context); expect(root.id).toBe(original);
 const restored = (await root.context(context)).entries.find(entry => entry.kind === 'prototype.telegram-input');
 expect(restored?.data).toEqual({ target, actorId: 42, messageId: 100, attachments: input.attachments });
 const resumed = createDurableTelegramPrototype({ ...f.config, runtime: nativeTelegramRuntime(harness, root) });
 expect(resumed.connect().ok).toBe(true);
 await expect(resumed.receive({ ...input, text: 'Changed identity payload' })).rejects.toThrow('Telegram source payload conflict');
 await expect(resumed.receive({ ...input, attachments: [{ ...input.attachments[0], fileId: 'changed' }] })).rejects.toThrow('Telegram source payload conflict');
 expect(faux.state.callCount).toBe(1);
 await resumed.receive(input);
 expect(faux.state.callCount).toBe(1);
 await resumed.receive({ ...input, messageId: 101 });
 expect(faux.state.callCount).toBe(2);
 resumed.disconnect();
 } finally { await harness.close(context); }
});
test('direct section callbacks run fork registry without model; foreign callback rejected', async () => {
 let runs = 0, actions = 0;
 const f = fixture({ run: async () => { runs++; return 'unused'; } });
 f.adapter.connect();
 f.adapter.sections.register({ id: '@test/control', label: 'Control', render: (ctx: any) => ({ text: 'Choose', replyMarkup: { inline_keyboard: [[{ text: 'Act', callback_data: ctx.callbackData('act') }]] } }), handleCallback: async (ctx: any) => { actions++; await ctx.answerCallback('Done'); return 'handled'; } });
 await f.adapter.open('@test/control');
 const data = f.calls[0].body.reply_markup.inline_keyboard[0][0].callback_data;
 expect(await f.adapter.callback({ ...input, data, callbackId: 'synthetic', actorId: 99 })).toBe(false);
 expect(await f.adapter.callback({ ...input, data, callbackId: 'synthetic' })).toBe(true);
 expect(actions).toBe(1); expect(runs).toBe(0);
 expect(f.calls.at(-1).method).toBe('answerCallbackQuery'); f.adapter.disconnect();
});
test('real fork locks reject a live external process then acquire after that same owner exits', async () => {
 const f = fixture({ run: async () => 'ok' });
 const owner = spawn(process.execPath, ['-e', "process.stdout.write('ready\\n'); process.stdin.resume(); process.stdin.on('end', () => process.exit(0));"], { stdio: ['pipe', 'pipe', 'pipe'] });
 try {
 await once(owner.stdout, 'data');
 const isProcessAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
 const adapter = createDurableTelegramPrototype({ ...f.config, ownership: { ...f.config.ownership, pid: process.pid, isProcessAlive } });
 writeFileSync(f.config.ownership.locksPath, JSON.stringify({ '@llblab/pi-telegram': { pid: owner.pid, cwd: '/synthetic/external' } }));
 expect(isProcessAlive(owner.pid!)).toBe(true);
 expect(adapter.connect().ok).toBe(false); expect(await adapter.receive(input)).toEqual({ accepted: false });
 const exited = once(owner, 'exit'); owner.stdin.end(); await exited;
 expect(isProcessAlive(owner.pid!)).toBe(false);
 // Leave the exact same owner record on disk: only process liveness changed.
 expect(adapter.connect()).toMatchObject({ ok: true, replacedStale: true });
 adapter.disconnect(); expect(adapter.connect().ok).toBe(true); adapter.disconnect();
 } finally { if (owner.exitCode === null) owner.kill(); }
});
test('restricted broker failure fails final without alternate transport; attachment identity copied', async () => {
 let received: any; const attempted: string[] = [];
 const f = fixture({ run: async (value: any) => { received = value; return 'result'; } }, async (method: string) => { attempted.push(method); throw new Error('broker unavailable'); });
 f.adapter.connect(); const attachment = { fileId: 'synthetic-file', uniqueId: 'synthetic-unique', name: 'fixture.txt' };
 await expect(f.adapter.receive({ ...input, attachments: [attachment] })).rejects.toThrow('broker unavailable');
 expect(received.attachments).toEqual([attachment]); expect(received.attachments[0]).not.toBe(attachment);
 expect(attempted).toEqual(['sendRichMessage']); f.adapter.disconnect();
});
