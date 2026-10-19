import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, open, readdir, readFile, readlink, realpath, rename, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { digestTree } from '../recovery-snapshot.js';

/** Offline builder for one immutable native release. It reads only a reviewed
 * commit from an explicit repository, never fetches, resets, cleans, restarts a
 * service or changes an existing release. Root installation is a later step. */
export interface ReleaseBuildOptions {
 sha: string;
 /** Private JSON `{version:1,releases:[sha...]}` outside the source repository. */
 allowlistPath: string;
 sourceRepo: string;
 releaseRoot: string;
 /** Directory that holds node, npm and npx for the required Node major. */
 nodeBin?: string;
 nodeMajor?: number;
 entrypoints?: string[];
 offline?: boolean;
 npmCache?: string;
 limits?: Partial<BuildLimits>;
 run?: CommandRunner;
}
export interface BuildLimits { archiveBytes: number; archiveEntries: number; commandMs: number; outputBytes: number; }
export interface CommandSpec { command: string; args: string[]; cwd: string; env: Record<string, string>; timeoutMs: number; maxOutput: number; stdoutFile?: string; stdin?: Buffer; }
export type CommandRunner = (spec: CommandSpec) => Promise<{ code: number; stdout: Buffer }>;
export interface ReleaseBuildResult { sha: string; path: string; digest: string; created: boolean; entrypoints: string[]; }
/** Native release: runtime, inspection, start checks and isolated broker/support services. */
export const defaultReleaseEntrypoints=['dist/src/durable/daemon.js','dist/src/durable/inspect.js','dist/src/recovery-start-check.js','dist/src/isolation-start-check.js','dist/src/trusted-broker-daemon.js','dist/src/isolation-network-service.js','dist/src/isolation-proxy-service.js'] as const;
export const defaultLimits: BuildLimits = { archiveBytes: 256 * 2 ** 20, archiveEntries: 100_000, commandMs: 280_000, outputBytes: 1 << 20 };
const maxAllowlist = 256;
const sha40 = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{40}$/.test(v);
const abs = (v: string) => isAbsolute(v) && normalize(v) === v && v !== '/' && !/[\0\r\n]/.test(v);
const inside = (parent: string, child: string) => child === parent || child.startsWith(parent + sep);
const trustedUids = () => new Set([0, process.getuid?.() ?? 0]);

/** Default bounded process runner. Output beyond the cap or time beyond the limit fails. */
export const runCommand: CommandRunner = (spec) => new Promise((resolveRun, reject) => {
 const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
 const chunks: Buffer[] = []; let size = 0, done = false;
 const finish = (fn: () => void) => { if (done) return; done = true; clearTimeout(timer); fn(); };
 const kill = () => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already gone */ } };
 const timer = setTimeout(() => { kill(); finish(() => reject(new Error(`Command timed out: ${spec.command}`))); }, spec.timeoutMs);
 child.stdout.on('data', (data: Buffer) => { size += data.length; if (size > spec.maxOutput) { kill(); finish(() => reject(new Error(`Command output limit exceeded: ${spec.command}`))); } else chunks.push(data); });
 child.stderr.on('data', (data: Buffer) => {
  size += data.length;
  if(size>spec.maxOutput){kill();finish(()=>reject(new Error(`Command output limit exceeded: ${spec.command}`)));}
  else process.stderr.write(data.subarray(0,4096));
 });
 child.on('error', (error) => finish(() => reject(error)));
 child.on('close', (code) => finish(() => resolveRun({ code: code ?? 1, stdout: Buffer.concat(chunks) })));
 child.stdin.on('error', () => undefined);
 child.stdin.end(spec.stdin);
});

async function trustedFile(path: string, what: string, repo: string): Promise<void> {
 const info = await lstat(path);
 if (!info.isFile() || info.nlink !== 1 || !trustedUids().has(info.uid) || (info.mode & 0o022) !== 0 || (info.mode & 0o6000) !== 0) throw new Error(`${what} is not a trusted regular file`);
 if (inside(repo, await realpath(path))) throw new Error(`${what} must be outside the source repository`);
}
async function trustedDirectory(path: string, what: string): Promise<string> {
 if (!abs(path)) throw new Error(`${what} must be a canonical absolute path`);
 const info = await lstat(path);
 if (!info.isDirectory() || await realpath(path) !== path || !trustedUids().has(info.uid) || (info.mode & 0o022) !== 0) throw new Error(`${what} is not a trusted canonical directory`);
 return path;
}
async function readAllowlist(path: string, repo: string): Promise<Set<string>> {
 if (!abs(path)) throw new Error('Allowlist path must be absolute');
 await trustedFile(path, 'Release allowlist', repo);
 const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
 const v = parsed as { version?: unknown; releases?: unknown };
 if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).sort().join() !== 'releases,version' || v.version !== 1 ||
  !Array.isArray(v.releases) || v.releases.length > maxAllowlist || !v.releases.every(sha40)) throw new Error('Invalid release allowlist');
 return new Set(v.releases as string[]);
}
function cleanEnv(nodeBin: string, home: string, extra: Record<string, string> = {}): Record<string, string> {
 return { PATH: `${nodeBin}:/usr/bin:/bin`, HOME: home, LANG: 'C', LC_ALL: 'C', NO_COLOR: '1', ...extra };
}
function gitEnv(nodeBin: string, home: string) {
 return cleanEnv(nodeBin, home, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' });
}
async function ok(run: CommandRunner, spec: CommandSpec): Promise<Buffer> {
 const result = await run(spec);
 if (result.code !== 0) throw new Error(`Command failed (${result.code}): ${spec.command} ${spec.args.slice(0, 2).join(' ')}`);
 return result.stdout;
}
/** Reject unsafe archive entry names before extraction. */
export function assertSafeArchiveNames(listing: string, maxEntries: number): void {
 const names = listing.split('\n').filter(Boolean);
 if (!names.length || names.length > maxEntries) throw new Error('Archive entry count is outside the allowed bound');
 for (const name of names) {
  if (name.startsWith('/') || name.split('/').includes('..') || /[\0\\]/.test(name)) throw new Error('Archive contains an unsafe path');
 }
}
/** Walk the extracted tree: only files, directories and in-tree relative links. Normalizes modes to 0755/0644. */
async function sanitizeTree(root: string): Promise<void> {
 let count = 0;
 async function walk(path: string): Promise<void> {
  if (++count > 250_000) throw new Error('Release file limit exceeded');
  const info = await lstat(path);
  if (info.isSymbolicLink()) {
   const target = await readlink(path);
   if (isAbsolute(target) || !inside(root, resolve(dirname(path), target))) throw new Error('Release symlink escapes the tree');
   return;
  }
  if (!info.isDirectory() && !info.isFile()) throw new Error('Release contains an unsupported file type');
  // Normalize: readable by service identities, writable only by the owner.
  await chmod(path, info.isDirectory() || (info.mode & 0o100) ? 0o755 : 0o644);
  if (info.isDirectory()) for (const entry of await readdir(path)) await walk(join(path, entry));
 }
 await walk(root);
}
async function acquireLock(root: string): Promise<() => Promise<void>> {
 const path = join(root, '.build.lock');
 const handle = await open(path, 'wx', 0o600).catch(() => { throw new Error('Another release build holds the lock'); });
 await handle.writeFile(String(process.pid)); await handle.close();
 return () => rm(path, { force: true });
}
function sidecarPath(root: string, sha: string) { return join(root, '.digests', `${sha}.json`); }
async function writeSidecar(root: string, sha: string, digest: string): Promise<void> {
 await mkdir(join(root, '.digests'), { recursive: true, mode: 0o700 });
 const tmp = `${sidecarPath(root, sha)}.${randomBytes(6).toString('hex')}.tmp`;
 const file=await open(tmp,'wx',0o600);try{await file.writeFile(JSON.stringify({version:1,sha,digest}));await file.sync();}finally{await file.close();}
 await rename(tmp, sidecarPath(root, sha));
 const directory=await open(join(root,'.digests'),'r');try{await directory.sync();}finally{await directory.close();}
}
/** Verifies an already promoted release without changing it. */
export async function verifyRelease(releaseRoot: string, sha: string, entrypoints: string[]): Promise<ReleaseBuildResult> {
 const path = join(releaseRoot, sha);
 if (await realpath(path) !== path) throw new Error('Release path is not canonical');
 const info = await lstat(path);
 let recorded: { version?: number; sha?: string; digest?: string };
 try { recorded = JSON.parse(await readFile(sidecarPath(releaseRoot, sha), 'utf8')); } catch { throw new Error('Existing release has no digest record'); }
 if (recorded.version !== 1 || recorded.sha !== sha || typeof recorded.digest !== 'string') throw new Error('Existing release digest record is invalid');
 for (const entry of entrypoints) {
  const meta = await lstat(join(path, entry)).catch(() => undefined);
  if (!meta?.isFile()) throw new Error('Existing release lacks a required entrypoint');
 }
 const digest = await digestTree(path, true, false, undefined, info.uid);
 if (digest !== recorded.digest) throw new Error('Existing release differs from its recorded digest');
 return { sha, path, digest, created: false, entrypoints: [...entrypoints] };
}

export async function buildRelease(options: ReleaseBuildOptions): Promise<ReleaseBuildResult> {
 const limits = { ...defaultLimits, ...options.limits }, runner = options.run ?? runCommand;
 // One finite budget covers every child, including detached npm descendants.
 // A parent timeout must not leave a later build phase running after it exits.
 const deadline=Date.now()+limits.commandMs;
 const run:CommandRunner=spec=>{
  const remaining=deadline-Date.now();if(remaining<=0)return Promise.reject(new Error('Release build deadline exceeded'));
  return runner({...spec,timeoutMs:Math.min(spec.timeoutMs,remaining)});
 };
 const entrypoints = options.entrypoints ?? [...defaultReleaseEntrypoints];
 if (!sha40(options.sha)) throw new Error('A full reviewed 40-character SHA is required');
 if (!entrypoints.length || entrypoints.some((e) => isAbsolute(e) || normalize(e) !== e || e.startsWith('..') || !e.startsWith('dist/'))) throw new Error('Entrypoints must be normal paths under dist/');
 if (!abs(options.sourceRepo) || !abs(options.releaseRoot)) throw new Error('Source repository and release root must be canonical absolute paths');
 const repo = await realpath(options.sourceRepo);
 const releaseRoot = await trustedDirectory(options.releaseRoot, 'Release root');
 if (inside(repo, releaseRoot) || inside(releaseRoot, repo)) throw new Error('Release root and source repository must be separate trees');
 const allowed = await readAllowlist(options.allowlistPath, repo);
 if (!allowed.has(options.sha)) throw new Error('Revision is not in the reviewed allowlist');
 const nodeBin = options.nodeBin ?? dirname(process.execPath), major = options.nodeMajor ?? 24;
 if (!abs(nodeBin)) throw new Error('Node directory must be absolute');
 const unlock = await acquireLock(releaseRoot);
 const staging = join(releaseRoot, `.staging-${options.sha}-${randomBytes(6).toString('hex')}`);
 try {
  const final = join(releaseRoot, options.sha);
  if (await lstat(final).then(() => true, () => false)) return await verifyRelease(releaseRoot, options.sha, entrypoints);
  const version = (await ok(run, { command: join(nodeBin, 'node'), args: ['-p', 'process.versions.node'], cwd: releaseRoot, env: cleanEnv(nodeBin, releaseRoot), timeoutMs: 10_000, maxOutput: 100 })).toString().trim();
  if (Number(version.split('.')[0]) !== major) throw new Error(`Node ${major} is required; found ${version}`);
  await mkdir(staging, { mode: 0o700 });
  const home = join(staging, '.home');
  await mkdir(home, { mode: 0o700 });
  const scratch = join(staging, '.scratch');
  await mkdir(scratch, { mode: 0o700 });
  const common = { timeoutMs: limits.commandMs, maxOutput: limits.outputBytes };
  const git = (args: string[], extra: Partial<CommandSpec> = {}) => ok(run, { command: 'git', args: ['-C', repo, ...args], cwd: repo, env: gitEnv(nodeBin, home), ...common, ...extra });
  // The full SHA must name a commit object in the explicit repository. No fetch.
  const resolved = (await git(['rev-parse', '--verify', '--end-of-options', `${options.sha}^{commit}`])).toString().trim();
  if (resolved !== options.sha) throw new Error('Repository did not resolve the exact reviewed commit');
  const archive = join(scratch, 'source.tar');
  await git(['archive', '--format=tar', options.sha, '-o', archive]);
  if ((await stat(archive)).size > limits.archiveBytes) throw new Error('Archive exceeds the size bound');
  const embedded = (await ok(run, { command: 'git', args: ['get-tar-commit-id'], cwd: scratch, env: gitEnv(nodeBin, home), ...common, stdin: await readFile(archive) })).toString().trim();
  if (embedded !== options.sha) throw new Error('Archive commit identity mismatch');
  assertSafeArchiveNames((await ok(run, { command: 'tar', args: ['-tf', archive], cwd: scratch, env: cleanEnv(nodeBin, home), timeoutMs: limits.commandMs, maxOutput: 32 * 2 ** 20 })).toString(), limits.archiveEntries);
  const tree = join(staging, 'tree');
  await mkdir(tree, { mode: 0o700 });
  await ok(run, { command: 'tar', args: ['-xf', archive, '-C', tree, '--no-same-owner', '--no-same-permissions'], cwd: scratch, env: cleanEnv(nodeBin, home), ...common });
  await rm(archive);
  const npm = join(nodeBin, 'npm');
  const npmEnv = cleanEnv(nodeBin, home, { npm_config_update_notifier: 'false', ...(options.npmCache ? { npm_config_cache: options.npmCache } : {}) });
  await ok(run, { command: npm, args: ['ci', '--no-audit', '--no-fund', ...(options.offline ? ['--offline'] : [])], cwd: tree, env: npmEnv, ...common });
  await ok(run, { command: npm, args: ['run', 'build'], cwd: tree, env: npmEnv, ...common });
  for (const entry of entrypoints) if (!(await lstat(join(tree, entry)).catch(() => undefined))?.isFile()) throw new Error(`Build did not produce ${entry}`);
  await rm(home, { recursive: true, force: true }); await rm(scratch, { recursive: true, force: true });
  await sanitizeTree(tree);
  const info = await lstat(tree);
  const digest = await digestTree(tree, true, true, undefined, info.uid);
  await writeSidecar(releaseRoot, options.sha, digest);
  // Single atomic rename onto an absent path; failure leaves no release path.
  await rename(tree, final);
  const directory=await open(releaseRoot,'r');try{await directory.sync();}finally{await directory.close();}
  await rm(staging, { recursive: true, force: true });
  return { sha: options.sha, path: final, digest, created: true, entrypoints };
 } catch (error) {
  await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  throw error;
 } finally { await unlock(); }
}
