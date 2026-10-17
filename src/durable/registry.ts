import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createRegistry, defineExtension, type ToolRegistration, type ToolExecutionApi, type ToolExecutionResult, type Extension } from '@earendil-works/pi-durable';
import type { Context } from '@earendil-works/chord/context';
import type { JsonValue } from '@earendil-works/chord';
import { loadCapabilityProfile } from '../capabilities.js';

export interface NativeTool { readonly version: number; readonly tool: ToolRegistration }
/** Native-only registration contract. Factories own their resources and return an idempotent close. */
export interface NativeBundle {
  name: string;
  /** Bump for any hook, section, or custom task behavior/schema change. Required with contributions. */
  version?: number;
  tools: readonly NativeTool[];
  contributions?: Pick<Extension, 'hooks' | 'sections' | 'tasks'>;
  close(): Promise<void>;
}
export interface NativeBundleModule { default(context?: unknown): Promise<NativeBundle> | NativeBundle }
export interface NativeRegistryOptions {
  resourceRoot: string;
  profileId: string;
  /** Must resolve the current principal/target/epoch from host state for this invocation, including recovery. */
  authorize(toolName: string, api: ToolExecutionApi, context: Context): Promise<void>;
  importer?: (canonicalPath: string) => Promise<NativeBundleModule>;
  /** Explicit host services. Factories cannot acquire ambient runtime identity. */
  bundleContext?: unknown;
}
/** Explicit domain-result conversion. Native structured output requires a declared schema. */
export function textToolResult(value: JsonValue, isError = false): ToolExecutionResult {
  return { output: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }], isError };
}
function fingerprint(tool: NativeTool): string {
  if (!Number.isSafeInteger(tool.version) || tool.version < 1) throw new Error('Native tool requires a positive handler version');
  return createHash('sha256').update(JSON.stringify({ version: tool.version, parameters: tool.tool.parameters, replay: tool.tool.replay ?? 'unsafe' })).digest('hex');
}
export async function loadNativeRegistry(options: NativeRegistryOptions) {
  // Resolve every selected canonical path before any module can execute.
  const selection = await loadCapabilityProfile(options.resourceRoot, options.profileId);
  const instructions = await readFile(selection.instructionsPath, 'utf8');
  const skills = await Promise.all(selection.skillPaths.map(async path => ({ path, content: await readFile(path, 'utf8') })));
  const registry = createRegistry();
  const bundles: NativeBundle[] = [];
  const extensionNames: string[] = [];
  const toolNames: string[] = [];
  const toolSignatures: string[] = [];
  const bundleVersions: number[] = [];
  let closed = false;
  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    for (const extension of registry.snapshot().installed()) registry.uninstall(extension);
    const failures: unknown[] = [];
    for (const bundle of [...bundles].reverse()) { try { await bundle.close(); } catch (error) { failures.push(error); } }
    if (failures.length) throw new AggregateError(failures, 'Native bundle cleanup failed');
  }
  try {
    for (const path of selection.extensionPaths) {
      const module = await (options.importer ? options.importer(path) : import(pathToFileURL(path).href) as Promise<NativeBundleModule>);
      if (typeof module.default !== 'function') throw new Error('Selected resource is not a native bundle');
      const bundle = await module.default(options.bundleContext);
      bundles.push(bundle);
      if (!bundle.name || extensionNames.includes(bundle.name) || typeof bundle.close !== 'function') throw new Error('Invalid or duplicate native bundle');
      if (bundle.contributions && (!Number.isSafeInteger(bundle.version) || (bundle.version ?? 0) < 1)) throw new Error('Native contributions require a bundle version');
      if (bundle.contributions && Object.keys(bundle.contributions).some(k => !['hooks', 'sections', 'tasks'].includes(k))) throw new Error('Unsupported native contribution');
      const taskNames = new Set<string>();
      for (const task of bundle.contributions?.tasks ?? []) {
        if (taskNames.has(task.definition.name) || registry.snapshot().task(task.definition.name)) throw new Error('Duplicate or reserved native task');
        taskNames.add(task.definition.name);
      }
      bundleVersions.push(bundle.version ?? 1);
      const tools = bundle.tools.map(descriptor => {
        const tool = descriptor.tool;
        if (toolNames.includes(tool.name)) throw new Error('Duplicate native tool');
        const signature = fingerprint(descriptor);
        toolSignatures.push(signature);
        toolNames.push(tool.name);
        return { ...tool, execute: async (args: unknown, api: ToolExecutionApi, context: Context) => {
          if (closed) throw new Error('Native registry closed');
          await options.authorize(tool.name, api, context);
          const recorded = await api.memo<string>('native.handler-signature', signature, context);
          if (recorded !== signature) throw new Error('Native tool schema/handler changed; recovery requires reconciliation');
          return tool.execute(args, api, context);
        } } satisfies ToolRegistration;
      });
      registry.install(defineExtension({ ...bundle.contributions, name: bundle.name, tools }));
      extensionNames.push(bundle.name);
    }
    const signature = createHash('sha256').update(JSON.stringify({ profileId: options.profileId, extensionNames, bundleVersions, toolNames, toolSignatures, instructions, skills: skills.map(s => s.content) })).digest('hex');
    return { registry, instructions, skills, extensionNames, toolNames, signature, close };
  } catch (error) {
    try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Native registry construction failed'); }
    throw error;
  }
}
