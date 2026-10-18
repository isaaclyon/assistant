import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { ToolExecutionApi } from '@earendil-works/pi-durable';
import { createNativeChildTools, CHILD_OUTPUT_MAX_BYTES } from '../../src/durable/child-tools.js';

let base: string, root: string, outside: string;
const PNG = Buffer.from('iVBORw0KGgo=', 'base64');
type Out = { output: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean };
let web = async (_url: string): Promise<{ url: string; contentType: string; body: Buffer }> => { throw new Error('no web'); };
const bundle = () => createNativeChildTools([root], { fetchWeb: url => web(url) });
const run = (name: string, args: unknown) => bundle().tools.find(t => t.tool.name === name)!.tool.execute(args as never, {} as ToolExecutionApi, BACKGROUND_CONTEXT) as Promise<Out>;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'child-tools-'));
  root = join(base, 'root'); outside = join(base, 'outside');
  await mkdir(join(root, 'sub'), { recursive: true }); await mkdir(outside);
  await writeFile(join(root, 'a.txt'), 'hello\nNeedle here\n');
  await writeFile(join(root, 'sub', 'b.txt'), 'another needle\n');
  await writeFile(join(root, 'pic.png'), PNG);
  await writeFile(join(root, 'pic.svg'), '<svg/>');
  await writeFile(join(root, 'big.txt'), 'x'.repeat(2 * 1024 * 1024 + 1));
  await writeFile(join(root, 'long.txt'), 'y'.repeat(CHILD_OUTPUT_MAX_BYTES * 2));
  await writeFile(join(outside, 'secret.txt'), 'SECRET');
  await symlink(join(outside, 'secret.txt'), join(root, 'link.txt'));
  await symlink(outside, join(root, 'linkdir'));
});
afterAll(() => rm(base, { recursive: true, force: true }));

it('declares exactly the seven replay-safe read-only tools', () => {
  const b = bundle();
  expect([b.name, b.version]).toEqual(['child-tools', 1]);
  expect(b.tools.map(t => [t.tool.name, t.tool.replay])).toEqual(['repo_read', 'repo_list', 'repo_search', 'repo_image', 'web_fetch', 'web_search', 'system_info'].map(n => [n, 'safe']));
});

it('reads, lists, searches and views images inside the root', async () => {
  expect((await run('repo_read', { path: 'a.txt' })).output[0]!.text).toContain('Needle');
  expect((await run('repo_list', {})).output[0]!.text).toContain('f a.txt');
  expect((await run('repo_list', { path: 'sub' })).output[0]!.text).toBe('f b.txt');
  const found = (await run('repo_search', { query: 'needle' })).output[0]!.text!;
  expect(found).toContain('a.txt:2'); expect(found).toContain('b.txt:1');
  const img = (await run('repo_image', { path: 'pic.png' })).output[0]!;
  expect([img.type, img.mimeType, img.data]).toEqual(['image', 'image/png', PNG.toString('base64')]);
});

it('refuses escapes, symlinks, outside paths, special files, oversize files and bad image types', async () => {
  for (const [name, path] of [['repo_read', 'link.txt'], ['repo_read', join(outside, 'secret.txt')], ['repo_read', '../outside/secret.txt'], ['repo_read', 'linkdir/secret.txt'],
    ['repo_read', 'sub'], ['repo_read', 'big.txt'], ['repo_list', 'linkdir'], ['repo_list', outside], ['repo_image', 'link.txt'], ['repo_image', 'pic.svg'], ['repo_image', 'a.txt']] as const) {
    const r = await run(name, { path });
    expect(r.isError, `${name} ${path}`).toBe(true);
    expect(JSON.stringify(r)).not.toContain('SECRET');
  }
  expect((await run('repo_search', { query: 'SECRET' })).output[0]!.text).toBe('No matches.');
});

it('bounds text output to 50 KiB', async () => {
  const r = await run('repo_read', { path: 'long.txt' });
  expect(Buffer.byteLength(r.output[0]!.text!)).toBeLessThanOrEqual(CHILD_OUTPUT_MAX_BYTES);
  expect(r.output[0]!.text).toContain('truncated');
});

it('constrains arguments', () => {
  const schema = (n: string) => JSON.stringify(bundle().tools.find(t => t.tool.name === n)!.tool.parameters);
  expect(schema('repo_search')).toContain('"maxLength":512');
  expect(schema('web_fetch')).toContain('"maxLength":2048');
  expect(schema('system_info')).not.toContain('"properties":{"');
});

it('labels web content as untrusted and allows only image MIME types', async () => {
  web = async () => ({ url: 'https://e.test/', contentType: 'text/html', body: Buffer.from('<p>hi</p>') });
  expect((await run('web_fetch', { url: 'https://e.test/' })).output[0]!.text).toContain('Untrusted web data');
  web = async () => ({ url: 'https://e.test/x', contentType: 'image/png', body: PNG });
  expect((await run('web_fetch', { url: 'https://e.test/x' })).output[0]!.mimeType).toBe('image/png');
  web = async () => ({ url: 'https://e.test/x', contentType: 'image/svg+xml', body: Buffer.from('<svg/>') });
  expect((await run('web_fetch', { url: 'https://e.test/x' })).isError).toBe(true);
  web = async url => { expect(url).toContain('q=a%20b'); return { url, contentType: 'text/html', body: Buffer.from('<a class="result__a" href="https://x.test/">T</a> <a class="result__snippet" href="#">S</a>') }; };
  expect((await run('web_search', { query: 'a b' })).output[0]!.text).toContain('https://x.test/');
  web = async () => { throw new Error('Local or private web targets are not allowed'); };
  expect((await run('web_fetch', { url: 'http://127.0.0.1/' })).isError).toBe(true);
});

it('system_info omits environment secrets', async () => {
  process.env.CHILD_TOOLS_TEST_SECRET = 'top-secret-value';
  const text = (await run('system_info', {})).output[0]!.text!;
  delete process.env.CHILD_TOOLS_TEST_SECRET;
  expect(Object.keys(JSON.parse(text)).sort()).toEqual(['arch', 'cwd', 'node', 'platform']);
  expect(text).not.toContain('top-secret-value');
});
