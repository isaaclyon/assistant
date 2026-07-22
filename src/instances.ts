import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

export type BridgePrincipal = "isaac" | "emma" | "household" | "engineering";
export type BridgeMemoryView = "owner-and-household" | "household" | "none";
export type BridgeJobsRole = "coordinator" | "target-only" | "disabled";

export interface PrivateTelegramSurface {
  type: "private";
}

export interface HouseholdGroupTelegramSurface {
  type: "household-group";
  chatId: number;
  actors: {
    isaac: number;
    emma: number;
  };
}

export type BridgeTelegramSurface =
  | PrivateTelegramSurface
  | HouseholdGroupTelegramSurface;

export interface BridgeInstanceDefinition {
  id: string;
  displayName: string;
  principal: BridgePrincipal;
  telegramProfile: string;
  telegramSurface: BridgeTelegramSurface;
  workspaceCwd: string;
  capabilityProfile: string;
  credentialScope: string;
  memoryView: BridgeMemoryView;
  jobsRole: BridgeJobsRole;
}

export interface BridgeInstanceManifest {
  version: 1;
  instances: BridgeInstanceDefinition[];
}

export interface BridgeInstancePathRoots {
  stateRoot: string;
  configRoot: string;
}

export interface BridgeInstancePaths {
  stateDir: string;
  sessionDir: string;
  inboxPath: string;
  codexConfigPath: string;
  restartMarkerPath: string;
  runtimeMetadataPath: string;
  checkerStateDir: string;
  environmentFilePath: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknownFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unknown) throw new Error(`${label} has unknown field "${unknown}"`);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function requireSlug(value: unknown, field: string): string {
  const stringValue = requireString(value, field);
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(stringValue)) {
    throw new Error(`${field} must be a lowercase slug of at most 64 characters`);
  }
  return stringValue;
}

function requireTelegramProfile(value: unknown, field: string): string {
  const profile = requireString(value, field);
  if (
    !/^[a-z0-9]{1,32}$/.test(profile) ||
    ["default", "main", "active"].includes(profile)
  ) {
    throw new Error(
      `${field} must be a lowercase alphanumeric named profile of at most 32 characters and not default, main, or active`,
    );
  }
  return profile;
}

function requireAbsolutePath(value: unknown, field: string): string {
  const stringValue = requireString(value, field);
  if (!isAbsolute(stringValue)) throw new Error(`${field} must be an absolute path`);
  return resolve(stringValue);
}

function requireSafeInteger(value: unknown, field: string, positive: boolean): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    (positive ? value <= 0 : value === 0)
  ) {
    throw new Error(`${field} must be a ${positive ? "positive " : "nonzero "}safe integer`);
  }
  return value;
}

function requireEnum<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`${field} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

function parseInstance(value: unknown, index: number): BridgeInstanceDefinition {
  const field = (name: string): string => `instances[${index}].${name}`;
  if (!isRecord(value)) throw new Error(`instances[${index}] must be an object`);
  rejectUnknownFields(
    value,
    [
      "id",
      "displayName",
      "principal",
      "telegramProfile",
      "telegramSurface",
      "workspaceCwd",
      "capabilityProfile",
      "credentialScope",
      "memoryView",
      "jobsRole",
    ],
    `instances[${index}]`,
  );
  if (!isRecord(value.telegramSurface)) {
    throw new Error(`${field("telegramSurface")} must be an object`);
  }
  let telegramSurface: BridgeTelegramSurface;
  if (value.telegramSurface.type === "private") {
    rejectUnknownFields(
      value.telegramSurface,
      ["type"],
      field("telegramSurface"),
    );
    telegramSurface = { type: "private" };
  } else if (
    value.telegramSurface.type === "household-group" &&
    isRecord(value.telegramSurface.actors)
  ) {
    rejectUnknownFields(
      value.telegramSurface,
      ["type", "chatId", "actors"],
      field("telegramSurface"),
    );
    rejectUnknownFields(
      value.telegramSurface.actors,
      ["isaac", "emma"],
      `${field("telegramSurface")}.actors`,
    );
    const chatId = requireSafeInteger(
      value.telegramSurface.chatId,
      `${field("telegramSurface")}.chatId`,
      false,
    );
    if (chatId >= 0) {
      throw new Error(
        `${field("telegramSurface")}.chatId must be a negative safe integer`,
      );
    }
    const isaacActorId = requireSafeInteger(
      value.telegramSurface.actors.isaac,
      `${field("telegramSurface")}.actors.isaac`,
      true,
    );
    const emmaActorId = requireSafeInteger(
      value.telegramSurface.actors.emma,
      `${field("telegramSurface")}.actors.emma`,
      true,
    );
    if (isaacActorId === emmaActorId) {
      throw new Error(`${field("telegramSurface")} actor IDs must be distinct`);
    }
    telegramSurface = {
      type: "household-group",
      chatId,
      actors: {
        isaac: isaacActorId,
        emma: emmaActorId,
      },
    };
  } else {
    throw new Error(`${field("telegramSurface")} has an unsupported type`);
  }
  const principal = requireEnum(value.principal, field("principal"), [
    "isaac",
    "emma",
    "household",
    "engineering",
  ]);
  const memoryView = requireEnum(value.memoryView, field("memoryView"), [
    "owner-and-household",
    "household",
    "none",
  ]);
  if (principal === "household" && memoryView !== "household") {
    throw new Error(`instances[${index}] household principal must use household memory`);
  }
  if (
    (principal === "isaac" || principal === "emma") &&
    memoryView !== "owner-and-household"
  ) {
    throw new Error(
      `instances[${index}] personal principal must use owner-and-household memory`,
    );
  }
  if (principal === "engineering" && memoryView !== "none") {
    throw new Error(`instances[${index}] engineering principal must use no memory`);
  }
  const credentialScope = requireString(
    value.credentialScope,
    field("credentialScope"),
  );
  if (principal === "household" && credentialScope !== "household") {
    throw new Error(
      `instances[${index}] household principal must use the household credential scope`,
    );
  }
  const personalCredentialScope =
    principal === "isaac"
      ? "isaac-personal"
      : principal === "emma"
        ? "emma-personal"
        : principal === "engineering"
          ? "engineering"
          : undefined;
  if (personalCredentialScope && credentialScope !== personalCredentialScope) {
    throw new Error(
      `instances[${index}] ${principal} principal must use ${personalCredentialScope} credentials`,
    );
  }
  if (principal === "household" && telegramSurface.type !== "household-group") {
    throw new Error(
      `instances[${index}] household principal must use a household-group surface`,
    );
  }
  if (principal !== "household" && telegramSurface.type === "household-group") {
    throw new Error(
      `instances[${index}] household-group surface requires the household principal`,
    );
  }
  return {
    id: requireSlug(value.id, field("id")),
    displayName: requireString(value.displayName, field("displayName")),
    principal,
    telegramProfile: requireTelegramProfile(
      value.telegramProfile,
      field("telegramProfile"),
    ),
    telegramSurface,
    workspaceCwd: requireAbsolutePath(value.workspaceCwd, field("workspaceCwd")),
    capabilityProfile: requireString(
      value.capabilityProfile,
      field("capabilityProfile"),
    ),
    credentialScope,
    memoryView,
    jobsRole: requireEnum(value.jobsRole, field("jobsRole"), [
      "coordinator",
      "target-only",
      "disabled",
    ]),
  };
}

export function parseBridgeInstanceManifest(raw: string): BridgeInstanceManifest {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error("Bridge instance manifest is not valid JSON", { cause: error });
  }
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.instances)) {
    throw new Error('Bridge instance manifest must declare version 1 and an "instances" array');
  }
  rejectUnknownFields(value, ["version", "instances"], "Bridge instance manifest");
  const instances = value.instances.map(parseInstance);
  const seenIds = new Set<string>();
  const seenWorkspaces = new Set<string>();
  const seenTelegramProfiles = new Set<string>();
  for (const instance of instances) {
    if (seenIds.has(instance.id)) {
      throw new Error(`Duplicate bridge instance ID: "${instance.id}"`);
    }
    seenIds.add(instance.id);
    if (seenWorkspaces.has(instance.workspaceCwd)) {
      throw new Error(
        `Duplicate bridge instance workspaceCwd "${instance.workspaceCwd}"`,
      );
    }
    seenWorkspaces.add(instance.workspaceCwd);
    if (seenTelegramProfiles.has(instance.telegramProfile)) {
      throw new Error(
        `Duplicate bridge instance telegramProfile "${instance.telegramProfile}"`,
      );
    }
    seenTelegramProfiles.add(instance.telegramProfile);
  }
  if (instances.filter((instance) => instance.jobsRole === "coordinator").length > 1) {
    throw new Error("Bridge instance manifest must define at most one jobs coordinator");
  }
  return { version: 1, instances };
}

export async function loadBridgeInstanceManifest(
  path: string,
): Promise<BridgeInstanceManifest> {
  const mode = (await stat(path)).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(
      "Bridge instance manifest must not be accessible by group or other users",
    );
  }
  return parseBridgeInstanceManifest(await readFile(path, "utf8"));
}

export function selectBridgeInstance(
  manifest: BridgeInstanceManifest,
  instanceId: string,
): BridgeInstanceDefinition {
  const instance = manifest.instances.find((candidate) => candidate.id === instanceId);
  if (!instance) throw new Error(`Unknown bridge instance: ${instanceId}`);
  return instance;
}

export function resolveBridgeInstancePaths(
  instance: BridgeInstanceDefinition,
  roots: BridgeInstancePathRoots,
): BridgeInstancePaths {
  const stateRoot = requireAbsolutePath(roots.stateRoot, "stateRoot");
  const configRoot = requireAbsolutePath(roots.configRoot, "configRoot");
  const stateDir = join(stateRoot, "instances", instance.id);

  return {
    stateDir,
    sessionDir: join(stateDir, "sessions"),
    inboxPath: join(stateDir, "inbox.db"),
    codexConfigPath: join(stateDir, "pi-codex-conversion.json"),
    restartMarkerPath: join(stateDir, "restart-pending.json"),
    runtimeMetadataPath: join(stateDir, "runtime.json"),
    checkerStateDir: join(stateDir, "checkers"),
    environmentFilePath: join(configRoot, "instances", `${instance.id}.env`),
  };
}
