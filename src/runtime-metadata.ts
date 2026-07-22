import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { BridgePrincipal } from "./instances.js";

export type BridgeRuntimeStatus = "starting" | "ready" | "stopping" | "failed";

export interface BridgeRuntimeMetadata {
  version: 1;
  instanceId: string;
  releaseSha: string;
  pid: number;
  status: BridgeRuntimeStatus;
  principal: BridgePrincipal;
  telegramSurface: "private" | "household-group";
  workspaceCwd: string;
  resourceRoot: string;
  sessionFile?: string;
  updatedAt: string;
}

export interface ExpectedRuntimeIdentity {
  instanceId: string;
  releaseSha: string;
  pid: number;
}

export interface RuntimeMetadataInput {
  instanceId: string;
  releaseSha: string;
  pid: number;
  status: BridgeRuntimeStatus;
  principal: BridgePrincipal;
  telegramSurface: "private" | "household-group";
  workspaceCwd: string;
  resourceRoot: string;
  sessionFile?: string;
  now?: () => Date;
}

const INSTANCE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const PRINCIPALS = new Set(["isaac", "emma", "household", "engineering"]);
const STATUSES = new Set(["starting", "ready", "stopping", "failed"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateRuntimeMetadata(value: unknown): BridgeRuntimeMetadata {
  if (!isRecord(value) || value.version !== 1) {
    throw new Error("Runtime metadata must declare version 1");
  }
  if (typeof value.instanceId !== "string" || !INSTANCE_PATTERN.test(value.instanceId)) {
    throw new Error("Runtime metadata has an invalid instance ID");
  }
  if (typeof value.releaseSha !== "string" || !SHA_PATTERN.test(value.releaseSha)) {
    throw new Error("Runtime metadata has an invalid release SHA");
  }
  if (!Number.isSafeInteger(value.pid) || (value.pid as number) <= 0) {
    throw new Error("Runtime metadata has an invalid PID");
  }
  if (typeof value.status !== "string" || !STATUSES.has(value.status)) {
    throw new Error("Runtime metadata has an invalid status");
  }
  if (typeof value.principal !== "string" || !PRINCIPALS.has(value.principal)) {
    throw new Error("Runtime metadata has an invalid principal");
  }
  if (value.telegramSurface !== "private" && value.telegramSurface !== "household-group") {
    throw new Error("Runtime metadata has an invalid Telegram surface");
  }
  if (
    typeof value.workspaceCwd !== "string" ||
    typeof value.resourceRoot !== "string" ||
    typeof value.updatedAt !== "string" ||
    Number.isNaN(Date.parse(value.updatedAt)) ||
    (value.sessionFile !== undefined && typeof value.sessionFile !== "string")
  ) {
    throw new Error("Runtime metadata has invalid paths or timestamp");
  }
  return value as unknown as BridgeRuntimeMetadata;
}

export function createRuntimeMetadata({
  now = () => new Date(),
  ...input
}: RuntimeMetadataInput): BridgeRuntimeMetadata {
  return validateRuntimeMetadata({
    version: 1,
    ...input,
    updatedAt: now().toISOString(),
  });
}

export async function writeRuntimeMetadata(
  path: string,
  metadata: BridgeRuntimeMetadata,
): Promise<void> {
  const validated = validateRuntimeMetadata(metadata);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

export async function readRuntimeMetadata(
  path: string,
): Promise<BridgeRuntimeMetadata | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Runtime metadata is not valid JSON: ${path}`, { cause: error });
  }
  return validateRuntimeMetadata(value);
}

export function assertRuntimeReady(
  metadata: BridgeRuntimeMetadata | undefined,
  expected: ExpectedRuntimeIdentity,
): BridgeRuntimeMetadata {
  if (!metadata) throw new Error(`Runtime readiness is missing for ${expected.instanceId}`);
  if (metadata.instanceId !== expected.instanceId) {
    throw new Error(
      `Runtime readiness instance mismatch: expected ${expected.instanceId}, observed ${metadata.instanceId}`,
    );
  }
  if (metadata.releaseSha !== expected.releaseSha) {
    throw new Error(
      `Runtime readiness release mismatch for ${expected.instanceId}: expected ${expected.releaseSha}, observed ${metadata.releaseSha}`,
    );
  }
  if (metadata.pid !== expected.pid) {
    throw new Error(
      `Runtime readiness PID changed for ${expected.instanceId}: expected ${expected.pid}, observed ${metadata.pid}`,
    );
  }
  if (metadata.status !== "ready") {
    throw new Error(
      `Runtime ${expected.instanceId} is not ready (status ${metadata.status})`,
    );
  }
  return metadata;
}
