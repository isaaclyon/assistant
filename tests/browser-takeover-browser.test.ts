import { execFile, spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import { connect, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrivateCdp } from "../src/protected-browser.js";
import { protectBrowserTakeover } from "../src/browser-takeover-protection.js";
import { startTakeoverServer } from "../src/browser-takeover-server.js";
import { startPrivateHandoff, stopPrivateHandoff, resizePrivateHandoff } from "../.pi/skills/agent-browser/scripts/browser-handoff.mjs";

const exec = promisify(execFile), chrome = "/usr/bin/google-chrome";
const available = await Promise.all([chrome, "/usr/bin/xvfb-run", "/usr/bin/x11vnc", "/usr/bin/websockify"].map(path => access(path).then(() => true, () => false)));
describe.skipIf(available.some(value => !value))("real authenticated noVNC takeover", () => {
  const cleanup: Array<() => Promise<unknown>> = [];
  afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.unstubAllEnvs(); });
  it("renders stock Chrome, transmits private keyboard input, and resumes only after explicit page sharing", async () => {
    const root = await mkdtemp(join(tmpdir(), "takeover-real-browser-"));
    // Chrome descendants can finish profile writes just after their process
    // group receives its stop signal. Bound the directory-removal retry.
    cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
    await mkdir(join(root, "run"), { mode: 0o700 });
    vi.stubEnv("XDG_RUNTIME_DIR", join(root, "run")); vi.stubEnv("XDG_DATA_HOME", join(root, "data")); vi.stubEnv("PI_TELEGRAM_BRIDGE_INSTANCE_ID", "takeover-test");
    // Only this synthetic fixture relaxes Chrome's sandbox for CI runners.
    // The stock helper's production flags stay unchanged.
    const testChrome = join(root, "chrome-test.sh");
    await writeFile(testChrome, `#!/bin/sh\nexec "${chrome}" --no-sandbox --ignore-certificate-errors "$@"\n`, { mode: 0o700 });
    vi.stubEnv("STOCK_BROWSER_CHROME", testChrome);
    await exec("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(root, "key"), "-out", join(root, "cert"), "-days", "1", "-subj", "/CN=localhost"]);
    let gatewayPort = 0;
    const statuses: string[] = [];
    const received = new Set<string>();
    const proxy = createServer({ key: await readFile(join(root, "key")), cert: await readFile(join(root, "cert")) }, (req, res) => {
      if (req.url === "/form") { res.setHeader("content-type", "text/html"); res.end(`<meta name="viewport" content="width=device-width,initial-scale=1"><style>#entry{width:80%;height:200px;background:rgb(255,0,160)}@media(min-width:450px){#entry{background:gray}}</style><h1>Takeover test</h1><input id="entry" autofocus><input id="password" type="password"><script>document.querySelector('#entry').oninput=()=>fetch('/typed',{method:'POST',body:document.querySelector('#entry').value})</script>`); return; }
      if (req.url === "/typed") { let text = ""; req.on("data", chunk => { text += chunk; }); req.on("end", () => { received.add(text); res.end("ok"); }); return; }
      if (req.url === "/home") { res.end("Safe home"); return; }
      void (async () => {
        const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
        const response = await fetch(`http://127.0.0.1:${gatewayPort}${req.url}`, { method: req.method!, headers: Object.fromEntries(Object.entries(req.headers).filter(([k]) => !["host", "connection", "content-length"].includes(k))) as Record<string,string>,
          ...(req.method === "POST" ? { body: Buffer.concat(chunks) } : {}) });
        if (req.url?.startsWith("/api/")) statuses.push(`${req.url} ${response.status}`);
        res.writeHead(response.status, Object.fromEntries(response.headers));
        if (req.url === "/") res.end((await response.text()).replace('<script src="https://telegram.org/js/telegram-web-app.js"></script>', ""));
        else res.end(Buffer.from(await response.arrayBuffer()));
      })().catch(() => res.destroy());
    });
    const peers = new Set<Socket | Duplex>();
    proxy.on("connection", socket => { peers.add(socket); socket.on("close", () => peers.delete(socket)); });
    proxy.on("upgrade", (req, socket, head) => {
      const upstream = connect(gatewayPort, "127.0.0.1", () => {
        upstream.write(`GET ${req.url} HTTP/1.1\r\n${req.rawHeaders.reduce((lines, value, i) => lines + (i % 2 ? `${value}\r\n` : `${value}: `), "")}\r\n`);
        if (head.length) upstream.write(head);
        socket.pipe(upstream).pipe(socket);
      });
      upstream.on("error", () => socket.destroy()); socket.on("error", () => upstream.destroy());
      peers.add(upstream); upstream.on("close", () => peers.delete(upstream));
    });
    await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
    cleanup.push(async () => { for (const socket of peers) socket.destroy(); await new Promise<void>(r => proxy.close(() => r())); });
    const origin = `https://127.0.0.1:${(proxy.address() as any).port}`;
    const stock = join(process.cwd(), ".pi/skills/agent-browser/scripts/stock-chrome.mjs");
    const started = JSON.parse((await exec(process.execPath, [stock, "start", "viewer"], { timeout: 20_000 })).stdout);
    cleanup.push(() => exec(process.execPath, [stock, "stop", "viewer"], { timeout: 10_000 }));
    const remote = await PrivateCdp.connect(started.port);
    const target = (await remote.request("Target.getTargets")).targetInfos.find((t: any) => t.type === "page");
    const remoteSession = (await remote.request("Target.attachToTarget", { targetId: target.targetId, flatten: true })).sessionId;
    await remote.request("Security.setIgnoreCertificateErrors", { ignore: true }, remoteSession);
    await remote.request("Page.navigate", { url: `${origin}/form` }, remoteSession);
    await vi.waitFor(async () => expect((await remote.request("Runtime.evaluate", { expression: "!!document.querySelector('#entry')", returnByValue: true }, remoteSession)).result.value).toBe(true));
    await remote.request("Runtime.evaluate", { expression: "document.querySelector('#entry').focus()" }, remoteSession);
    const originalWidth = (await remote.request("Page.getLayoutMetrics", {}, remoteSession)).cssLayoutViewport.clientWidth;
    await remote.request("Target.detachFromTarget", { sessionId: remoteSession }); remote.close();
    const protectedPage = await protectBrowserTakeover(started.port, { session: "viewer", resumeUrl: `${origin}/home` });
    let restored = false;
    cleanup.push(async () => { if (!restored) await protectedPage.finish("private").catch(() => {}); });
    const handoff = await startPrivateHandoff("viewer"); cleanup.push(() => stopPrivateHandoff("viewer"));
    const handoffStatePath = join(root, "run/pi-agent-browser/takeover-test/viewer/handoff.json");
    const handoffState = await readFile(handoffStatePath, "utf8");
    try {
      await writeFile(handoffStatePath, JSON.stringify({ ...JSON.parse(handoffState), controlProperty: `PI_TAKEOVER_${"0".repeat(32)}` }));
      await expect(resizePrivateHandoff("viewer", 500, 700)).rejects.toThrow("Private viewer unavailable");
    } finally { await writeFile(handoffStatePath, handoffState); }
    const token = "123:synthetic-only", launch = new URLSearchParams({ auth_date: `${Math.floor(Date.now() / 1000)}`, user: '{"id":123}' }); launch.sort();
    launch.set("hash", createHmac("sha256", createHmac("sha256", "WebAppData").update(token).digest()).update([...launch].map(([k,v]) => `${k}=${v}`).join("\n")).digest("hex"));
    const server = await startTakeoverServer({ origin, botToken: token, userId: 123, resourceRoot: process.cwd(), upstreamPort: handoff.webPort,
      resize: async viewport => { const size = await protectedPage.resize(viewport); await resizePrivateHandoff("viewer", size.width, size.height); },
      password: (await readFile(handoff.passwordPath, "utf8")).trim(), resumeUrl: `${origin}/home`, signal: new AbortController().signal });
    gatewayPort = server.port; cleanup.push(server.close);
    let client: ChildProcess | undefined;
    cleanup.push(async () => { if (client && client.exitCode === null && client.signalCode === null) { const exit = new Promise(r => client!.once("exit", r)); client.kill("SIGKILL"); await exit; } });
    client = spawn(chrome, ["--headless", "--no-sandbox", "--disable-dev-shm-usage", "--ignore-certificate-errors", "--remote-debugging-port=0", `--user-data-dir=${join(root, "client")}`, "about:blank"], { stdio: "ignore" });
    let clientPort = 0;
    await vi.waitFor(async () => { clientPort = Number((await readFile(join(root, "client/DevToolsActivePort"), "utf8")).split("\n")[0]); expect(clientPort).toBeGreaterThan(0); }, { timeout: 15_000 });
    const control = await PrivateCdp.connect(clientPort); cleanup.push(async () => control.close());
    const clientTarget = (await control.request("Target.getTargets")).targetInfos.find((t: any) => t.type === "page");
    const sessionId = (await control.request("Target.attachToTarget", { targetId: clientTarget.targetId, flatten: true })).sessionId;
    await control.request("Page.enable", {}, sessionId);
    await control.request("Emulation.setDeviceMetricsOverride", { width: 390, height: 780, deviceScaleFactor: 1, mobile: true }, sessionId);
    await control.request("Page.addScriptToEvaluateOnNewDocument", { source: `window.clientErrors=[]; console.error=(...args)=>window.clientErrors.push(args.map(String).join(' ')); window.addEventListener('error',e=>window.clientErrors.push(e.message)); window.Telegram={WebApp:{initData:${JSON.stringify(launch.toString())},ready(){},expand(){},enableClosingConfirmation(){},disableClosingConfirmation(){},close(){window.didClose=true}}}` }, sessionId);
    await control.request("Page.navigate", { url: `${origin}/#request=${server.requestId}` }, sessionId);
    const evaluate = async (expression: string) => (await control.request("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId)).result?.value;
    try { await vi.waitFor(async () => expect(await evaluate("document.querySelector('#status')?.textContent")).toContain("Assistant paused"), { timeout: 15_000 }); }
    catch { throw new Error(`Synthetic viewer failed: ${statuses.join(', ')}; ${JSON.stringify(await evaluate('window.clientErrors'))}`); }
    try {
      await vi.waitFor(async () => expect(await evaluate("document.querySelector('#screen canvas')?.getBoundingClientRect().width")).toBeCloseTo(390, 0), { timeout: 10_000 });
      // Locate the fixture's pink input in actual received VNC pixels. This waits
      // for rendering and avoids guessing native window borders or browser bars.
      let click: { x: number; y: number } | null = null;
      await vi.waitFor(async () => {
        click = await evaluate(`(()=>{
          const c=document.querySelector('#screen canvas'); if(!c?.width)return null;
          const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data, points=[];
          const pink=(x,y)=>{const p=(y*c.width+x)*4; return d[p]>220&&d[p+1]<40&&d[p+2]>120&&d[p+2]<200};
          for(let y=8;y<c.height-8;y+=16)for(let x=8;x<c.width-8;x+=16)
            if(pink(x,y)&&pink(x+8,y)&&pink(x,y+8))points.push([x+4,y+4]);
          if(points.length<50)return null;
          const [x,y]=points[Math.floor(points.length/2)], r=c.getBoundingClientRect();
          return {x:r.x+x*r.width/c.width,y:r.y+y*r.height/c.height};
        })()`);
        expect(click).not.toBeNull();
      }, { timeout: 10_000 });
      expect(await evaluate("document.querySelector('#screen canvas').width")).toBe(500);
      expect(await evaluate("document.querySelector('#screen canvas').getBoundingClientRect().width")).toBeCloseTo(390, 0);
      await control.request("Input.dispatchMouseEvent", { type: "mousePressed", ...click!, button: "left", clickCount: 1 }, sessionId);
      await control.request("Input.dispatchMouseEvent", { type: "mouseReleased", ...click!, button: "left", clickCount: 1 }, sessionId);
      await evaluate("document.querySelector('#typing').value='synthetic-typed'; document.querySelector('#typing').dispatchEvent(new InputEvent('input',{bubbles:true}))");
      await vi.waitFor(() => expect(received.has("synthetic-typed")).toBe(true), { timeout: 5_000 });
      const tall = await evaluate("document.querySelector('#screen canvas').height");
      // Simulate the visual space left by a phone keyboard, then its dismissal.
      await control.request("Emulation.setDeviceMetricsOverride", { width: 390, height: 450, deviceScaleFactor: 1, mobile: true }, sessionId);
      await vi.waitFor(async () => expect(await evaluate("document.querySelector('#screen canvas').height")).toBeLessThan(tall), { timeout: 10_000 });
      await control.request("Emulation.setDeviceMetricsOverride", { width: 390, height: 780, deviceScaleFactor: 1, mobile: true }, sessionId);
      await vi.waitFor(async () => expect(await evaluate("document.querySelector('#screen canvas').height")).toBe(tall), { timeout: 10_000 });
      await evaluate("document.querySelector('#desktop').click()");
      // x11vnc may exclude the display's last pixel when clipping its full width.
      await vi.waitFor(async () => expect([1919, 1920]).toContain(await evaluate("document.querySelector('#screen canvas').width")), { timeout: 10_000 });
      await evaluate("document.querySelector('#desktop').click()");
      await vi.waitFor(async () => expect(await evaluate("document.querySelector('#screen canvas').width")).toBe(500), { timeout: 10_000 });
    } catch (error) {
      // Synthetic fixture diagnostics only; production never captures frames.
      const image = await evaluate("document.querySelector('#screen canvas')?.toDataURL('image/png')");
      if (image) {
        await mkdir("/tmp/pi-takeover-test-diagnostics", { recursive: true, mode: 0o700 });
        await writeFile("/tmp/pi-takeover-test-diagnostics/viewer.png", Buffer.from(image.split(",")[1], "base64"));
      }
      throw error;
    }
    await evaluate("document.querySelector('#handback').click(); document.querySelector('#share').click()");
    expect(await server.done).toEqual({ status: "handed_back", mode: "share" });
    await server.close(); await stopPrivateHandoff("viewer"); await protectedPage.finish("share"); restored = true;
    const resumed = await PrivateCdp.connect(started.port); cleanup.push(async () => resumed.close());
    const resumedTarget = (await resumed.request("Target.getTargets")).targetInfos.find((t: any) => t.type === "page");
    const resumedSession = (await resumed.request("Target.attachToTarget", { targetId: resumedTarget.targetId, flatten: true })).sessionId;
    expect((await resumed.request("Runtime.evaluate", { expression: "document.querySelector('#entry').value", returnByValue: true }, resumedSession)).result.value).toBe("synthetic-typed");
    expect((await resumed.request("Page.getLayoutMetrics", {}, resumedSession)).cssLayoutViewport.clientWidth).toBe(originalWidth);
    expect(await evaluate("window.didClose")).toBe(true);
  }, 60_000);
});
