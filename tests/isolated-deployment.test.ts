import { describe, expect, it } from "vitest";
import { activateIsolatedDeployment, type IsolatedDeploymentOperations } from "../src/isolated-deployment.js";
const order = ["preflight", "hold", "stopAll", "assertQuiescent", "checkpoint", "migrate", "install", "markStarted", "authorize", "start", "ready", "revoke", "enable", "complete"] as const;
function fixture(failure?: string) {
  const calls: string[] = [];
  const ops = Object.fromEntries(order.map(key => [key, async () => { calls.push(key); if (failure === key) throw new Error("synthetic failure"); }])) as unknown as IsolatedDeploymentOperations;
  return { calls, ops };
}
describe("coordinated mixed-manager deployment", () => {
  it("checkpoints stopped writers and persists the barrier before any candidate can start", async () => {
    const f = fixture(); await activateIsolatedDeployment(f.ops);
    expect(f.calls).toEqual(order);
  });
  it("does not interrupt live writers after a read-only preflight failure", async () => {
    const f = fixture("preflight"); await expect(activateIsolatedDeployment(f.ops)).rejects.toThrow();
    expect(f.calls).toEqual(["preflight"]);
  });
  it("revokes startup and stops all writers after an interrupted candidate start", async () => {
    const f = fixture(), controller = new AbortController();
    f.ops.start = async () => { f.calls.push("start"); controller.abort(); };
    await expect(activateIsolatedDeployment(f.ops, controller.signal)).rejects.toThrow("Deployment held");
    expect(f.calls.slice(-3)).toEqual(["revoke", "stopAll", "assertQuiescent"]);
    expect(f.calls).not.toContain("enable");
  });
  it.each(order.slice(1))("holds every writer after %s fails, with no automatic rewind", async phase => {
    const f = fixture(phase); await expect(activateIsolatedDeployment(f.ops)).rejects.toThrow("Deployment held");
    expect(f.calls).toContain("revoke");
    expect(f.calls.lastIndexOf("stopAll")).toBeGreaterThan(f.calls.indexOf(phase));
    if (phase !== "complete") expect(f.calls).not.toContain("complete");
  });
});
