import type { ConversationId, Tx } from '@earendil-works/pi-durable';
import { isNativeMemoryProfile, type NativeConfig } from './config.js';
import type { DurableHost } from './host.js';
import { Bindings } from './ingress.js';
import type { MemoryBinding } from './operations.js';

/** Resolve identity from the host's durable source map, never from model input. */
export async function nativeMemoryBinding(
  tx: Tx, host: DurableHost, config: NativeConfig, conversationId: ConversationId,
): Promise<MemoryBinding | undefined> {
  if (!isNativeMemoryProfile(config.capabilityProfile) || !config.memory || config.principal === 'engineering') return undefined;
  const state = await tx.doc(Bindings, host.runtime.root.id);
  if (state.epochs[String(state.epoch)] !== conversationId) return undefined;
  const sources = Object.values(state.sources).filter(source => source.conversationId === conversationId && !source.cancelled);
  if (!sources.length || sources.some(source => source.principal !== config.principal || source.chatId !== config.transport.allowedUserId || source.threadId !== null)) return undefined;
  return { principal: config.principal, epoch: String(state.epoch), target: { chatId: String(config.transport.allowedUserId), threadId: null } };
}
