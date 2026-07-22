import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  resolveMemoryDirectory,
  resolveMemoryView,
} from "../skills/personal-memory/scripts/config.mjs";
import { compileCoreMemory } from "../skills/personal-memory/scripts/inspect.mjs";

const RUNTIME_REGISTRY = Symbol.for("pi-telegram-bridge.runtime-registry");

function isBridgeRuntime(): boolean {
  const registry = (globalThis as Record<PropertyKey, unknown>)[RUNTIME_REGISTRY];
  return Boolean(
    registry &&
      typeof registry === "object" &&
      !Array.isArray(registry) &&
      (registry as Record<string, unknown>).version === 1 &&
      (registry as Record<string, unknown>).runtime,
  );
}

export default function coreMemoryExtension(pi: ExtensionAPI): void {
  pi.on("before_agent_start", async (event) => {
    if (!isBridgeRuntime()) return;
    const core = await compileCoreMemory({
      root: resolveMemoryDirectory(),
      ...resolveMemoryView(),
    });
    if (!core.text) return;
    return { systemPrompt: event.systemPrompt + core.text };
  });
}
