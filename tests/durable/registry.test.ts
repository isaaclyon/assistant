import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Type } from '@earendil-works/pi-ai';
import { defineTool, type ToolExecutionApi } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { loadNativeRegistry, textToolResult } from '../../src/durable/registry.js';
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'native-registry-')); dirs.push(root);
  await mkdir(join(root, '.pi'));
  await Promise.all(['selected.mjs', 'hidden.mjs', 'SKILL.md', 'instructions.md'].map(p => writeFile(join(root, p), p)));
  await writeFile(join(root, '.pi/capabilities.json'), JSON.stringify({ version: 1, resources: {
    extensions: [{ id: 'selected', path: 'selected.mjs', enabled: true }, { id: 'hidden', path: 'hidden.mjs', enabled: true }],
    skills: [{ id: 'test', path: 'SKILL.md', enabled: true }], instructions: [{ id: 'test', path: 'instructions.md', enabled: true }],
  }, profiles: [{ id: 'test', extensions: ['selected'], skills: ['test'], instructions: 'test' }] }));
  return root;
}
it('selects before import, checks current authority and handler signature on every execution, and closes', async () => {
  const root = await fixture(); let allowed = true; let calls = 0; let closes = 0; let signature: string | undefined;
  const imported: string[] = [];
  const registry = await loadNativeRegistry({ resourceRoot: root, profileId: 'test', authorize: async () => { if (!allowed) throw new Error('revoked'); }, importer: async path => {
    imported.push(path); return { default: () => ({ name: 'selected', tools: [{ version: 1, tool: defineTool({ name: 'echo', description: 'Echo', parameters: Type.Object({ text: Type.String() }), replay: 'safe', execute: async args => { calls++; return textToolResult(args.text); } }) }], close: async () => { closes++; } }) };
  } });
  const api = { memo: async (_key: string, candidate: string) => signature ??= candidate } as unknown as ToolExecutionApi;
  const tool = registry.registry.snapshot().tools()[0]!.tool;
  expect(imported).toEqual([await realpath(join(root, 'selected.mjs'))]);
  expect(registry.skills[0]?.content).toBe('SKILL.md');
  expect(registry.signature).toMatch(/^[a-f0-9]{64}$/);
  expect(await tool.execute({ text: 'hello' }, api, BACKGROUND_CONTEXT)).toEqual(textToolResult('hello'));
  allowed = false; await expect(tool.execute({ text: 'denied' }, api, BACKGROUND_CONTEXT)).rejects.toThrow('revoked');
  allowed = true; signature = 'old-handler'; await expect(tool.execute({}, api, BACKGROUND_CONTEXT)).rejects.toThrow('reconciliation');
  expect(calls).toBe(1);
  await registry.close(); await registry.close(); expect(closes).toBe(1);
  await expect(tool.execute({}, api, BACKGROUND_CONTEXT)).rejects.toThrow('closed');
});
it('rejects canonical escapes before importing any bundle', async () => {
  const root = await fixture(); let imports = 0;
  await rm(join(root, 'SKILL.md')); await symlink('/etc/hosts', join(root, 'SKILL.md'));
  await expect(loadNativeRegistry({ resourceRoot: root, profileId: 'test', authorize: async () => {}, importer: async () => { imports++; throw new Error('must not execute'); } })).rejects.toThrow('outside');
  expect(imports).toBe(0);
});
it('registers versioned native sections and cleans up when a later registration fails', async () => {
  const root = await fixture(); let closes = 0;
  const { section } = await import('@earendil-works/pi-durable');
  const load = (version: number) => loadNativeRegistry({ resourceRoot: root, profileId: 'test', authorize: async () => {}, importer: async () => ({ default: () => ({ name: 'selected', version, tools: [], contributions: { sections: [section('fixture', () => 'selected context')] }, close: async () => { closes++; } }) }) });
  const first = await load(1);
  expect(first.registry.snapshot().sections()).toHaveLength(1);
  const second = await load(2);
  expect(first.signature).not.toBe(second.signature);
  await first.close(); await second.close();
  await expect(load(0)).rejects.toThrow('version');
  expect(closes).toBe(3);
});

it('rejects duplicate task definitions within one bundle and closes its resources', async () => {
  const root=await fixture(); let closed=0;
  const {defineTask}=await import('@earendil-works/pi-durable');
  const task=defineTask({name:'fixture.task',version:1,initial:()=>({phase:'run' as const}),phases:{run:async()=>{}},abort:async()=>{}});
  await expect(loadNativeRegistry({resourceRoot:root,profileId:'test',authorize:async()=>{},importer:async()=>({default:()=>({name:'selected',version:1,tools:[],contributions:{tasks:[task,task]},close:async()=>{closed++;}})})})).rejects.toThrow('Duplicate');
  expect(closed).toBe(1);
});
