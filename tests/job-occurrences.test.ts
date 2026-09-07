import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openJobOccurrenceLedger, definitionFingerprint, type JobOccurrenceLedger } from "../src/job-occurrences.js";
import type { AtJob } from "../src/jobs.js";

const ledgers: JobOccurrenceLedger[] = [];
afterEach(() => { for (const ledger of ledgers.splice(0)) ledger.close(); });
const job: AtJob = { id: "synthetic", type: "at", at: "2026-07-25T12:00:00Z", prompt: "Synthetic reminder", target: "isaac" };

describe("durable occurrence ledger", () => {
  it("resumes materialized work after reopen and retains a published tombstone", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "occurrence-ledger-"));
    let ledger = openJobOccurrenceLedger(stateDir);
    ledger.reconcileDefinitions([job], {});
    const first = ledger.materialize(job, "at:synthetic:1", "Rendered prompt", 1);
    ledger.close();
    ledger = openJobOccurrenceLedger(stateDir);
    ledgers.push(ledger);
    expect(ledger.pending()).toEqual([first]);
    expect(ledger.materialize(job, "at:synthetic:1", "Rendered prompt", 99)).toEqual(first);
    ledger.markPublished(first.id);
    expect(ledger.pending()).toEqual([]);
    expect(ledger.materialize(job, "at:synthetic:1", "Rendered prompt", 100).status).toBe("published");
    expect(ledger.oneShotPublished(job)).toBe(true);
  });

  it("includes normalized definitions in identity and supersedes old work on edits and deletion", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "occurrence-definition-"));
    const ledger = openJobOccurrenceLedger(stateDir);
    ledgers.push(ledger);
    ledger.reconcileDefinitions([job], {});
    const old = ledger.materialize(job, "at:synthetic:1", "Old prompt", 1);
    ledger.markPublished(old.id);
    const changed = { ...job, prompt: "New reminder" };
    expect(ledger.reconcileDefinitions([changed], {})).toContain(job.id);
    const next = ledger.materialize(changed, "at:synthetic:1", "New prompt", 2);
    expect(next.id).not.toBe(old.id);
    expect(ledger.superseded().map((entry) => entry.id)).toEqual([old.id]);
    expect(ledger.oneShotPublished(changed)).toBe(false);
    ledger.reconcileDefinitions([], {});
    expect(ledger.pending()).toEqual([]);
    expect(ledger.superseded()).toHaveLength(2);
    expect(() => ledger.materialize(changed, "new", "New prompt", 3)).toThrow(/current/);
  });

  it("imports legacy fired state only once, not after a definition changes", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "occurrence-legacy-"));
    const ledger = openJobOccurrenceLedger(stateDir);
    ledgers.push(ledger);
    ledger.reconcileDefinitions([job], { synthetic: 1 });
    expect(ledger.oneShotPublished(job)).toBe(true);
    const changed = { ...job, prompt: "Changed" };
    ledger.reconcileDefinitions([changed], { synthetic: 1 });
    expect(ledger.oneShotPublished(changed)).toBe(false);
  });

  it("normalizes property order and timestamps without storing credential text", () => {
    expect(definitionFingerprint(job)).toBe(definitionFingerprint({
      prompt: job.prompt, target: "isaac", id: job.id, type: "at", at: "2026-07-25T12:00:00.000Z",
    }));
    const fingerprint = definitionFingerprint({ id: "hook", type: "webhook", prompt: "Synthetic", hmacSecret: "private-value" });
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects conflicting payload reuse of an occurrence identity", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "occurrence-collision-"));
    const ledger = openJobOccurrenceLedger(stateDir);
    ledgers.push(ledger);
    ledger.reconcileDefinitions([job], {});
    ledger.materialize(job, "event", "First", 1);
    expect(() => ledger.materialize(job, "event", "Different", 2)).toThrow(/collision/);
  });
});
