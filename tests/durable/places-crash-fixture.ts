import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry } from '@earendil-works/pi-durable';
import { DurableHost } from '../../src/durable/host.js';
import { createNativePlaces } from '../../src/durable/places.js';
import { parseCallbackData, type Presentation } from '../../src/durable/telegram-ui.js';
import type { NativeConfig } from '../../src/durable/config.js';

export const ownerKey = 'instance:test:principal:isaac';
export const origin = (id: string, messageId?: number) => ({ commandId: id, principal: 'isaac', actorId: 42, target: { chatId: 42 }, ...(messageId === undefined ? {} : { messageId }) });

/** Real DurableHost plus the native places module with a recording presenter. No provider calls. */
export async function placesCrashFixture(path: string, onPresent?: (messageId: number, presentation: Presentation) => void) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const config = { version: 1, runtime: 'pi-durable', instanceId: 'test', principal: 'isaac', releaseSha: 'a'.repeat(40), resourceRoot: resolve(process.cwd()), workspaceCwd: path, stateDir: path, capabilityProfile: 'durable-places-test', account: 'test', credentialPath: join(path, 'unused-auth'), settingsPath: join(path, 'unused-settings'), jobsRole: 'disabled', idleHours: 0, transport: { mode: 'broker', socketPath: join(path, 'unused.sock'), botId: 123, allowedUserId: 42 }, historyDir: join(path, 'durable'), inboxPath: join(path, 'inbox.db'), runtimeMetadataPath: join(path, 'runtime.json'), google: {} } as unknown as NativeConfig;
  const faux = fauxProvider({ tokensPerSecond: 1e9 }); faux.setResponses([fauxAssistantMessage('UNUSED')]);
  const models = createModels(); models.setProvider(faux.provider); const model = faux.getModel();
  let host!: DurableHost; let next = 100; const presented: Array<{ messageId: number; presentation: Presentation }> = [];
  const places = createNativePlaces({ config, host: () => host, present: async (_target: unknown, presentation: Presentation) => { const messageId = ++next; presented.push({ messageId, presentation }); onPresent?.(messageId, presentation); return { messageId }; } });
  host = await DurableHost.create({ stateDir: path, models, registry: createRegistry(), agent: { model: { provider: model.provider, modelId: model.id }, cwd: path }, compatibility: { runtimeGeneration: 'pi-durable-1.3.0', releaseSchema: 1, profile: 'fixture', registrySignature: 'fixture-v1' }, transport: { async start() {}, async stop() {}, async sendFinal() { return { messageId: 1 }; } }, policy() {}, controlPolicy() {}, settings: { retry: { enabled: false }, compaction: { enabled: false } } });
  await host.start();
  const latest = () => presented.at(-1)!;
  const buttons = (view = latest()) => (view.presentation.buttons ?? []).flat() as Array<{ text: string; callback?: string }>;
  /** Callback request for the button whose label matches, as the bridge would build it. */
  const press = (label: RegExp, view = latest()) => {
    const match = buttons(view).find(b => label.test(b.text) && b.callback); if (!match) throw new Error(`No button ${label}: ${JSON.stringify(view.presentation)}`);
    const action = parseCallbackData(match.callback); if (action?.type !== 'places') throw new Error('Not a places callback');
    return { key: action.key, messageId: view.messageId };
  };
  return { host, places, presented, latest, buttons, press, close: async () => { try { await host.close(); } finally { await places.close(); } } };
}
