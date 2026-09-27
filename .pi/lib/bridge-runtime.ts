const RUNTIME_REGISTRY = Symbol.for("pi-telegram-bridge.runtime-registry");

/**
 * True only inside the always-on bridge, which binds a process-local marker
 * (ADR-0015). Ordinary Pi sessions in this repository load the same
 * extensions but must not receive bridge-only memory behavior.
 */
export function isBridgeRuntime(): boolean {
  const registry = (globalThis as Record<PropertyKey, unknown>)[RUNTIME_REGISTRY];
  return Boolean(
    registry &&
      typeof registry === "object" &&
      !Array.isArray(registry) &&
      (registry as Record<string, unknown>).version === 1 &&
      (registry as Record<string, unknown>).runtime,
  );
}
