import { execFile, spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:https";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrivateCdp, protectBrowserPage, type ProtectedInputRequest } from "../src/protected-browser.js";

const exec = promisify(execFile);
const chrome = "/usr/bin/google-chrome";
const available = await access(chrome).then(() => true, () => false);
const agentAvailable = await exec("agent-browser", ["--version"], { timeout: 3_000 }).then(() => true, () => false);
const xvfbAvailable = await access("/usr/bin/xvfb-run").then(() => true, () => false);
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
describe.skipIf(!available)("protected CDP against real Chrome and a synthetic HTTPS form", () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
  async function fixture(headed = false) {
    const root = await mkdtemp(join(tmpdir(), "protected-browser-test-"));
    let child: ChildProcess | undefined;
    cleanup.push(async () => {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = new Promise((resolve) => child!.once("exit", resolve));
        try { process.kill(-child.pid!, "SIGTERM"); } catch { child.kill("SIGTERM"); }
        await exited;
      }
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
    await exec("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(root, "key"), "-out", join(root, "cert"), "-days", "1", "-subj", "/CN=localhost"]);
    let posted = "";
    const server = createServer({ key: await readFile(join(root, "key")), cert: await readFile(join(root, "cert")) }, (req, res) => {
      if (req.method === "POST") {
        req.on("data", (chunk) => { posted += chunk; });
        req.on("end", () => { res.writeHead(303, { location: "/response" }); res.end(); }); return;
      }
      res.setHeader("content-type", "text/html");
      res.end(req.url === "/form" ? '<form method="post" action="/login"><input id="password" name="password" type="password"><button id="submit">Sign in</button></form>' : req.url === "/response" ?
        `Reflected sensitive response: ${posted}<script>console.log(${JSON.stringify(posted)}); fetch('/echo?value=' + encodeURIComponent(${JSON.stringify(posted)}));</script>` : "Safe home page");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));
    const origin = `https://127.0.0.1:${(server.address() as { port: number }).port}`;
    const chromeArgs = ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--ignore-certificate-errors", "--no-first-run", `--user-data-dir=${join(root, "profile")}`, "--remote-debugging-port=0", `${origin}/form`];
    child = spawn(headed ? "xvfb-run" : chrome, headed ? ["-a", chrome, ...chromeArgs] : ["--headless", ...chromeArgs], { stdio: "ignore", detached: true });
    let port = 0;
    const startupDeadline = Date.now() + 15_000;
    while (Date.now() < startupDeadline && child.exitCode === null && child.signalCode === null) {
      try { port = Number((await readFile(join(root, "profile/DevToolsActivePort"), "utf8")).split("\n")[0]); break; } catch { await delay(50); }
    }
    if (!port) throw new Error("Test Chrome did not start");
    const ready = await PrivateCdp.connect(port);
    try {
      const target = (await ready.request("Target.getTargets")).targetInfos.find((target: any) => target.type === "page");
      const sessionId = (await ready.request("Target.attachToTarget", { targetId: target.targetId, flatten: true })).sessionId;
      let loaded = false;
      for (let attempt = 0; attempt < 50; attempt++) {
        const result = await ready.request("Runtime.evaluate", { expression: "document.readyState === 'complete' && !!document.querySelector('#password')", returnByValue: true }, sessionId);
        if (result.result?.value === true) { loaded = true; break; }
        await delay(100);
      }
      expect(loaded).toBe(true);
      await ready.request("Target.detachFromTarget", { sessionId });
    } finally { ready.close(); }
    const spec: ProtectedInputRequest = { session: "test", pageUrl: `${origin}/form`, resumeUrl: `${origin}/home`, fields: [{ kind: "password", selector: "#password" }], submitSelector: "#submit" };
    return { port, spec, posted: () => posted };
  }
  it("fills once, posts, destroys a secret-reflecting document and opens a clean resume page", async () => {
    const f = await fixture();
    const page = await protectBrowserPage(f.port, f.spec);
    await page.submit(["synthetic-secret-123"]);
    await expect(page.submit(["retry"])).rejects.toThrow();
    await page.close();
    expect(f.posted()).toBe("password=synthetic-secret-123");
    const inspect = await PrivateCdp.connect(f.port);
    try {
      await vi.waitFor(async () => {
        const pages = (await inspect.request("Target.getTargets")).targetInfos.filter((target: any) => target.type === "page");
        expect(pages).toHaveLength(1); expect(pages[0].url).toBe(f.spec.resumeUrl);
      }, { timeout: 5_000, interval: 100 });
    } finally { inspect.close(); }
  }, 30_000);
  it("rejects a swapped field before transmitting a value", async () => {
    const f = await fixture();
    const page = await protectBrowserPage(f.port, f.spec);
    const mutation = await PrivateCdp.connect(f.port);
    const targetId = (await mutation.request("Target.getTargets")).targetInfos.find((t: any) => t.type === "page").targetId;
    const sessionId = (await mutation.request("Target.attachToTarget", { targetId, flatten: true })).sessionId;
    await mutation.request("Runtime.evaluate", { expression: 'document.querySelector("#password").outerHTML = \'<input type="password" id="password" name="password">\'' }, sessionId);
    mutation.close();
    await expect(page.submit(["synthetic-secret-123"])).rejects.toThrow("page changed");
    await page.close(); expect(f.posted()).toBe("");
  }, 30_000);
  it("refuses an existing debugger before accepting private input", async () => {
    const f = await fixture();
    const observer = await PrivateCdp.connect(f.port);
    const targetId = (await observer.request("Target.getTargets")).targetInfos.find((t: any) => t.type === "page").targetId;
    await observer.request("Target.attachToTarget", { targetId, flatten: true });
    try { await expect(protectBrowserPage(f.port, f.spec)).rejects.toThrow("unattached"); }
    finally { observer.close(); }
  }, 30_000);
  it.each(['formaction="https://other.invalid/"', 'formmethod="get"', 'formmethod=""'])("rejects submit-button override %s", async (attribute) => {
    const f = await fixture();
    const edit = await PrivateCdp.connect(f.port);
    const targetId = (await edit.request("Target.getTargets")).targetInfos.find((t: any) => t.type === "page").targetId;
    const sessionId = (await edit.request("Target.attachToTarget", { targetId, flatten: true })).sessionId;
    const changed = await edit.request("Runtime.evaluate", { expression: `document.querySelector('#submit').outerHTML = ${JSON.stringify(`<button id="submit" ${attribute}>Sign in</button>`)}` }, sessionId);
    expect(changed.exceptionDetails).toBeUndefined();
    await edit.request("Target.detachFromTarget", { sessionId }); edit.close();
    await expect(protectBrowserPage(f.port, f.spec)).rejects.toThrow("supported");
    expect(f.posted()).toBe("");
  }, 30_000);
  it.skipIf(!agentAvailable || !xvfbAvailable)("disconnects the real observer and resumes headed Chrome without leaked DOM or console output", async () => {
    const f = await fixture(true);
    const session = `private-input-test-${f.port}`;
    const agent = (...args: string[]) => exec("agent-browser", ["--session", session, "--cdp", String(f.port), ...args], { timeout: 15_000, maxBuffer: 100_000 });
    cleanup.push(async () => { await agent("close").catch(() => {}); });
    await agent("snapshot", "-i"); await agent("close");
    const page = await protectBrowserPage(f.port, f.spec);
    await page.submit(["synthetic-secret-123"]); await page.close();
    const text = (await agent("get", "text", "body")).stdout;
    expect(text).toContain("Safe home page"); expect(text).not.toContain("synthetic-secret-123");
    expect((await agent("console")).stdout).not.toContain("synthetic-secret-123");
    expect((await agent("network", "requests")).stdout).not.toContain("synthetic-secret-123");
  }, 30_000);
});
