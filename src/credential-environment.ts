import { readFile, stat } from "node:fs/promises";

export type CredentialScope =
  | "isaac-personal"
  | "emma-personal"
  | "household"
  | "engineering";

const OPERATIONAL_KEYS = new Set([
  "PI_TELEGRAM_CREDENTIAL_SCOPE",
  "PI_TELEGRAM_BRIDGE_WEBHOOK_HOST",
  "PI_TELEGRAM_BRIDGE_WEBHOOK_PORT",
  "PI_TELEGRAM_MEMORY_DIR",
  "PI_TELEGRAM_MEMORY_GIT_AUTOCOMMIT",
  "PI_TELEGRAM_SESSION_IDLE_HOURS",
  "PI_TELEGRAM_GOG_BINARY",
  "PI_TELEGRAM_GOG_HOME",
  "PI_TELEGRAM_GOG_KEYRING_PASSWORD_FILE",
  "PI_TELEGRAM_GOOGLE_ACCOUNT",
  "PI_TELEGRAM_GOOGLE_PLACES_API_KEY_FILE",
  "PI_TELEGRAM_GOOGLE_PLACES_SEARCH_MONTHLY_LIMIT",
  "PI_TELEGRAM_GOOGLE_PLACES_DETAILS_MONTHLY_LIMIT",
  "PI_TELEGRAM_GOOGLE_PLACES_CANDIDATES_MONTHLY_LIMIT",
]);

const CREDENTIAL_PREFIXES: Record<CredentialScope, readonly string[]> = {
  "isaac-personal": ["PI_CREDENTIAL_ISAAC_", "PI_CREDENTIAL_HOUSEHOLD_"],
  "emma-personal": ["PI_CREDENTIAL_EMMA_", "PI_CREDENTIAL_HOUSEHOLD_"],
  household: ["PI_CREDENTIAL_HOUSEHOLD_"],
  engineering: ["PI_CREDENTIAL_ENGINEERING_"],
};

export interface CredentialEnvironmentSummary {
  scope: CredentialScope;
  keys: string[];
  webhookHost?: string;
  webhookPort?: number;
  sessionIdleHours?: number;
}

function isCredentialScope(value: string): value is CredentialScope {
  return Object.hasOwn(CREDENTIAL_PREFIXES, value);
}

export async function validateCredentialEnvironmentFile(
  path: string,
  expectedScope: string,
): Promise<CredentialEnvironmentSummary> {
  if (!isCredentialScope(expectedScope)) {
    throw new Error(`Unknown credential scope: ${expectedScope}`);
  }
  const metadata = await stat(path);
  if ((metadata.mode & 0o777) !== 0o600) {
    throw new Error(`Credential environment file must have mode 0600: ${path}`);
  }
  const currentUid = process.getuid?.();
  if (currentUid !== undefined && metadata.uid !== currentUid) {
    throw new Error(`Credential environment file must be owned by the service user: ${path}`);
  }

  const keys: string[] = [];
  let declaredScope: string | undefined;
  let webhookHost: string | undefined;
  let webhookPort: number | undefined;
  let sessionIdleHours: number | undefined;
  const seenKeys = new Set<string>();
  for (const [index, sourceLine] of (await readFile(path, "utf8")).split(/\r?\n/).entries()) {
    const line = sourceLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match) {
      throw new Error(`Credential environment line ${index + 1} is invalid`);
    }
    const key = match[1]!;
    if (seenKeys.has(key)) {
      throw new Error(`Credential environment contains duplicate key ${key}`);
    }
    seenKeys.add(key);
    keys.push(key);
    if (key === "PI_TELEGRAM_CREDENTIAL_SCOPE") {
      declaredScope = match[2]!.trim();
      if (declaredScope !== expectedScope) {
        throw new Error(
          `Credential environment declares credential scope ${declaredScope || "missing"}; expected ${expectedScope}`,
        );
      }
      continue;
    }
    if (key === "PI_TELEGRAM_BRIDGE_WEBHOOK_HOST") {
      webhookHost = match[2]!.trim();
    }
    if (key === "PI_TELEGRAM_BRIDGE_WEBHOOK_PORT") {
      const parsed = Number(match[2]!.trim());
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
        throw new Error(`Credential environment line ${index + 1} has an invalid webhook port`);
      }
      webhookPort = parsed;
    }
    if (key === "PI_TELEGRAM_SESSION_IDLE_HOURS") {
      const parsed = Number(match[2]!.trim());
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 8_760) {
        throw new Error(
          `Credential environment line ${index + 1} has an invalid session idle timeout; expected 0 through 8760 hours`,
        );
      }
      sessionIdleHours = parsed;
    }
    if (
      key === "PI_TELEGRAM_GOOGLE_PLACES_SEARCH_MONTHLY_LIMIT" ||
      key === "PI_TELEGRAM_GOOGLE_PLACES_DETAILS_MONTHLY_LIMIT" ||
      key === "PI_TELEGRAM_GOOGLE_PLACES_CANDIDATES_MONTHLY_LIMIT"
    ) {
      const raw = match[2]!.trim();
      const parsed = Number(raw);
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(parsed) || parsed > 1_000_000) {
        throw new Error(
          `Credential environment line ${index + 1} has an invalid Google Places monthly limit; expected 0 through 1000000`,
        );
      }
    }
    if (OPERATIONAL_KEYS.has(key)) continue;
    if (
      !CREDENTIAL_PREFIXES[expectedScope].some((prefix) => key.startsWith(prefix))
    ) {
      throw new Error(
        `Environment key ${key} is not allowed for credential scope ${expectedScope}`,
      );
    }
  }
  if (declaredScope !== expectedScope) {
    throw new Error(
      `Credential environment declares credential scope ${declaredScope ?? "missing"}; expected ${expectedScope}`,
    );
  }
  return {
    scope: expectedScope,
    keys,
    ...(webhookHost ? { webhookHost } : {}),
    ...(webhookPort === undefined ? {} : { webhookPort }),
    ...(sessionIdleHours === undefined ? {} : { sessionIdleHours }),
  };
}
