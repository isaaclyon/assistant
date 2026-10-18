import type { ConversationId, Tx } from '@earendil-works/pi-durable';
import { isDomainProfile, isNativeMemoryProfile } from './profiles.js';
import type { NativeConfig } from './config.js';
import type { DurableHost } from './host.js';
import { Bindings, type Binding } from './ingress.js';
import type { MemoryBinding } from './operations.js';
import { actorOf, chatIdOf } from './surface.js';

/** One human source belongs to this instance's exact chat and (for a group) one of its two named actors. */
export function sourceInAuthority(config: NativeConfig, source: Binding): boolean {
  if (source.principal !== config.principal || source.chatId !== chatIdOf(config) || source.threadId !== null) return false;
  if (source.envelope.proactive === true) return source.envelope.actor === undefined;
  const actor = source.envelope.actor;
  if (!config.group) return actor === undefined;
  return !!actor && config.group.actors.some(item => item.id === actor.id && item.label === actor.label);
}
export { actorOf };

/** Resolve the current conversation's native authority from the host's durable
 * source map, never from model input. Applies to every domain profile. */
export async function nativeBinding(
  tx: Tx, host: DurableHost, config: NativeConfig, conversationId: ConversationId,
): Promise<MemoryBinding | undefined> {
  if (!isDomainProfile(config.capabilityProfile)) return undefined;
  const state = await tx.doc(Bindings, host.runtime.root.id);
  if (state.epochs[String(state.epoch)] !== conversationId) return undefined;
  const sources = Object.values(state.sources).filter(source => source.conversationId === conversationId && !source.cancelled);
  if (!sources.length || !sources.every(source => sourceInAuthority(config, source))) return undefined;
  return { principal: config.principal, epoch: String(state.epoch), target: { chatId: String(chatIdOf(config)), threadId: null } };
}
/** Canonical memory authority: the generic binding plus a canonical-memory profile. */
export async function nativeMemoryBinding(
  tx: Tx, host: DurableHost, config: NativeConfig, conversationId: ConversationId,
): Promise<MemoryBinding | undefined> {
  if (!isNativeMemoryProfile(config.capabilityProfile) || !config.memory) return undefined;
  return nativeBinding(tx, host, config, conversationId);
}
