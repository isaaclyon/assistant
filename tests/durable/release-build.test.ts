import { execFileSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { assertSafeArchiveNames, buildRelease, defaultReleaseEntrypoints } from '../../src/durable/release-build.js';
import { main, parseBuildArgs } from '../../src/durable/release-build-cli.js';

const roots: string[] = [];
let base: string, repo: string, releases: string, allowlist: string;
const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' } }).trim();
const major = Number(process.versions.node.split('.')[0]);
const emitAll = `node -e "const fs=require('fs');fs.mkdirSync('dist/src/durable',{recursive:true});for(const f of ${JSON.stringify(defaultReleaseEntrypoints).replaceAll('"', "'")})fs.writeFileSync(f,'// built')"`;
async function commit(marker: string, build = emitAll): Promise<string> {
 await writeFile(join(repo, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', scripts: { build } }));
 await writeFile(join(repo, 'package-lock.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'fixture', version: '1.0.0' } } }));
 await writeFile(join(repo, 'marker.txt'), marker);
 git('add', '-A'); git('commit', '-qm', marker);
 return git('rev-parse', 'HEAD');
}
const allow = (...shas: string[]) => writeFile(allowlist, JSON.stringify({ version: 1, releases: shas }), { mode: 0o600 });
const opts = (sha: string, extra = {}) => ({ sha, allowlistPath: allowlist, sourceRepo: repo, releaseRoot: releases, nodeMajor: major, offline: true, ...extra });
const leftovers = async () => (await readdir(releases)).filter((n) => n.startsWith('.staging') || n === '.build.lock');
beforeEach(async () => {
 base = await realpath(await mkdtemp(join(tmpdir(), 'c6-build-'))); roots.push(base);
 repo = join(base, 'repo'); releases = join(base, 'releases'); allowlist = join(base, 'allowlist.json');
 await mkdir(repo); await mkdir(releases, { mode: 0o700 });
 git('init', '-q');
});
afterEach(async () => { for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true }); });

it('builds the exact reviewed commit, ignores later and dirty source state, and is idempotent', async () => {
 const first = await commit('one'), second = await commit('two');
 await writeFile(join(repo, 'dirty.txt'), 'uncommitted');
 await allow(first);
 const head = git('rev-parse', 'HEAD'), status = git('status', '--porcelain');
 const built = await buildRelease(opts(first));
 expect(built).toMatchObject({ sha: first, created: true, path: join(releases, first) });
 expect(await readFile(join(built.path, 'marker.txt'), 'utf8')).toBe('one');
 expect(existsSync(join(built.path, 'dirty.txt'))).toBe(false);
 expect((await lstat(built.path)).mode & 0o777).toBe(0o755);
 expect((await lstat(join(built.path, 'marker.txt'))).mode & 0o777).toBe(0o644);
 expect(await leftovers()).toEqual([]);
 expect(git('rev-parse', 'HEAD')).toBe(head); expect(git('status', '--porcelain')).toBe(status); expect(head).toBe(second);
 const again = await buildRelease(opts(first));
 expect(again).toMatchObject({ created: false, digest: built.digest });
});
it('rejects revisions outside the allowlist, abbreviated names and untrusted allowlists before any release exists', async () => {
 const sha = await commit('one'); await allow('b'.repeat(40));
 await expect(buildRelease(opts(sha))).rejects.toThrow(/allowlist/);
 await expect(buildRelease(opts(sha.slice(0, 12)))).rejects.toThrow(/40-character/);
 await allow(sha); await chmod(allowlist, 0o666);
 await expect(buildRelease(opts(sha))).rejects.toThrow(/trusted regular file/);
 const inRepo = join(repo, 'allowlist.json'); await writeFile(inRepo, JSON.stringify({ version: 1, releases: [sha] }), { mode: 0o600 });
 await expect(buildRelease(opts(sha, { allowlistPath: inRepo }))).rejects.toThrow(/outside the source repository/);
 await chmod(allowlist, 0o600); await writeFile(allowlist, JSON.stringify({ version: 1, releases: [sha], extra: 1 }), { mode: 0o600 });
 await expect(buildRelease(opts(sha))).rejects.toThrow(/Invalid release allowlist/);
 expect(await readdir(releases)).toEqual([]);
});
it('fails closed with no partial release for a missing commit or a failed build', async () => {
 const good = await commit('one'); const missing = 'c'.repeat(40);
 await allow(missing);
 await expect(buildRelease(opts(missing))).rejects.toThrow();
 const bad = await commit('two', 'node -e "process.exit(3)"');
 await allow(bad);
 await expect(buildRelease(opts(bad))).rejects.toThrow(/Command failed/);
 const noEntry = await commit('three', 'node -e "0"');
 await allow(noEntry, good);
 await expect(buildRelease(opts(noEntry))).rejects.toThrow(/did not produce/);
 const daemonOnly = await commit('four', `node -e "const fs=require('fs');fs.mkdirSync('dist/src/durable',{recursive:true});fs.writeFileSync('dist/src/durable/daemon.js','x')"`);
 await allow(noEntry, good, daemonOnly);
 await expect(buildRelease(opts(daemonOnly))).rejects.toThrow(/did not produce dist\/src\/durable\/inspect\.js/);
 expect(await readdir(releases)).toEqual([]);
 await buildRelease(opts(good));
 expect((await readdir(releases)).sort()).toEqual(['.digests', good]);
});
it('refuses wrong Node major, a held lock, release roots inside the repo and tampered existing releases', async () => {
 const sha = await commit('one'); await allow(sha);
 await expect(buildRelease(opts(sha, { nodeMajor: major + 1 }))).rejects.toThrow(/Node .* is required/);
 await writeFile(join(releases, '.build.lock'), '1');
 await expect(buildRelease(opts(sha))).rejects.toThrow(/lock/);
 await rm(join(releases, '.build.lock'));
 await mkdir(join(repo, 'rel'), { mode: 0o700 });
 await expect(buildRelease(opts(sha, { releaseRoot: join(repo, 'rel') }))).rejects.toThrow(/separate trees/);
 const built = await buildRelease(opts(sha));
 await chmod(built.path, 0o755); await chmod(join(built.path, 'marker.txt'), 0o644);
 await writeFile(join(built.path, 'marker.txt'), 'tampered');
 await expect(buildRelease(opts(sha))).rejects.toThrow(/differs from its recorded digest/);
 expect(await readFile(join(built.path, 'marker.txt'), 'utf8')).toBe('tampered');
});
it('enforces the archive size bound and command timeout', async () => {
 const sha = await commit('one'); await allow(sha);
 await expect(buildRelease(opts(sha, { limits: { archiveBytes: 10 } }))).rejects.toThrow(/size bound/);
 const slow = await commit('slow', 'node -e "setTimeout(()=>0,60000)"'); await allow(slow);
 await expect(buildRelease(opts(slow, { limits: { commandMs: 3000 } }))).rejects.toThrow(/timed out/);
 expect(await leftovers()).toEqual([]);
});
it('validates archive names and CLI arguments strictly', async () => {
 expect(() => assertSafeArchiveNames('a/b\n../x\n', 10)).toThrow(/unsafe/);
 expect(() => assertSafeArchiveNames('/etc/x\n', 10)).toThrow(/unsafe/);
 expect(() => assertSafeArchiveNames('a\nb\n', 1)).toThrow(/count/);
 const base = ['--sha', 'a'.repeat(40), '--allowlist', '/a', '--source', '/s', '--release-root', '/r'];
 expect(parseBuildArgs([...base, '--offline', '--entrypoint', 'dist/a.js', '--entrypoint', 'dist/b.js']).entrypoints).toEqual(['dist/a.js', 'dist/b.js']);
 expect(() => parseBuildArgs([...base, '--sha', 'b'])).toThrow(/Repeated/);
 expect(() => parseBuildArgs([...base, '--fetch'])).toThrow(/Unknown/);
 expect(() => parseBuildArgs(base.slice(2))).toThrow(/Missing --sha/);
 const lines: string[] = [];
 expect(await main(base.slice(0, 6), (l) => lines.push(l))).toBe(1);
 const sha = await commit('cli'); await allow(sha);
 expect(await main(['--sha', sha, '--allowlist', allowlist, '--source', repo, '--release-root', releases, '--node-major', String(major), '--offline'], (l) => lines.push(l))).toBe(0);
 expect(JSON.parse(lines[0]!)).toMatchObject({ sha, created: true });
});
