import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { managePriceWatch } from "../src/price-watches.js";
import { jobsContentHash } from "../src/jobs.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const watch = { source: { kind: "shopify", url: "https://shop.example.com/products/sample", id: "123", currency: "USD" }, baselineCents: "5000",
  createdAt: "2026-01-01T12:00:00Z", endCondition: "Purchase or cancellation", baselineEvidence: "Synthetic verified normal price",
  job: { target: "isaac", schedule: "0,5 9 * * *", rule: { type: "condition", operator: "less-than", target: 8001, for: "1s", notify: "once-per-episode" }, onTrigger: { type: "prompt", prompt: "Verify before alert" } } };
it("stores task data under temporary, projects generic arguments, and preserves pending retirement", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "price-watch-")); roots.push(stateDir);
  const options = { stateDir, validateReload: false };
  const result = await managePriceWatch({ operation: "upsert", id: "sample", watch }, options);
  expect(result).toMatchObject({ ok: true, publication: { status: "pending" } });
  const path = join(stateDir, "temporary/price-watches/sample/watch.json");
  expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ endCondition: watch.endCondition, source: watch.source });
  const jobs = JSON.parse(await readFile(join(stateDir, "jobs.json"), "utf8"));
  expect(jobs.jobs[0].checker.id).toBe("retail-product-price");
  expect(JSON.parse(jobs.jobs[0].checker.args.source)).toEqual(watch.source);
  expect(await managePriceWatch({ operation: "retire", id: "sample" }, options)).toMatchObject({ retired: false });
  expect(await readFile(path, "utf8")).toBeTruthy();
  expect(await managePriceWatch({ operation: "retire", id: "sample" }, options)).toMatchObject({ retired: false });
  // Only acknowledgement that the host loaded the removal permits retirement.
  await writeFile(join(stateDir, "jobs-state.json"), JSON.stringify({ acceptedHash: jobsContentHash(await readFile(join(stateDir, "jobs.json"), "utf8")) }));
  expect(await managePriceWatch({ operation: "retire", id: "sample" }, options)).toMatchObject({ retired: true });
  expect(await readdir(join(stateDir, "temporary/price-watches/retired"))).toHaveLength(1);
});
it("requires explicit lifecycle and rejects traversal before creating jobs", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "price-watch-")); roots.push(stateDir);
  const options = { stateDir, validateReload: false };
  await expect(managePriceWatch({ operation: "upsert", id: "../escape", watch }, options)).rejects.toThrow();
  await expect(managePriceWatch({ operation: "upsert", id: "sample", watch: { ...watch, endCondition: "" } }, options)).rejects.toThrow();
  await expect(readFile(join(stateDir, "jobs.json"), "utf8")).rejects.toThrow();
});
