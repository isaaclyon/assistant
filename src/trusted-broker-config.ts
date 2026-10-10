import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";
import type { ApprovedVaultConfig } from "./approved-login-vault.js";

export interface TrustedBrokerConfig {
  version: 1;
  instance: string;
  botToken: string;
  userId: number;
  initialOffset: number;
  socketPath: string;
  databasePath: string;
  vault: ApprovedVaultConfig;
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const path = (value: unknown): value is string => typeof value === "string" && isAbsolute(value) && normalize(value) === value && !/[\0\r\n%]/.test(value);
const id = (value: unknown): value is string => typeof value === "string" && /^[a-z0-9]{26}$/.test(value);

export function parseTrustedBrokerConfig(value: unknown): TrustedBrokerConfig {
  if (!record(value) || !exactKeys(value, ["version", "instance", "botToken", "userId", "initialOffset", "socketPath", "databasePath", "vault"]) ||
      value.version !== 1 || typeof value.instance !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value.instance) ||
      typeof value.botToken !== "string" || !/^\d+:[A-Za-z0-9_-]+$/.test(value.botToken) ||
      !Number.isSafeInteger(value.userId) || Number(value.userId) <= 0 || !Number.isSafeInteger(value.initialOffset) || Number(value.initialOffset) < 0 ||
      !path(value.socketPath) || !path(value.databasePath) || !record(value.vault) ||
      !exactKeys(value.vault, ["binary", "tokenFile", "sourceVault", "sourceName", "destinationVault", "home"]) ||
      !path(value.vault.binary) || !path(value.vault.tokenFile) || !path(value.vault.home) ||
      !id(value.vault.sourceVault) || !id(value.vault.destinationVault) || value.vault.sourceVault === value.vault.destinationVault ||
      typeof value.vault.sourceName !== "string" || !value.vault.sourceName || value.vault.sourceName.length > 200 || /[\0\r\n]/.test(value.vault.sourceName)) {
    throw new Error("Invalid trusted broker configuration");
  }
  return value as unknown as TrustedBrokerConfig;
}

export async function loadTrustedBrokerConfig(filename: string): Promise<TrustedBrokerConfig> {
  try {
    const stat = await lstat(filename);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size > 32_000) throw new Error();
    return parseTrustedBrokerConfig(JSON.parse(await readFile(filename, "utf8")));
  } catch { throw new Error("Trusted broker configuration unavailable"); }
}
