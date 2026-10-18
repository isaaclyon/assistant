import { createHash } from "node:crypto";
import { closeSync, lstatSync, openSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  cancelJobHandoff,
  enqueueJobHandoff,
  MAX_HANDOFF_FILE_BYTES,
} from "../job-handoff.js";
import {
  type JobDefinition,
  type JobDispatch,
  type JobScheduler,
  type JobsLogger,
  startJobScheduler,
} from "../jobs.js";

export type NativeCoordinatorConfig = {
  stateRoot: string;
  coordinatorStateDir: string;
  targets: string[];
  scope: "self" | "shared-owner";
};

export interface NativeJobsCoordinator {
  tick(): Promise<void>;
  reload(): Promise<void>;
  stop(): Promise<void>;
  getJobs(): readonly JobDefinition[];
}

export interface NativeJobsCoordinatorOptions {
  logger: JobsLogger;
  nowMs?: () => number;
  tickIntervalMs?: number;
  publication?: {
    enqueue: typeof enqueueJobHandoff;
    cancel: typeof cancelJobHandoff;
  };
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SUPPORTED_TYPES: ReadonlySet<JobDefinition["type"]> = new Set(["cron", "at"]);
const HANDOFF_STATES = ["pending", "processing", "completed", "acknowledged", "failed", "cancelled"];
const LEASE_FILE = "native-jobs-coordinator.lock.db";

function ownedByUs(uid: number): boolean {
  return process.getuid === undefined || uid === process.getuid();
}

function statOrUndefined(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function assertPrivateDirectory(path: string, label: string): void {
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || (metadata.mode & 0o777) !== 0o700 || !ownedByUs(metadata.uid)) {
    throw new Error(`Native coordinator requires ${label} to be a private, owned directory`);
  }
}

function assertPrivateFile(path: string, label: string, maxBytes = Number.MAX_SAFE_INTEGER): void {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.nlink !== 1 || (metadata.mode & 0o777) !== 0o600 ||
      !ownedByUs(metadata.uid) || metadata.size > maxBytes) {
    throw new Error(`Native coordinator requires ${label} to be a private, owned regular file`);
  }
}

function assertOptionalPrivateDirectory(path: string, label: string): boolean {
  if (statOrUndefined(path) === undefined) return false;
  assertPrivateDirectory(path, label);
  return true;
}

function assertOptionalPrivateFile(path: string, label: string, maxBytes?: number): void {
  if (statOrUndefined(path) !== undefined) assertPrivateFile(path, label, maxBytes);
}

function validateTargets(scope: string, instanceId: string, targets: readonly string[]): void {
  if (scope !== "self" && scope !== "shared-owner") throw new Error("Invalid native coordinator scope");
  if (!Array.isArray(targets) || targets.length === 0 || targets.length > 64) {
    throw new Error("Native coordinator requires explicit targets");
  }
  for (const target of targets) {
    if (typeof target !== "string" || !ID_PATTERN.test(target) || target === "both-personal") {
      throw new Error("Native coordinator targets must be stable instance IDs");
    }
  }
  if (new Set(targets).size !== targets.length) throw new Error("Native coordinator targets must be unique");
  if (scope === "self" && (targets.length !== 1 || targets[0] !== instanceId)) {
    throw new Error("Self-scoped native coordinator targets must be exactly its own instance");
  }
}

function recipientsFor(target: string | undefined, allowed: ReadonlySet<string>): string[] {
  if (target === undefined || !ID_PATTERN.test(target)) throw new Error("Job target is required");
  const recipients = target === "both-personal" ? ["isaac", "emma"] : [target];
  for (const recipient of recipients) {
    if (!allowed.has(recipient)) throw new Error("Job target is outside this coordinator's authority");
  }
  return recipients;
}

/** Fails closed on any recipient path this process does not fully own. */
function validateRecipientTree(stateRoot: string, recipient: string, dispatchId: string): void {
  if (!ID_PATTERN.test(recipient)) throw new Error("Invalid recipient ID");
  assertPrivateDirectory(stateRoot, "state root");
  assertPrivateDirectory(join(stateRoot, "instances"), "instances directory");
  assertPrivateDirectory(join(stateRoot, "instances", recipient), `recipient ${recipient} directory`);
  const root = join(stateRoot, "instances", recipient, "job-handoffs");
  if (!assertOptionalPrivateDirectory(root, "handoff root")) return;
  assertOptionalPrivateFile(join(root, ".transition-lock.sqlite"), "handoff transition lock");
  for (const state of HANDOFF_STATES) {
    const directory = join(root, state);
    if (!assertOptionalPrivateDirectory(directory, `handoff ${state} directory`)) continue;
    assertOptionalPrivateFile(
      join(directory, `${dispatchId}.json`),
      `handoff ${state} file`,
      MAX_HANDOFF_FILE_BYTES,
    );
  }
}

function validateDispatchStatus(coordinatorStateDir: string, dispatchId: string): void {
  assertPrivateDirectory(coordinatorStateDir, "coordinator state directory");
  const directory = join(coordinatorStateDir, "job-dispatches");
  if (!assertOptionalPrivateDirectory(directory, "dispatch status directory")) return;
  assertOptionalPrivateFile(join(directory, `${dispatchId}.json`), "dispatch status file", 64 * 1024);
}

/** An OS-released SQLite lock: a killed process never leaves a stale lease. */
function acquireLease(coordinatorStateDir: string): DatabaseSync {
  const path = join(coordinatorStateDir, LEASE_FILE);
  try {
    closeSync(openSync(path, "wx", 0o600));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  assertPrivateFile(path, "coordinator lease");
  const lease = new DatabaseSync(path, { timeout: 0 });
  try {
    lease.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
  } catch (error) {
    lease.close();
    throw new Error("Another native jobs coordinator holds this coordinator state", { cause: error });
  }
  return lease;
}

function validateOccurrenceIdentity(dispatch: JobDispatch): void {
  if (typeof dispatch.jobId !== "string" || !/^[a-z0-9-]{1,64}$/.test(dispatch.jobId) ||
      typeof dispatch.definitionFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(dispatch.definitionFingerprint) ||
      typeof dispatch.eventId !== "string" || dispatch.eventId.length === 0 || dispatch.eventId.length > 1024 ||
      typeof dispatch.occurrenceId !== "string" || dispatch.occurrenceId !== expectedDispatchId(dispatch)) {
    throw new Error("Job occurrence identity is incomplete");
  }
}

function expectedDispatchId(dispatch: JobDispatch): string {
  return `${dispatch.jobId}-${createHash("sha256")
    .update(JSON.stringify([dispatch.jobId, dispatch.definitionFingerprint, dispatch.eventId]))
    .digest("hex")}`;
}

export async function startNativeJobsCoordinator(
  config: { instanceId: string; stateDir: string; coordinator: NativeCoordinatorConfig },
  options: NativeJobsCoordinatorOptions,
): Promise<NativeJobsCoordinator> {
  const { instanceId } = config;
  const { scope, targets } = config.coordinator;
  const stateRoot = resolve(config.coordinator.stateRoot);
  const coordinatorStateDir = resolve(config.coordinator.coordinatorStateDir);
  const stateDir = resolve(config.stateDir);
  if (typeof instanceId !== "string" || !ID_PATTERN.test(instanceId)) {
    throw new Error("Invalid native coordinator instance ID");
  }
  validateTargets(scope, instanceId, targets);
  if (stateDir !== join(stateRoot, "instances", instanceId)) {
    throw new Error("Native coordinator state directory must be stateRoot/instances/<instanceId>");
  }
  const allowed: ReadonlySet<string> = new Set(targets);
  // The ledger refuses a legacy-looking directory; keeping dispatch status
  // elsewhere also keeps handoff bookkeeping out of every recipient tree.
  const contains = (parent: string, child: string): boolean => {
    const path = relative(parent, child);
    return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !path.startsWith(sep));
  };
  const instancesDir = join(stateRoot, "instances");
  if (contains(instancesDir, coordinatorStateDir) || contains(coordinatorStateDir, instancesDir)) {
    throw new Error("Coordinator state must be distinct from recipient state trees");
  }
  assertPrivateDirectory(stateRoot, "state root");
  assertPrivateDirectory(join(stateRoot, "instances"), "instances directory");
  assertPrivateDirectory(stateDir, "own state directory");
  assertPrivateDirectory(coordinatorStateDir, "coordinator state directory");

  const publication = options.publication ?? { enqueue: enqueueJobHandoff, cancel: cancelJobHandoff };

  const inject = async (prompt: string, dispatch?: JobDispatch): Promise<void> => {
    if (!dispatch || !SUPPORTED_TYPES.has(dispatch.jobType)) {
      throw new Error("Native coordinator does not publish this job type");
    }
    validateOccurrenceIdentity(dispatch);
    const { createdAt } = dispatch;
    const definitionFingerprint = dispatch.definitionFingerprint!, eventId = dispatch.eventId!, occurrenceId = dispatch.occurrenceId!;
    if (typeof createdAt !== "number" || !Number.isSafeInteger(createdAt) || createdAt < 0 ||
        Number.isNaN(new Date(createdAt).getTime())) {
      throw new Error("Job occurrence identity is incomplete");
    }
    const recipients = recipientsFor(dispatch.target, allowed);
    validateDispatchStatus(coordinatorStateDir, occurrenceId);
    for (const recipient of recipients) validateRecipientTree(stateRoot, recipient, occurrenceId);
    const result = await publication.enqueue({
      stateRoot,
      coordinatorStateDir,
      eventId,
      definitionFingerprint,
      jobId: dispatch.jobId,
      jobType: dispatch.jobType,
      target: dispatch.target!,
      prompt,
      now: () => new Date(createdAt),
    });
    if (result.dispatchId !== occurrenceId) throw new Error("Handoff dispatch identity mismatch");
    for (const recipient of recipients) {
      if (result.recipients[recipient] !== "enqueued") {
        throw new Error("Handoff was not published to every recipient");
      }
    }
  };

  const cancel = async (dispatch: JobDispatch): Promise<void> => {
    validateOccurrenceIdentity(dispatch);
    const occurrenceId = dispatch.occurrenceId!;
    const recipients = recipientsFor(dispatch.target, allowed);
    validateDispatchStatus(coordinatorStateDir, occurrenceId);
    for (const recipient of recipients) validateRecipientTree(stateRoot, recipient, occurrenceId);
    await publication.cancel({
      stateRoot,
      coordinatorStateDir,
      dispatchId: occurrenceId,
      jobId: dispatch.jobId,
      target: dispatch.target!,
    });
  };

  const lease = acquireLease(coordinatorStateDir);
  let scheduler: JobScheduler;
  try {
    scheduler = await startJobScheduler({
      stateDir: coordinatorStateDir,
      webhookHost: "127.0.0.1",
      webhookPort: 0,
      inject,
      cancel,
      logger: options.logger,
      validTargets: allowed,
      requireTargets: true,
      allowedTypes: SUPPORTED_TYPES,
      ...(options.nowMs === undefined ? {} : { nowMs: options.nowMs }),
      ...(options.tickIntervalMs === undefined ? {} : { tickIntervalMs: options.tickIntervalMs }),
      // Checker and judge work is outside this coordinator slice.
      runCheck: async () => { throw new Error("Checkers are not supported by the native coordinator"); },
      judge: async () => { throw new Error("Judges are not supported by the native coordinator"); },
    });
  } catch (error) {
    lease.close();
    throw error;
  }

  let stopping: Promise<void> | undefined;
  return {
    tick: () => scheduler.tick(),
    reload: () => scheduler.reload(),
    getJobs: () => scheduler.getJobs(),
    stop: () => {
      // A failed stop keeps the lease so no second writer can start beside a
      // scheduler that may still be running; a retry may complete it.
      stopping ??= scheduler.stop().then(() => { if (lease.isOpen) lease.close(); }, (error) => {
        stopping = undefined;
        throw error;
      });
      return stopping;
    },
  };
}
