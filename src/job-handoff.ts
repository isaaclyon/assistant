import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

const MAX_HANDOFF_PROMPT_BYTES = 32 * 1024;

interface JobHandoffFile {
  version: 1;
  dispatchId: string;
  jobId: string;
  target: string;
  prompt: string;
  createdAt: string;
}

type RecipientStatus = "pending" | "enqueued";

interface JobDispatchStatus {
  version: 1;
  dispatchId: string;
  eventHash: string;
  jobId: string;
  target: string;
  recipients: Record<string, RecipientStatus>;
  createdAt: string;
}

export interface EnqueueJobHandoffOptions {
  stateRoot: string;
  coordinatorStateDir: string;
  eventId: string;
  jobId: string;
  target: string;
  prompt: string;
  now?: () => Date;
}

export interface EnqueueJobHandoffResult {
  dispatchId: string;
  recipients: Record<string, RecipientStatus>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporaryPath, path);
}

function parseDispatchStatus(raw: string, path: string): JobDispatchStatus {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid job dispatch status: ${path}`, { cause: error });
  }
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.dispatchId !== "string" ||
    typeof value.eventHash !== "string" ||
    typeof value.jobId !== "string" ||
    typeof value.target !== "string" ||
    typeof value.createdAt !== "string" ||
    !isRecord(value.recipients) ||
    !Object.values(value.recipients).every(
      (status) => status === "pending" || status === "enqueued",
    )
  ) {
    throw new Error(`Invalid job dispatch status: ${path}`);
  }
  return value as unknown as JobDispatchStatus;
}

export async function enqueueJobHandoff({
  stateRoot,
  coordinatorStateDir,
  eventId,
  jobId,
  target,
  prompt,
  now = () => new Date(),
}: EnqueueJobHandoffOptions): Promise<EnqueueJobHandoffResult> {
  if (!/^[a-z0-9-]{1,64}$/.test(jobId)) throw new Error("Invalid handoff job ID");
  if (!/^[a-z0-9-]{1,64}$/.test(target)) throw new Error("Invalid handoff target");
  if (
    prompt.trim().length === 0 ||
    Buffer.byteLength(prompt, "utf8") > MAX_HANDOFF_PROMPT_BYTES
  ) {
    throw new Error("Job handoff prompt must be non-empty and at most 32 KB");
  }
  const recipients = target === "both-personal" ? ["isaac", "emma"] : [target];
  const eventHash = createHash("sha256").update(eventId).digest("hex");
  const dispatchId = `${jobId}-${eventHash.slice(0, 16)}`;
  const dispatchDir = join(coordinatorStateDir, "job-dispatches");
  const dispatchPath = join(dispatchDir, `${dispatchId}.json`);
  await mkdir(dispatchDir, { recursive: true, mode: 0o700 });

  let status: JobDispatchStatus;
  try {
    status = parseDispatchStatus(await readFile(dispatchPath, "utf8"), dispatchPath);
    if (
      status.eventHash !== eventHash ||
      status.jobId !== jobId ||
      status.target !== target ||
      Object.keys(status.recipients).sort().join(",") !== recipients.slice().sort().join(",")
    ) {
      throw new Error(`Job dispatch identity collision: ${dispatchId}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    status = {
      version: 1,
      dispatchId,
      eventHash,
      jobId,
      target,
      recipients: Object.fromEntries(
        recipients.map((recipient) => [recipient, "pending" as const]),
      ),
      createdAt: now().toISOString(),
    };
    await writeJsonAtomic(dispatchPath, status);
  }

  for (const recipient of recipients) {
    if (status.recipients[recipient] === "enqueued") continue;
    const pendingDir = join(
      stateRoot,
      "instances",
      recipient,
      "job-handoffs",
      "pending",
    );
    try {
      await mkdir(pendingDir, { recursive: true, mode: 0o700 });
      const handoff: JobHandoffFile = {
        version: 1,
        dispatchId,
        jobId,
        target: recipient,
        prompt,
        createdAt: status.createdAt,
      };
      try {
        await writeFile(
          join(pendingDir, `${dispatchId}.json`),
          `${JSON.stringify(handoff, null, 2)}\n`,
          { flag: "wx", mode: 0o600 },
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      status.recipients[recipient] = "enqueued";
      await writeJsonAtomic(dispatchPath, status);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "unknown error";
      throw new Error(`Could not enqueue job handoff for ${recipient} (${code})`, {
        cause: error,
      });
    }
  }

  return { dispatchId, recipients: { ...status.recipients } };
}

function parseHandoff(raw: string): JobHandoffFile | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.dispatchId !== "string" ||
    typeof value.jobId !== "string" ||
    typeof value.target !== "string" ||
    typeof value.prompt !== "string" ||
    value.prompt.trim().length === 0 ||
    Buffer.byteLength(value.prompt, "utf8") > MAX_HANDOFF_PROMPT_BYTES ||
    typeof value.createdAt !== "string"
  ) {
    return undefined;
  }
  return value as unknown as JobHandoffFile;
}

export interface DrainJobHandoffsOptions {
  stateDir: string;
  instanceId: string;
  inject: (prompt: string) => Promise<void>;
}

export interface DrainJobHandoffsResult {
  processed: number;
  failed: number;
  uncertain: number;
}

export async function drainJobHandoffs({
  stateDir,
  instanceId,
  inject,
}: DrainJobHandoffsOptions): Promise<DrainJobHandoffsResult> {
  const root = join(stateDir, "job-handoffs");
  const pendingDir = join(root, "pending");
  const processingDir = join(root, "processing");
  const completedDir = join(root, "completed");
  const failedDir = join(root, "failed");
  for (const path of [pendingDir, processingDir, completedDir, failedDir]) {
    await mkdir(path, { recursive: true, mode: 0o700 });
  }
  const uncertain = (await readdir(processingDir)).filter((name) =>
    name.endsWith(".json"),
  ).length;
  let processed = 0;
  let failed = 0;
  for (const name of (await readdir(pendingDir)).filter((entry) => entry.endsWith(".json")).sort()) {
    const pendingPath = join(pendingDir, name);
    const metadata = await lstat(pendingPath);
    const raw = await readFile(pendingPath, "utf8");
    const handoff = parseHandoff(raw);
    if (
      metadata.isSymbolicLink() ||
      (metadata.mode & 0o777) !== 0o600 ||
      handoff?.target !== instanceId
    ) {
      await rename(pendingPath, join(failedDir, name));
      failed += 1;
      continue;
    }
    const processingPath = join(processingDir, name);
    await rename(pendingPath, processingPath);
    try {
      await inject(handoff.prompt);
      await rename(processingPath, join(completedDir, name));
      processed += 1;
    } catch {
      await rename(processingPath, pendingPath);
      failed += 1;
    }
  }
  return { processed, failed, uncertain };
}
