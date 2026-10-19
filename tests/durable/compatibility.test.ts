import { readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';
const read=async(path:string)=>JSON.parse(await readFile(new URL(`../../${path}`,import.meta.url),'utf8'));
test('native exact dependency tree contains one SDK generation and a pinned public Telegram adapter',async()=>{
 const manifest=await read('package.json'),lock=await read('package-lock.json');
 for(const name of ['pi-durable','pi-ai','chord','pi-codemode']){
  const full=`@earendil-works/${name}`;expect(manifest.dependencies[full]).toBe('1.3.0');
  const entries=Object.entries(lock.packages).filter(([path])=>path.endsWith(`node_modules/${full}`));expect(entries).toHaveLength(1);expect((entries[0]![1] as any).version).toBe('1.3.0');
 }
 expect(Object.keys(lock.packages).some(path=>/node_modules\/@earendil-works\/pi-(coding-agent|agent-core|tui)$/.test(path))).toBe(false);
 expect(manifest.dependencies['@llblab/pi-telegram']).toMatch(/^https:\/\/codeload\.github\.com\/isaaclyon\/pi-telegram\/tar\.gz\/[0-9a-f]{40}$/);
 expect(lock.packages['node_modules/@llblab/pi-telegram'].integrity).toMatch(/^sha512-/);
 expect(manifest.scripts.start).toBe('node dist/src/durable/daemon.js');expect(manifest.scripts.postinstall).toBeUndefined();
 const adapter=await import('@llblab/pi-telegram/durable');expect(typeof adapter.createTelegramLockRuntime).toBe('function');expect(typeof adapter.sendTelegramNativeMarkdownReply).toBe('function');
});
