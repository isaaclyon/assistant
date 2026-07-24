import { access, link, mkdir, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { openPlacesStore } from "./places-store.js";

export async function runPlacesCli(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const [command, destinationRaw] = args;
  const stateDir = env.PI_TELEGRAM_BRIDGE_STATE_DIR?.trim();
  if (!stateDir) throw new Error("PI_TELEGRAM_BRIDGE_STATE_DIR is required");
  if ((command !== "backup" && command !== "export") || !destinationRaw) {
    throw new Error("Usage: places-cli <backup|export> <destination-path>");
  }
  const sourcePath = join(stateDir, "places.db");
  await access(sourcePath);
  const destination = resolve(destinationRaw);
  const store = openPlacesStore(sourcePath);
  try {
    if (command === "backup") {
      await store.backup(destination);
      return;
    }
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    const temporaryPath = join(dirname(destination), `.places-export-${randomUUID()}.tmp`);
    try {
      await writeFile(temporaryPath, `${JSON.stringify(store.exportPublishedData(), null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await link(temporaryPath, destination);
    } finally {
      await unlink(temporaryPath).catch(() => {});
    }
  } finally {
    store.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  runPlacesCli(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
