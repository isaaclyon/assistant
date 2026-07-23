import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = join(root, "node_modules", "@llblab", "pi-telegram");
const indexPath = join(packageRoot, "index.ts");
const scopePath = join(packageRoot, "lib", "bridge-target-scope.ts");
const manifest = await readFile(join(packageRoot, "package.json"), "utf8");
if (!/^\s*"version":\s*"0\.20\.6",?\s*$/m.test(manifest)) {
  throw new Error("Refusing to patch @llblab/pi-telegram target scope; expected version 0.20.6.");
}

const moduleSource = `/** Bridge-only scoped proactive target used by durable background completion turns. */
export interface BridgeTarget { chatId: number; threadId?: number }
let overrideTarget: BridgeTarget | undefined;
const KEY = Symbol.for("pi-telegram-bridge.target-scope-registry");
export function getOverrideTarget(): BridgeTarget | undefined { return overrideTarget ? { ...overrideTarget } : undefined; }
export function bindTargetScope(getActiveTarget: () => BridgeTarget | undefined): void {
  const store = globalThis as Record<PropertyKey, unknown>;
  const provider = {
    getActiveTarget: () => { const value = getActiveTarget(); return value ? { ...value } : undefined; },
    async withTarget<T>(target: BridgeTarget, work: () => Promise<T>): Promise<T> {
      if (overrideTarget) throw new Error("A Telegram proactive target scope is already active");
      overrideTarget = { ...target };
      try { return await work(); } finally { overrideTarget = undefined; }
    },
  };
  store[KEY] = { version: 1, provider };
}
`;
await writeFile(scopePath, moduleSource);

let source = await readFile(indexPath, "utf8");
const importLine = 'import * as BridgeTarget from "./lib/bridge-target-scope.ts";';
if (!source.includes(importLine)) {
  const anchor = 'import * as Bindings from "./lib/bindings.ts";';
  if (!source.includes(anchor)) throw new Error(`Target-scope import patch no longer applies to ${indexPath}`);
  source = source.replace(anchor, `${anchor}\n${importLine}`);
}
const activeAnchor = "  const activeTurnRuntime = Queue.createTelegramActiveTurnStore();";
const activeReplacement = `${activeAnchor}\n  BridgeTarget.bindTargetScope(activeTurnRuntime.getTarget);`;
if (!source.includes(activeReplacement)) {
  if (!source.includes(activeAnchor)) throw new Error(`Target-scope binding patch no longer applies to ${indexPath}`);
  source = source.replace(activeAnchor, activeReplacement);
}
const getterOriginal = "      getActiveTurnTarget: activeTurnRuntime.getTarget,";
const getterReplacement = "      getActiveTurnTarget: () => BridgeTarget.getOverrideTarget() ?? activeTurnRuntime.getTarget(),";
if (!source.includes(getterReplacement)) {
  const index = source.indexOf(getterOriginal);
  if (index < 0) throw new Error(`Target-scope getter patch no longer applies to ${indexPath}`);
  source = source.slice(0, index) + getterReplacement + source.slice(index + getterOriginal.length);
}
await writeFile(indexPath, source);
