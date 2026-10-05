import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { applyJobsRequest, resolveCoordinatorStateDir, type ApplyJobsRequestOptions } from "./jobs-cli.js";
import { jobsContentHash, parseJobsFile } from "./jobs.js";
import { parseRetailArgs } from "./checkers/retail-product-price.js";
import { withMutationLock } from "../.pi/lib/mutation-lock.mjs";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected object");
  return value as Record<string, unknown>;
}
export async function managePriceWatch(request: Record<string, unknown>, options: ApplyJobsRequestOptions = {}) {
  const stateDir = options.stateDir ?? await resolveCoordinatorStateDir(options.env);
  if (typeof request.id !== "string" || !/^[a-z0-9-]{1,64}$/.test(request.id) || request.id === "retired") throw new Error("Invalid watch ID");
  const root = join(stateDir, "temporary", "price-watches");
  const directory = join(root, request.id);
  const manifestPath = join(directory, "watch.json");
  await mkdir(root, { recursive: true, mode: 0o700 });
  return withMutationLock(join(root, ".mutation-lock.sqlite"), async () => {
    if (request.operation === "read") return { ok: true, watch: JSON.parse(await readFile(manifestPath, "utf8")) };
    if (request.operation === "retire") {
      // Read before removing a job: only a managed watch may be retired here.
      const watch = object(JSON.parse(await readFile(manifestPath, "utf8")));
      const jobs = await applyJobsRequest({ operation: "list" }, { ...options, stateDir });
      const exists = (jobs.jobs as Array<{ id: string }>).some(job => job.id === request.id);
      const removal = exists ? await applyJobsRequest({ operation: "remove", id: request.id }, { ...options, stateDir }) : { ok: true };
      // Keep the active manifest on an unacknowledged removal so retirement can be retried.
      if (exists && (removal.publication as { status?: string })?.status !== "accepted") return { ...removal, retired: false };
      if (!exists) {
        const raw = await readFile(join(stateDir, "jobs.json"), "utf8");
        const state = object(JSON.parse(await readFile(join(stateDir, "jobs-state.json"), "utf8").catch(() => "{}")));
        if (state.lastLoadError || state.acceptedHash !== jobsContentHash(raw)) return { ...removal, retired: false };
      }
      await writeFile(manifestPath, JSON.stringify({ ...watch, retiredAt: new Date().toISOString() }, null, 2) + "\n", { mode: 0o600 });
      await mkdir(join(root, "retired"), { recursive: true, mode: 0o700 });
      await rename(directory, join(root, "retired", `${request.id}-${randomUUID()}`));
      return { ...removal, retired: true };
    }
    if (request.operation !== "upsert") throw new Error("Use upsert, read, or retire");
    const watch = object(request.watch);
    if (Object.keys(watch).some(key => !["source", "baselineCents", "mode", "createdAt", "endCondition", "baselineEvidence", "job"].includes(key))) throw new Error("Unknown watch field");
    for (const key of ["endCondition", "baselineEvidence", "createdAt"]) {
      if (typeof watch[key] !== "string" || !String(watch[key]).trim() || String(watch[key]).length > 2000) throw new Error(`Missing ${key}`);
    }
    if (!Number.isFinite(Date.parse(String(watch.createdAt)))) throw new Error("Invalid creation date");
    const args = { source: JSON.stringify(watch.source), baselineCents: watch.baselineCents, mode: watch.mode ?? "ratio" };
    parseRetailArgs(JSON.stringify(args));
    const job = { ...object(watch.job), id: request.id, type: "heartbeat", checker: { id: "retail-product-price", args } };
    const rule = object((job as Record<string, unknown>).rule);
    if (rule.type !== "condition" || rule.operator !== "less-than" || typeof rule.target !== "number" ||
        rule.target <= 0 || rule.target > 1_000_000_000_000) throw new Error("Price watches require a bounded less-than condition");
    parseJobsFile(JSON.stringify({ version: 3, jobs: [job] }));
    // The manifest is the editable task; jobs.json is the scheduler's projection.
    // A prepared manifest without accepted publication is explicitly not active.
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const publishManifest = async (publication: unknown) => {
      const temp = join(directory, `${randomUUID()}.tmp`);
      await writeFile(temp, JSON.stringify({ version: 1, ...watch, job, publication }, null, 2) + "\n", { mode: 0o600 });
      await rename(temp, manifestPath);
    };
    await publishManifest({ status: "prepared" });
    const result = await applyJobsRequest({ operation: "upsert", job }, { ...options, stateDir });
    await publishManifest(result.publication);
    return { ...result, manifestPath };
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    let input = "";
    for await (const chunk of process.stdin) {
      input += chunk;
      if (Buffer.byteLength(input) > 32_000) throw new Error("Request too large");
    }
    const result = await managePriceWatch(object(JSON.parse(input)));
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "Price watch operation failed" }) + "\n");
    process.exitCode = 1;
  }
}
