import { execFile, spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:https";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrivateCdp, protectBrowserPage, type ProtectedInputRequest } from "../src/protected-browser.js";
import { openTableRequest } from "../src/opentable-private-flow.js";
import { createPrivateLoginSubmission } from "../src/private-login-submission.js";

const exec = promisify(execFile);
const chrome = "/usr/bin/google-chrome";
const available = await access(chrome).then(() => true, () => false);
const agentAvailable = await exec("agent-browser", ["--version"], { timeout: 3_000 }).then(() => true, () => false);
const xvfbAvailable = await access("/usr/bin/xvfb-run").then(() => true, () => false);
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
describe.skipIf(!available)("protected CDP against real Chrome and a synthetic HTTPS form", () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
  async function fixture(headed = false, flow?: "code" | "password" | "register") {
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
    const steps: Array<{ kind: string; value: string }> = [];
    let signedIn = false;
    const server = createServer({ key: await readFile(join(root, "key")), cert: await readFile(join(root, "cert")) }, (req, res) => {
      if (flow) {
        if (req.method === "POST") {
          let body = "";
          req.on("data", (chunk) => { body += chunk; });
          req.on("end", () => {
            steps.push(JSON.parse(body)); signedIn = req.url === "/complete";
            res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ next: flow }));
          }); return;
        }
        res.setHeader("content-type", "text/html");
        if (req.url === "/") { res.end(signedIn ? "Safe home page" : '<iframe title="Sign in" src="/authenticate/start"></iframe>'); return; }
        res.end(`<div id="reflect"></div><main></main><script>
          let kind = 'username', destination = '';
          function render(next) {
            kind = next;
            if (next === 'register') { history.pushState({}, '', '/authenticate/register-1'); document.querySelector('main').innerHTML = '<h2>Create account</h2>'; return; }
            const id = next === 'username' ? 'email' : next === 'code' ? 'emailVerificationCode' : 'password';
            const type = next === 'username' ? 'email' : next === 'code' ? 'text' : 'password';
            if (next !== 'username') history.pushState({}, '', '/authenticate/' + (next === 'code' ? 'verify-medium' : 'verify-credentials-2'));
            document.querySelector('main').innerHTML = '<form><input id="' + id + '" type="' + type + '"><button type="submit" data-test="continue-button" disabled>Continue</button></form>';
            if (next === 'code') { const p = document.createElement('p'); p.id = 'delivery'; p.textContent = "We've sent a code to " + destination + ". Enter the code to continue."; document.querySelector('main').prepend(p); }
            const input = document.querySelector('input'), button = document.querySelector('button');
            input.addEventListener('input', () => { button.disabled = !input.value; if (kind === 'code' && input.value.length === 6) void send(input.value); });
            document.querySelector('form').onsubmit = event => { event.preventDefault(); void send(input.value); };
          }
          async function send(value) {
            if (kind === 'username') destination = value;
            document.querySelector('#reflect').textContent += value; console.log(value); void fetch('/echo?value=' + encodeURIComponent(value));
            const response = await fetch(kind === 'username' ? '/stage' : '/complete', {method:'POST',body:JSON.stringify({kind,value})});
            if (kind === 'username') render((await response.json()).next); else parent.location.reload();
          }
          render('username');
        </script>`); return;
      }
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
    const mappedPort = (server.address() as { port: number }).port;
    const chromeArgs = ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--ignore-certificate-errors", "--no-first-run", `--user-data-dir=${join(root, "profile")}`, "--remote-debugging-port=0",
      ...(flow ? ["--no-proxy-server", `--host-resolver-rules=MAP www.opentable.com 127.0.0.1:${mappedPort}`, "https://www.opentable.com/"] : [`${origin}/form`])];
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
        const result = await ready.request("Runtime.evaluate", { expression: flow ? "!!document.querySelector('iframe')?.contentDocument?.querySelector('#email')" : "document.readyState === 'complete' && !!document.querySelector('#password')", returnByValue: true }, sessionId);
        if (result.result?.value === true) { loaded = true; break; }
        await delay(100);
      }
      expect(loaded).toBe(true);
      await ready.request("Target.detachFromTarget", { sessionId });
    } finally { ready.close(); }
    const spec: ProtectedInputRequest = flow ? openTableRequest("test") : { session: "test", pageUrl: `${origin}/form`, resumeUrl: `${origin}/home`, fields: [{ kind: "password", selector: "#password" }], submitSelector: "#submit" };
    return { port, spec, steps, posted: () => posted };
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
  it.each(["code", "password"] as const)("protects the embedded email → %s flow and submits each step once", async (kind) => {
    const f = await fixture(false, kind);
    const page = await protectBrowserPage(f.port, f.spec);
    expect(await page.submit(["synthetic@example.invalid"])).toEqual([kind]);
    await page.submit([kind === "code" ? "123456" : "synthetic-password"]);
    await page.close();
    expect(f.steps).toEqual([{ kind: "username", value: "synthetic@example.invalid" }, { kind, value: kind === "code" ? "123456" : "synthetic-password" }]);
    const inspect = await PrivateCdp.connect(f.port);
    try {
      const pages = (await inspect.request("Target.getTargets")).targetInfos.filter((t: any) => t.type === "page");
      expect(pages).toHaveLength(1);
      const sessionId = (await inspect.request("Target.attachToTarget", { targetId: pages[0].targetId, flatten: true })).sessionId;
      await vi.waitFor(async () => expect((await inspect.request("Runtime.evaluate", { expression: "document.body.innerText", returnByValue: true }, sessionId)).result.value).toBe("Safe home page"));
    } finally { inspect.close(); }
  }, 30_000);
  it("stops at registration without creating an account", async () => {
    const f = await fixture(false, "register");
    const page = await protectBrowserPage(f.port, f.spec);
    await expect(page.submit(["synthetic@example.invalid"])).rejects.toThrow("Unsupported");
    await page.close(); expect(f.steps).toHaveLength(1);
  }, 30_000);
  it.each(["frame", "field", "destination"])("rejects a changed embedded %s before inserting input", async (change) => {
    const f = await fixture(false, "code");
    const page = await protectBrowserPage(f.port, f.spec);
    const edit = await PrivateCdp.connect(f.port);
    const targetId = (await edit.request("Target.getTargets")).targetInfos.find((t: any) => t.type === "page").targetId;
    const sessionId = (await edit.request("Target.attachToTarget", { targetId, flatten: true })).sessionId;
    const expression = change === "frame" ? "document.querySelector('iframe').replaceWith(document.querySelector('iframe').cloneNode())" :
      change === "field" ? "document.querySelector('iframe').contentDocument.querySelector('input').outerHTML = '<input id=email type=email>'" :
      "document.querySelector('iframe').contentDocument.querySelector('form').action = 'https://other.invalid/'";
    await edit.request("Runtime.evaluate", { expression }, sessionId); edit.close();
    await expect(page.submit(["synthetic@example.invalid"])).rejects.toThrow();
    await page.close(); expect(f.steps).toHaveLength(0);
  }, 30_000);
  it.skipIf(!agentAvailable || !xvfbAvailable)("resumes the observer after an embedded flow with no reflected email, code, console or network events", async () => {
    const f = await fixture(true, "code");
    const session = `private-opentable-test-${f.port}`;
    const agent = (...args: string[]) => exec("agent-browser", ["--session", session, "--cdp", String(f.port), ...args], { timeout: 15_000, maxBuffer: 100_000 });
    cleanup.push(async () => { await agent("close").catch(() => {}); });
    await agent("snapshot", "-i"); await agent("close");
    const page = await protectBrowserPage(f.port, f.spec);
    await page.submit(["synthetic@example.invalid"]); await page.submit(["123456"]); await page.close();
    expect((await agent("get", "text", "body")).stdout).toContain("Safe home page");
    for (const args of [["snapshot", "-i"], ["console"], ["network", "requests"]]) {
      const output = (await agent(...args)).stdout;
      expect(output).not.toContain("synthetic@example.invalid"); expect(output).not.toContain("123456");
    }
  }, 30_000);
  it("fills a privately retrieved email code in the bound browser without returning it", async () => {
    const f = await fixture(false, "code"), page = await protectBrowserPage(f.port, f.spec);
    const flow = createPrivateLoginSubmission(page, async () => ({ takeCode: async () => "123456" }));
    expect(await flow.submit(["synthetic@example.invalid"], new AbortController().signal)).toBeUndefined();
    flow.close(); await page.close();
    expect(f.steps).toEqual([{ kind: "username", value: "synthetic@example.invalid" }, { kind: "code", value: "123456" }]);
  }, 30_000);
  it.each(["+15555550123", "other@example.invalid"])("rejects an automatic code if the destination changes to %s during lookup", async (destination) => {
    const f = await fixture(false, "code"), page = await protectBrowserPage(f.port, f.spec);
    await page.submit(["synthetic@example.invalid"]);
    expect(await page.isEmailCodeFor("synthetic@example.invalid")).toBe(true);
    const edit = await PrivateCdp.connect(f.port);
    const targetId = (await edit.request("Target.getTargets")).targetInfos.find((t: any) => t.type === "page").targetId;
    const sessionId = (await edit.request("Target.attachToTarget", { targetId, flatten: true })).sessionId;
    await edit.request("Runtime.evaluate", { expression: `document.querySelector('iframe').contentDocument.querySelector('#delivery').textContent = ${JSON.stringify(`We've sent a code to ${destination}. Enter the code to continue.`)}` }, sessionId);
    edit.close();
    expect(await page.isEmailCodeFor("synthetic@example.invalid")).toBe(false);
    await expect(page.submit(["123456"], "synthetic@example.invalid")).rejects.toThrow();
    await page.close(); expect(f.steps).toHaveLength(1);
  }, 30_000);
});
