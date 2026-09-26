import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { withMutationLock } from "../.pi/lib/mutation-lock.mjs";

const MAX_HANDOFF_PROMPT_BYTES = 32 * 1024;

interface JobHandoffFile {
  version: 1;
  dispatchId: string;
  jobId: string;
  jobType?: "cron" | "at" | "heartbeat" | "webhook";
  target: string;
  prompt: string;
  createdAt: string;
  attempts?: number;
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
  definitionFingerprint?: string;
  local?: boolean;
  jobId: string;
  jobType?: JobHandoffFile["jobType"];
  target: string;
  prompt: string;
  now?: () => Date;
}

export interface JobHandoffLocation {
  stateRoot: string;
  coordinatorStateDir: string;
  local: boolean;
  target: string;
}

/**
 * Resolves where a dispatch's handoffs live. A singleton host delivers to its
 * own state directory under the fixed "local" target; a fleet host delivers to
 * each recipient's instance tree under the shared state root.
 */
export function jobHandoffLocation(
  host: { stateDir: string } | { stateDir: string; stateRoot: string; instanceId: string },
  target: string | undefined,
): JobHandoffLocation {
  if (!("instanceId" in host)) {
    return { stateRoot: host.stateDir, coordinatorStateDir: host.stateDir, local: true, target: "local" };
  }
  if (!target) throw new Error("Fleet job target is required");
  return { stateRoot: host.stateRoot, coordinatorStateDir: host.stateDir, local: false, target };
}

function handoffRecipients(target: string): string[] {
  return target === "both-personal" ? ["isaac", "emma"] : [target];
}

function recipientHandoffRoot(
  location: { stateRoot: string; coordinatorStateDir: string; local?: boolean },
  recipient: string,
): string {
  const recipientStateDir = location.local
    ? location.coordinatorStateDir
    : join(location.stateRoot, "instances", recipient);
  return join(recipientStateDir, "job-handoffs");
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
  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, path);
    await syncDirectory(dirname(path));
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function moveHandoff(from: string, to: string): Promise<void> {
  await rename(from, to);
  await syncDirectory(dirname(to));
  await syncDirectory(dirname(from));
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
  definitionFingerprint,
  local = false,
  jobId,
  jobType,
  target,
  prompt,
  now = () => new Date(),
}: EnqueueJobHandoffOptions): Promise<EnqueueJobHandoffResult> {
  if (!/^[a-z0-9-]{1,64}$/.test(jobId)) throw new Error("Invalid handoff job ID");
  if (!/^[a-z0-9-]{1,64}$/.test(target)) throw new Error("Invalid handoff target");
  if (local && target !== "local") throw new Error("Invalid local handoff target");
  if (definitionFingerprint !== undefined && !/^[a-f0-9]{64}$/.test(definitionFingerprint)) {
    throw new Error("Invalid handoff definition fingerprint");
  }
  if (
    prompt.trim().length === 0 ||
    Buffer.byteLength(prompt, "utf8") > MAX_HANDOFF_PROMPT_BYTES
  ) {
    throw new Error("Job handoff prompt must be non-empty and at most 32 KB");
  }
  const recipients = handoffRecipients(target);
  const eventHash = createHash("sha256").update(eventId).digest("hex");
  const dispatchId = definitionFingerprint === undefined ? `${jobId}-${eventHash.slice(0, 16)}`
    : `${jobId}-${createHash("sha256").update(JSON.stringify([jobId, definitionFingerprint, eventId])).digest("hex")}`;
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
    const recipientRoot = recipientHandoffRoot({ stateRoot, coordinatorStateDir, local }, recipient);
    const pendingDir = join(recipientRoot, "pending");
    try {
      await mkdir(pendingDir, { recursive: true, mode: 0o700 });
      const handoff: JobHandoffFile = {
        version: 1,
        dispatchId,
        jobId,
        ...(jobType === undefined ? {} : { jobType }),
        target: recipient,
        prompt,
        createdAt: status.createdAt,
      };
      await withMutationLock(join(recipientRoot, ".transition-lock.sqlite"), async () => {
        // Recipient evidence may be ahead of coordinator state. Never recreate
        // pending work after a claim, acceptance, or terminal rejection.
        for (const directory of ["completed", "acknowledged", "processing", "failed", "cancelled", "pending"]) {
          const existingPath = join(recipientRoot, directory, `${dispatchId}.json`);
          try {
            await lstat(existingPath);
            return;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
        await writeJsonAtomic(join(pendingDir, `${dispatchId}.json`), handoff);
      });
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

export async function cancelJobHandoff(options: {
  stateRoot: string;
  coordinatorStateDir: string;
  local?: boolean;
  dispatchId: string;
  jobId: string;
  target: string;
}): Promise<Record<string, "cancelled" | "completed" | "acknowledged" | "processing" | "failed">> {
  if (!/^[a-z0-9-]{1,64}$/.test(options.jobId) || !/^[a-z0-9-]{1,64}$/.test(options.target) ||
      !new RegExp(`^${options.jobId}-[a-f0-9]{16}(?:[a-f0-9]{48})?$`).test(options.dispatchId) ||
      (options.local && options.target !== "local")) {
    throw new Error("Invalid cancellation identity");
  }
  const result: Record<string, "cancelled" | "completed" | "acknowledged" | "processing" | "failed"> = {};
  for (const recipient of handoffRecipients(options.target)) {
    const root = recipientHandoffRoot(options, recipient);
    await mkdir(root, { recursive: true, mode: 0o700 });
    result[recipient] = await withMutationLock(join(root, ".transition-lock.sqlite"), async () => {
      const name = `${options.dispatchId}.json`;
      for (const state of ["completed", "acknowledged", "processing", "failed", "cancelled"] as const) {
        try { await lstat(join(root, state, name)); return state; } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      const cancelledDir = join(root, "cancelled");
      await mkdir(cancelledDir, { recursive: true, mode: 0o700 });
      try {
        await moveHandoff(join(root, "pending", name), join(cancelledDir, name));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await writeJsonAtomic(join(cancelledDir, name), {
          version: 1, dispatchId: options.dispatchId, jobId: options.jobId, target: recipient,
        });
      }
      return "cancelled";
    });
  }
  return result;
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
    (value.jobType !== undefined &&
      !["cron", "at", "heartbeat", "webhook"].includes(String(value.jobType))) ||
    typeof value.target !== "string" ||
    typeof value.prompt !== "string" ||
    value.prompt.trim().length === 0 ||
    Buffer.byteLength(value.prompt, "utf8") > MAX_HANDOFF_PROMPT_BYTES ||
    typeof value.createdAt !== "string"
    || (value.attempts !== undefined &&
      (!Number.isSafeInteger(value.attempts) || Number(value.attempts) < 0 || Number(value.attempts) > 5))
  ) {
    return undefined;
  }
  return value as unknown as JobHandoffFile;
}

export interface DrainJobHandoffsOptions {
  stateDir: string;
  instanceId: string;
  signal?: AbortSignal;
  inject: (
    prompt: string,
    jobType: JobHandoffFile["jobType"],
    preflightResult: (accepted: boolean) => void,
  ) => Promise<void>;
}

export interface DrainJobHandoffsResult {
  processed: number;
  failed: number;
  uncertain: number;
}

export async function drainJobHandoffs(options: DrainJobHandoffsOptions): Promise<DrainJobHandoffsResult> {
  const root = join(options.stateDir, "job-handoffs");
  await mkdir(root, { recursive: true, mode: 0o700 });
  // Recovery must not mistake a currently invoking recipient for an orphan.
  return withMutationLock(join(root, ".drain-lock.sqlite"), () => doDrainJobHandoffs(options));
}

async function doDrainJobHandoffs({
  stateDir,
  instanceId,
  inject,
  signal,
}: DrainJobHandoffsOptions): Promise<DrainJobHandoffsResult> {
  const root = join(stateDir, "job-handoffs");
  const pendingDir = join(root, "pending");
  const processingDir = join(root, "processing");
  const completedDir = join(root, "completed");
  const failedDir = join(root, "failed");
  for (const path of [pendingDir, processingDir, completedDir, failedDir]) {
    await mkdir(path, { recursive: true, mode: 0o700 });
  }
  let uncertain = (await readdir(processingDir)).filter((name) =>
    name.endsWith(".json"),
  ).length;
  let processed = 0;
  let failed = 0;
  for (const name of (await readdir(pendingDir)).filter((entry) => entry.endsWith(".json")).sort()) {
    if (signal?.aborted) break;
    const pendingPath = join(pendingDir, name);
    const processingPath = join(processingDir, name);
    const handoff = await withMutationLock(join(root, ".transition-lock.sqlite"), async () => {
      let metadata;
      try { metadata = await lstat(pendingPath); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
      let parsed: JobHandoffFile | undefined;
      if (metadata.isFile() && (metadata.mode & 0o777) === 0o600 &&
          metadata.uid === process.getuid?.() && metadata.size <= MAX_HANDOFF_PROMPT_BYTES + 4096) {
        const handle = await open(pendingPath, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const bytes = Buffer.alloc(MAX_HANDOFF_PROMPT_BYTES + 4097);
          const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
          parsed = parseHandoff(bytes.subarray(0, bytesRead).toString("utf8"));
        } finally { await handle.close(); }
      }
      if (parsed?.target !== instanceId || name !== `${parsed.dispatchId}.json` || (parsed.attempts ?? 0) >= 5) {
        await moveHandoff(pendingPath, join(failedDir, name));
        failed += 1;
        return undefined;
      }
      const claimed = { ...parsed, attempts: (parsed.attempts ?? 0) + 1 };
      await writeJsonAtomic(pendingPath, claimed);
      await moveHandoff(pendingPath, processingPath);
      return claimed;
    });
    if (!handoff) continue;
    let preflight: boolean | undefined;
    let acknowledgement: Promise<boolean> | undefined;
    let observed!: () => void;
    const preflightObserved = new Promise<void>((resolve) => { observed = resolve; });
    const observePreflight = (accepted: boolean): void => {
      if (preflight !== undefined) return;
      preflight = accepted;
      // Pi invokes this before the full run settles. Persist both acceptance
      // and known rejection now, independently of the returned run promise.
      const destination = accepted ? join(completedDir, name)
        : handoff.attempts! >= 5 ? join(failedDir, name) : pendingPath;
      acknowledgement = withMutationLock(join(root, ".transition-lock.sqlite"), () =>
        moveHandoff(processingPath, destination)).then(() => true, () => false);
      observed();
    };
    // Keep a handled run continuation, but release the recipient at durable
    // preflight, not at full run completion. Arbitrary exceptions still cannot
    // authorize replay, and shutdown need not wait for a hung accepted run.
    const run = Promise.resolve().then(() => inject(handoff.prompt, handoff.jobType, observePreflight))
      .then(() => {}, () => {});
    await Promise.race([preflightObserved, run]);
    if (await acknowledgement) {
      if (preflight === true) processed += 1;
      else failed += 1;
    } else {
      uncertain += 1;
    }
  }
  return { processed, failed, uncertain };
}

interface UnresolvedHandoff {
  dispatchId: string;
  jobId: string;
  state: "processing" | "failed";
  attempts: number;
  revision: string;
}

async function readRecoveryEvidence(path: string, instanceId: string): Promise<{ handoff: JobHandoffFile; revision: string }> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.nlink !== 1 || (metadata.mode & 0o777) !== 0o600 ||
        (process.getuid && metadata.uid !== process.getuid()) || metadata.size > MAX_HANDOFF_PROMPT_BYTES + 4096) {
      throw new Error("Unsafe handoff recovery evidence");
    }
    const buffer = Buffer.alloc(MAX_HANDOFF_PROMPT_BYTES + 4097);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== metadata.size) throw new Error("Handoff changed during inspection");
    const raw = buffer.subarray(0, bytesRead);
    const handoff = parseHandoff(raw.toString("utf8"));
    if (handoff?.target !== instanceId) throw new Error("Handoff recipient mismatch or malformed evidence");
    return { handoff, revision: createHash("sha256").update(raw).digest("hex") };
  } finally { await handle.close(); }
}

export async function inspectUnresolvedJobHandoffs(options: {
  stateDir: string; instanceId: string; limit?: number;
}): Promise<{ entries: UnresolvedHandoff[]; truncated: boolean }> {
  const limit = options.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid inspection limit");
  const entries: UnresolvedHandoff[] = [];
  for (const state of ["processing", "failed"] as const) {
    const directory = join(options.stateDir, "job-handoffs", state);
    let names: string[];
    try { names = await readdir(directory); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const name of names.filter((name) => /^[a-z0-9-]+\.json$/.test(name)).sort()) {
      if (entries.length >= limit) return { entries, truncated: true };
      const { handoff, revision } = await readRecoveryEvidence(join(directory, name), options.instanceId);
      if (name !== `${handoff.dispatchId}.json`) throw new Error("Handoff filename mismatch");
      entries.push({ dispatchId: handoff.dispatchId, jobId: handoff.jobId, state, attempts: handoff.attempts ?? 0, revision });
    }
  }
  return { entries, truncated: false };
}

export async function recoverJobHandoff(options: {
  stateDir: string; instanceId: string; dispatchId: string;
  state: "processing" | "failed"; revision: string; action: "acknowledge" | "retry";
}): Promise<void> {
  if (!/^[a-z0-9-]{1,129}$/.test(options.dispatchId) || !/^[a-f0-9]{64}$/.test(options.revision) ||
      !["processing", "failed"].includes(options.state) || !["acknowledge", "retry"].includes(options.action)) {
    throw new Error("Invalid recovery request");
  }
  const root = join(options.stateDir, "job-handoffs");
  await withMutationLock(join(root, ".drain-lock.sqlite"), () =>
    withMutationLock(join(root, ".transition-lock.sqlite"), async () => {
      const name = `${options.dispatchId}.json`;
      const source = join(root, options.state, name);
      const { handoff, revision } = await readRecoveryEvidence(source, options.instanceId);
      if (handoff.dispatchId !== options.dispatchId || revision !== options.revision) throw new Error("Handoff changed since inspection");
      for (const state of ["pending", "completed", "acknowledged", "cancelled"]) {
        try {
          await lstat(join(root, state, name));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        throw new Error("Conflicting recipient evidence; inspect before recovery");
      }
      const destination = join(root, options.action === "retry" ? "pending" : "acknowledged");
      await mkdir(destination, { recursive: true, mode: 0o700 });
      if (options.action === "retry") await writeJsonAtomic(source, { ...handoff, attempts: 0 });
      await moveHandoff(source, join(destination, name));
    }));
}
