import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { readMigrationJson } from '../jobs-migration.js';
import { applyMigration, inventoryMigration, planMigration, verifyMigrationOutput, type MigrationManifest } from './migration.js';

const usage = 'usage: migration-cli (inventory|dry-run) --manifest <abs file> | apply --manifest <abs file> --output <abs dir> --plan-digest <sha256> --uncertain quarantine --unaccepted hold | verify --output <abs dir>';
function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index < 0 ? undefined : args[index + 1];
}

/** Offline operator entry point. Prints content-free JSON only; the manifest names frozen copies. */
export async function runMigrationCli(args: string[], print: (line: string) => void = line => console.log(line)): Promise<number> {
  try {
    const [command] = args;
    if (command === 'verify') {
      const output = option(args, 'output');
      if (!output) throw new Error(usage);
      print(JSON.stringify(await verifyMigrationOutput(output), null, 2));
      return 0;
    }
    const path = option(args, 'manifest');
    if (!path || !['inventory', 'dry-run', 'apply'].includes(command ?? '')) throw new Error(usage);
    const manifest = (await readMigrationJson(path)).value as MigrationManifest;
    if (command === 'inventory') print(JSON.stringify({ assets: await inventoryMigration(manifest) }, null, 2));
    else if (command === 'dry-run') print(JSON.stringify(await planMigration(manifest), null, 2));
    else {
      const outputDir = option(args, 'output'), expectedPlanDigest = option(args, 'plan-digest');
      if (!outputDir || !expectedPlanDigest || option(args, 'uncertain') !== 'quarantine' || option(args, 'unaccepted') !== 'hold') throw new Error(usage);
      print(JSON.stringify(await applyMigration(manifest, { outputDir, expectedPlanDigest, disposition: { uncertain: 'quarantine', unaccepted: 'hold' } }), null, 2));
    }
    return 0;
  } catch (error) {
    // Messages are authored content-free; never print paths or row data.
    print(JSON.stringify({ error: error instanceof Error ? error.message.split('\n')[0] : 'Migration failed' }));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.umask(0o077);
  process.exitCode = await runMigrationCli(process.argv.slice(2));
}
