import type { NativeConfig } from './config.js';

/** Domain services receive only host-selected identity and paths. Ambient instance
 * flags and vault paths cannot silently change a dedicated test configuration. */
export function nativeMemoryEnvironment(config: NativeConfig): NodeJS.ProcessEnv {
  const memory = config.memory;
  if (!memory) throw new Error('Memory configuration is unavailable');
  return {
    PI_TELEGRAM_PRINCIPAL: config.principal,
    PI_TELEGRAM_MEMORY_VIEW: config.principal === 'household' ? 'household' : config.principal === 'engineering' ? 'none' : 'owner-and-household',
    PI_TELEGRAM_MEMORY_DIR: memory.vaultRoot,
    PI_TELEGRAM_MEMORY_GIT_AUTOCOMMIT: memory.gitAutocommit ? '1' : '0',
    PI_TELEGRAM_BRIDGE_STATE_DIR: config.stateDir,
    PI_TELEGRAM_BRIDGE_RESOURCE_ROOT: config.resourceRoot,
    PI_TELEGRAM_BRIDGE_INSTANCE_ID: config.instanceId,
    PI_TELEGRAM_BRIDGE_SESSION_ROOTS: JSON.stringify(memory.legacySessionRoots),
    PI_TELEGRAM_MEMORY_RECALL: memory.recall,
    PI_TELEGRAM_MEMORY_SEMANTIC: memory.semantic,
    PI_TELEGRAM_SESSION_ROUTING: config.routing ? 'jev' : 'off',
    ...(memory.judgeKeyFile ? { PI_TELEGRAM_TYPESAFE_API_KEY_FILE: memory.judgeKeyFile } : {}),
    ...(memory.embeddingKeyFile ? { PI_TELEGRAM_OPENAI_API_KEY_FILE: memory.embeddingKeyFile } : {}),
  };
}
