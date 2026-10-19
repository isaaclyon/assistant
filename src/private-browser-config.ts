/**
 * Narrow configuration the private browser wrappers need. Structurally
 * compatible with BridgeInstanceConfig, so legacy callers are unchanged, and
 * constructible by the native host without loading legacy manifests.
 */
export interface PrivateBrowserConfig {
  instanceId: string;
  telegramSurface: { type: string };
  telegramProfile: string;
  agentDir: string;
  resourceRoot: string;
  credentialScope: string;
  /** Used only by the legacy email-code gate when `emailCodeEnabled` is unset. */
  capabilityProfile?: string;
  /**
   * Host-verified identity of the running instance. When set, it replaces the
   * ambient PI_TELEGRAM_BRIDGE_INSTANCE_ID comparison. Only a trusted host
   * adapter may set it after validating its own instance.
   */
  executionInstanceId?: string;
  /** Explicit native decision on private email-code lookup; skips capability profile loading. */
  emailCodeEnabled?: boolean;
  /** Explicit native Google selection; no ambient credential resolution. */
  googleRuntime?: import("../.pi/lib/google-transport.js").GoogleRuntime;
}

/** True only for a private Telegram surface running as the configured instance. */
export function isTrustedPrivateExecution(config: PrivateBrowserConfig): boolean {
  if (config.telegramSurface.type !== "private") return false;
  const running = config.executionInstanceId ?? process.env.PI_TELEGRAM_BRIDGE_INSTANCE_ID;
  return running !== undefined && running === config.instanceId;
}
