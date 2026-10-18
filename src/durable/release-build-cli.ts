import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildRelease } from './release-build.js';

const flags = new Set(['sha', 'allowlist', 'source', 'release-root', 'node-bin', 'node-major', 'entrypoint', 'npm-cache', 'offline']);
/** Strict arguments: every flag is explicit and repeats are rejected except --entrypoint. */
export function parseBuildArgs(argv: string[]) {
 const values = new Map<string, string[]>();
 for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]!;
  if (!arg.startsWith('--') || !flags.has(arg.slice(2))) throw new Error(`Unknown argument: ${arg}`);
  const name = arg.slice(2);
  if (name === 'offline') { if (values.has(name)) throw new Error('Repeated --offline'); values.set(name, []); continue; }
  const value = argv[++i];
  if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
  if (values.has(name) && name !== 'entrypoint') throw new Error(`Repeated ${arg}`);
  values.set(name, [...(values.get(name) ?? []), value]);
 }
 const one = (name: string) => values.get(name)?.[0];
 for (const required of ['sha', 'allowlist', 'source', 'release-root']) if (!one(required)) throw new Error(`Missing --${required}`);
 const major = one('node-major');
 if (major !== undefined && !/^\d{1,3}$/.test(major)) throw new Error('Invalid --node-major');
 return { sha: one('sha')!, allowlistPath: one('allowlist')!, sourceRepo: one('source')!, releaseRoot: one('release-root')!,
  ...(one('node-bin')===undefined?{}:{nodeBin:one('node-bin')!}), ...(major===undefined?{}:{nodeMajor:Number(major)}),
  ...(values.has('entrypoint')?{entrypoints:values.get('entrypoint')!}:{}),
  ...(one('npm-cache')===undefined?{}:{npmCache:one('npm-cache')!}), offline:values.has('offline') };
}
export async function main(argv: string[], out: (line: string) => void = (l) => process.stdout.write(`${l}\n`)): Promise<number> {
 try { out(JSON.stringify(await buildRelease(parseBuildArgs(argv)))); return 0; }
 catch (error) { process.stderr.write(`release build failed: ${(error as Error).message}\n`); return 1; }
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
