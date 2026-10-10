import { createHash, randomUUID } from "node:crypto";
import { chown, lstat, open, readFile, realpath, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeDurableExclusive } from "./isolated-recovery.js";
import { parseTrustedBrokerConfig, type TrustedBrokerConfig } from "./trusted-broker-config.js";

export interface TelegramOwnershipMigration {
  sourcePath: string;
  sourceUid: number;
  profile: string;
  runtimePath: string;
  runtimeUid: number;
  runtimeGid: number;
  brokerPath: string;
  brokerUid: number;
  brokerGid: number;
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const identityKeys = ["botToken", "botUsername", "botId", "allowedUserId", "lastUpdateId"];
const sharedKeys = ["proactivePush", "assistant", "draftPreviews", "richDraftPreviews", "assistantRendering", "voice", "time"];
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

/** Select one named identity; the real token is emitted only into the broker
 * configuration. Preserve the exact stopped poller's next update offset. */
export function splitTelegramOwnership(source: unknown, profile: string, template: TrustedBrokerConfig): { runtime: Record<string, unknown>; broker: TrustedBrokerConfig } {
  if (!/^[a-z0-9]{1,32}$/.test(profile) || ["default", "main", "active"].includes(profile) || !record(source) ||
      !record(source.profiles) || !record(source.profiles[profile]) ||
      Object.keys(source).some(key => ![...identityKeys, ...sharedKeys, "profiles"].includes(key))) throw new Error("Telegram migration requires an explicitly selected supported profile");
  const selected = source.profiles[profile];
  if (Object.keys(selected).some(key => !identityKeys.includes(key)) || !Number.isSafeInteger(selected.botId) || Number(selected.botId) <= 0 ||
      !Number.isSafeInteger(selected.allowedUserId) || Number(selected.allowedUserId) <= 0 ||
      (selected.lastUpdateId !== undefined && (!Number.isSafeInteger(selected.lastUpdateId) || Number(selected.lastUpdateId) < -1))) throw new Error("Telegram migration identity is incomplete");
  const lastUpdateId = selected.lastUpdateId === undefined ? -1 : Number(selected.lastUpdateId);
  const broker = parseTrustedBrokerConfig({ ...template, botToken: selected.botToken, userId: selected.allowedUserId, initialOffset: lastUpdateId + 1 });
  const runtime = {
    ...Object.fromEntries(sharedKeys.filter(key => Object.hasOwn(source, key)).map(key => [key, source[key]])),
    profiles: { [profile]: { ...selected, botToken: `${selected.botId}:runtime`, lastUpdateId } },
  };
  return { runtime, broker };
}

/** The deployment coordinator supplies quiescence verification covering both
 * pollers. No network calls or resets occur during this handoff. */
export async function migrateTelegramOwnership(spec: TelegramOwnershipMigration, checkpoint: string, assertQuiescent: () => Promise<void>): Promise<void> {
  await assertQuiescent();
  try { await lstat(join(checkpoint, "candidate-started")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; else return migrateBeforeStart(spec, checkpoint); }
  throw new Error("A candidate started; Telegram ownership cannot be refreshed from the old poller");
}

async function migrateBeforeStart(spec: TelegramOwnershipMigration, checkpoint: string): Promise<void> {
  const specDigest = hash(JSON.stringify(spec));
  const complete = join(checkpoint, "telegram-ownership-complete.json");
  let completion: { specDigest: string; runtimeDigest: string; brokerDigest: string } | undefined;
  try { completion = JSON.parse(await readFile(complete, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (completion) {
    if (completion.specDigest !== specDigest || hash(await readFile(spec.runtimePath, "utf8")) !== completion.runtimeDigest ||
        hash(await readFile(spec.brokerPath, "utf8")) !== completion.brokerDigest) throw new Error("Completed Telegram handoff changed");
    return;
  }
  for (const path of [spec.sourcePath, spec.brokerPath]) if (await realpath(path) !== path) throw new Error("Noncanonical Telegram migration path");
  if (await realpath(dirname(spec.runtimePath)) !== dirname(spec.runtimePath) ||
      new Set([spec.sourcePath, spec.runtimePath, spec.brokerPath]).size !== 3) throw new Error("Unsafe Telegram migration destination");
  for (const [path, uid] of [[spec.sourcePath, spec.sourceUid], [spec.brokerPath, spec.brokerUid]] as const) {
    const info = await lstat(path);
    if (!info.isFile() || info.nlink !== 1 || info.uid !== uid || (info.mode & 0o777) !== 0o600 || info.size > 64_000) throw new Error("Unsafe Telegram migration source ownership");
  }
  const source = await readFile(spec.sourcePath, "utf8"), template = parseTrustedBrokerConfig(JSON.parse(await readFile(spec.brokerPath, "utf8")));
  const split = splitTelegramOwnership(JSON.parse(source), spec.profile, template);
  // Root-private paired evidence includes the original shared token file. Its
  // bytes are never copied into the personal runtime or logged.
  await writeDurableExclusive(join(checkpoint, "telegram-ownership-original.json"), JSON.parse(source));
  const replacements = [{ path: spec.runtimePath, uid: spec.runtimeUid, gid: spec.runtimeGid, value: split.runtime },
    { path: spec.brokerPath, uid: spec.brokerUid, gid: spec.brokerGid, value: split.broker }];
  const digests: string[] = [];
  for (const replacement of replacements) {
    const temporary = `${replacement.path}.migration-${randomUUID()}`;
    const raw = JSON.stringify(replacement.value) + "\n";
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(raw); await file.sync(); } finally { await file.close(); }
    await chown(temporary, replacement.uid, replacement.gid);
    await rename(temporary, replacement.path);
    const directory = await open(dirname(replacement.path), "r"); try { await directory.sync(); } finally { await directory.close(); }
    digests.push(hash(raw));
  }
  await writeDurableExclusive(complete, { specDigest, runtimeDigest: digests[0], brokerDigest: digests[1], initialOffset: split.broker.initialOffset });
}
