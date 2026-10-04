import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  resolveMemoryDirectory,
  resolveMemoryView,
} from "../skills/personal-memory/scripts/config.mjs";
import { compileCoreMemory } from "../skills/personal-memory/scripts/inspect.mjs";
import { isBridgeRuntime } from "../lib/bridge-runtime.ts";
import { publishDebug } from "../../src/debug-messages.ts";

export default function coreMemoryExtension(pi: ExtensionAPI): void {
  pi.on("before_agent_start", async (event) => {
    if (!isBridgeRuntime()) return;
    const core = await compileCoreMemory({
      root: resolveMemoryDirectory(),
      ...resolveMemoryView(),
    });
    publishDebug("Automatic core memory", core.text || "No core memory to inject.");
    if (!core.text) return;
    return { systemPrompt: event.systemPrompt + core.text };
  });
}
