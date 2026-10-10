import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHeartbeatRunner, parseHeartbeatFields, type StatefulHeartbeatDefinition } from "../src/heartbeat.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const job: StatefulHeartbeatDefinition = {
  id: "inbox", checker: { id: "gmail-inbox", mode: "incremental", args: { account: "personal", timeZone: "UTC" } },
  rule: { type: "semantic-match", question: "Does {item} need action?", criteria: { true: "Action needed", false: "No action" }, notifyAt: 0.5 },
  onTrigger: { type: "prompt", prompt: "Review; use NO_REPLY to veto." },
};
function observation(since: number, ...ids: string[]) {
  return { ok: true, stdout: JSON.stringify({ version: 2, value: { items: ids.map((id) => ({ id, body: "x".repeat(5000) })) }, cursor: { since } }) };
}
async function setup() {
  const stateDir = await mkdtemp(join(tmpdir(), "heartbeat-stream-"));
  directories.push(stateDir);
  const runCheck = vi.fn().mockResolvedValue(observation(1));
  const judge = vi.fn().mockResolvedValue({ model: "synthetic", probabilities: { item_0: 0.8 } });
  const inject = vi.fn();
  const logger = { info: vi.fn(), error: vi.fn() };
  const options = { stateDir, runCheck, inject, judge, logger, nowMs: () => 1000, checkTimeoutMs: 1000 };
  const run = () => createHeartbeatRunner(options).run(job, async () => true);
  const state = async () => JSON.parse(await readFile(join(stateDir, "checkers/inbox.json"), "utf8"));
  return { run, runCheck, judge, inject, state, logger };
}

describe("incremental heartbeat commits", () => {
  it("passes the persisted cursor after restart, retries judge failures, and commits successful negatives", async () => {
    const h = await setup();
    await h.run();
    expect(h.runCheck).toHaveBeenLastCalledWith("gmail-inbox", 1000, job.checker.args, null);
    h.runCheck.mockResolvedValue(observation(2, "a"));
    h.judge.mockRejectedValueOnce(new Error("offline"));
    await h.run();
    expect((await h.state()).lastObservation.cursor).toEqual({ since: 1 });
    h.judge.mockResolvedValue({ model: "synthetic", probabilities: { item_0: 0.1 } });
    await h.run();
    expect(h.runCheck).toHaveBeenLastCalledWith("gmail-inbox", 1000, job.checker.args, { since: 1 });
    expect((await h.state()).lastObservation.cursor).toEqual({ since: 2 });
    expect(h.inject).not.toHaveBeenCalled();
  });

  it("persists matches with the cursor, then retries pending delivery before fetching more mail", async () => {
    const h = await setup();
    await h.run();
    h.runCheck.mockResolvedValue(observation(2, "a"));
    h.inject.mockRejectedValueOnce(new Error("unavailable"));
    await h.run();
    expect((await h.state()).pendingEvent.matches[0].item.id).toBe("a");
    expect((await h.state()).lastObservation.cursor).toEqual({ since: 2 });
    await h.run();
    expect(h.runCheck).toHaveBeenCalledTimes(2);
    expect(h.judge).toHaveBeenCalledTimes(1);
    expect(h.inject).toHaveBeenCalledTimes(2);
    expect((await h.state()).pendingEvent).toBeNull();
  });

  it("rejects nonempty initial baselines and invalid cursors without advancing", async () => {
    const h = await setup();
    h.runCheck.mockResolvedValueOnce(observation(1, "old"));
    await h.run();
    expect((await h.state()).lastObservation).toBeNull();
    await h.run();
    h.runCheck.mockResolvedValue({ ok: true, stdout: JSON.stringify({ version: 2, value: { items: [] }, cursor: "bad" }) });
    await h.run();
    expect((await h.state()).lastObservation.cursor).toEqual({ since: 1 });
    expect(h.judge).not.toHaveBeenCalled();
  });

  it("requires explicit incremental mode with semantic-match", () => {
    const errors: string[] = [];
    expect(parseHeartbeatFields({ ...job }, "test", errors)?.checker.mode).toBe("incremental");
    expect(errors).toEqual([]);
    expect(parseHeartbeatFields({ ...job, rule: { type: "changed" } }, "test", errors)).toBeUndefined();
    expect(errors.join(" ")).toContain("requires semantic-match");
  });

  it("keeps the cursor when matching content cannot fit a recipient handoff", async () => {
    const h = await setup();
    await h.run();
    const ids = Array.from({ length: 8 }, (_, index) => String(index));
    h.runCheck.mockResolvedValue(observation(2, ...ids));
    h.judge.mockResolvedValue({ model: "synthetic", probabilities: Object.fromEntries(ids.map((id) => [`item_${id}`, 0.9])) });
    await h.run();
    expect((await h.state()).lastObservation.cursor).toEqual({ since: 1 });
    expect(h.inject).not.toHaveBeenCalled();
    expect(h.logger.error).toHaveBeenCalledWith(expect.stringContaining("32 KB handoff limit"));
  });
});
