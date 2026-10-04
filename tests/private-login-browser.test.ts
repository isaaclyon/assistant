import { execFile, spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrivateCdp } from "../src/protected-browser.js";
import { protectPrivateLogin } from "../src/private-login.js";
import { protectBrowserTakeover } from "../src/browser-takeover-protection.js";
const exec = promisify(execFile), chrome = "/usr/bin/google-chrome";
const available = await access(chrome).then(() => true, () => false);
describe.skipIf(!available)("private general login against Chrome", () => {
  const cleanup: Array<() => Promise<unknown>> = [];
  afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
  async function fixture(spa = false, initial?: string, amazon = false) {
    const root = await mkdtemp(join(tmpdir(), "private-login-test-"));
    cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
    await exec("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(root,"key"), "-out", join(root,"cert"), "-days", "1", "-subj", "/CN=localhost"]);
    const received: string[] = [];
    const startPath = amazon ? "/ap/signin" : "/start";
    const form = (kind: string, next: string) => `<h1>${kind === "code" ? "Two-Step Verification" : "Sign in"}</h1><form method="post" action="/${next}"><input type="hidden" name="challenge" value="fixed"><label>${kind === "username" ? "Email or phone" : kind}</label><input id="entry" name="${kind}" type="${kind === "password" ? "password" : "text"}" autocomplete="${kind === "password" ? "current-password" : kind === "code" ? "one-time-code" : "username"}"><button>Continue</button></form>`;
    const server = createServer({ key: await readFile(join(root,"key")), cert: await readFile(join(root,"cert")) }, (req,res) => {
      const render = () => {
        res.setHeader("content-type", "text/html");
        const body = req.url === startPath ? initial ?? form("username","login/password") : req.url === "/login/password" ? form("password","login/code") : req.url === "/login/code" ? form("code","login/done") : req.url === "/login/done" ? '<a href="/logout">Sign out</a><p>Synthetic private response</p>' : "Clean home";
        res.end(body + (spa ? `<script>document.querySelector('form')?.addEventListener('submit',async e=>{e.preventDefault();const f=e.target,u=f.action;const r=await fetch(u,{method:'POST',body:new URLSearchParams(new FormData(f))});history.pushState({},'',u);document.open();document.write(await r.text());document.close()})</script>` : ""));
      };
      if (req.method === "POST") { let text=""; req.on("data",c=>text+=c); req.on("end",()=>{ received.push(text); render(); }); }
      else render();
    });
    await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
    cleanup.push(()=>new Promise<void>(r=>{server.close(()=>r());server.closeAllConnections();}));
    const portNumber = (server.address() as any).port;
    const origin = amazon ? "https://www.amazon.com" : `https://127.0.0.1:${portNumber}`;
    const child: ChildProcess = spawn(chrome,["--headless","--no-sandbox","--disable-dev-shm-usage","--ignore-certificate-errors","--no-first-run",`--user-data-dir=${join(root,"profile")}`,"--remote-debugging-port=0",...(amazon ? ["--no-proxy-server",`--host-resolver-rules=MAP www.amazon.com 127.0.0.1:${portNumber}`] : []),`${origin}${startPath}`],{stdio:"ignore",detached:true});
    cleanup.push(async()=>{if(child.exitCode===null&&child.signalCode===null){const exit=new Promise(r=>child.once("exit",r));try{process.kill(-child.pid!,"SIGTERM");}catch{child.kill("SIGTERM");}await exit;}});
    let port=0;
    await vi.waitFor(async()=>{port=Number((await readFile(join(root,"profile/DevToolsActivePort"),"utf8")).split("\n")[0]);expect(port).toBeGreaterThan(0);},{timeout:15000});
    const inspect = await PrivateCdp.connect(port);
    const page = (await inspect.request("Target.getTargets")).targetInfos.find((t:any)=>t.type==="page");
    const sid = (await inspect.request("Target.attachToTarget",{targetId:page.targetId,flatten:true})).sessionId;
    await vi.waitFor(async()=>expect((await inspect.request("Runtime.evaluate",{expression:`location.href === ${JSON.stringify(`${origin}${startPath}`)} && document.readyState === 'complete' && !!document.querySelector('h1')`,returnByValue:true},sid)).result.value).toBe(true),{timeout:5000});
    inspect.close();
    const request = { session:"test",pageUrl:`${origin}${startPath}`,resumeUrl:`${origin}/home` };
    const owner = await protectBrowserTakeover(port,request);
    let finished = false;
    const finish = async () => { if (!finished) { await owner.finish("private"); finished = true; } };
    cleanup.push(()=>finish().catch(()=>{}));
    const controller = new AbortController();
    const login = await protectPrivateLogin(port,request,controller.signal); cleanup.push(async()=>login.close());
    const edit = async (expression:string) => { const c=await PrivateCdp.connect(port);try{const s=(await c.request("Target.attachToTarget",{targetId:page.targetId,flatten:true})).sessionId;return (await c.request("Runtime.evaluate",{expression,returnByValue:true},s)).result?.value;}finally{c.close();} };
    return {login,received,finish,port,request,controller,edit};
  }
  it.each([false,true])("keeps identifier/password/code steps protected across navigation (SPA=%s)",async spa=>{
    const f=await fixture(spa);
    expect(f.login.state()).toEqual({state:"fields",fields:["username"]});
    expect(f.login.hasUsername()).toBe(false); expect(f.login.matchesUsername("unknown")).toBe(false);
    expect(await f.login.submit(["person@example.invalid"])).toEqual({state:"fields",fields:["password"]});
    expect(f.login.hasUsername()).toBe(true); expect(f.login.matchesUsername("person@example.invalid")).toBe(true);
    expect(f.login.matchesUsername("other@example.invalid")).toBe(false);
    expect(await f.login.submit(["synthetic-secret"])).toEqual({state:"fields",fields:["code"]});
    expect(await f.login.submit(["123456"])).toEqual({state:"complete"});
    expect(f.received).toHaveLength(3);
    await expect(f.login.submit(["retry"])).rejects.toThrow();
    f.login.close(); await f.finish();
    const c=await PrivateCdp.connect(f.port);
    try{await vi.waitFor(async()=>{const pages=(await c.request("Target.getTargets")).targetInfos.filter((t:any)=>t.type==="page");expect(pages).toHaveLength(1);expect(pages[0].url).toBe(f.request.resumeUrl);});}finally{c.close();}
  },30000);
  it.each(["field","destination","challenge","purpose","autocomplete","extra hidden","external control"])("refuses changed %s before filling",async change=>{
    const f=await fixture();
    await f.edit(change==="field" ? `document.querySelector('#entry').outerHTML='<input id="entry" name="username" autocomplete="username">'` : change==="destination" ? `document.querySelector('form').action='https://other.invalid/'` : change==="challenge" ? `document.querySelector('[type=hidden]').value='changed'` : change==="autocomplete" ? `document.querySelector('#entry').autocomplete='new-password'` : change==="extra hidden" ? `document.querySelector('form').insertAdjacentHTML('beforeend','<input type="hidden" name="action" value="delete">')` : change==="external control" ? `document.querySelector('form').id='login';document.body.insertAdjacentHTML('beforeend','<input type="hidden" form="login" name="action" value="delete">')` : `document.querySelector('h1').textContent='Create account'`);
    expect(await f.login.submit(["synthetic-secret"])).toEqual({state:"manual"});
    expect(f.received).toEqual([]); expect(await f.edit("document.querySelector('#entry').value")).toBe("");
  },30000);
  it("recognizes Amazon's inspected identifier screen with an aria-labelledby submit input", async () => {
    const html = '<h1>Sign in or create account</h1><form method="post" action="/ax/claim"><input name="email" id="ap_email_login" autocomplete="webauthn"><input type="password" name="password" style="display:none"><span><input type="submit" aria-labelledby="continue-announce"><span id="continue-announce">Continue</span></span></form>';
    const f = await fixture(false, html, true);
    expect(f.login.state()).toEqual({ state: "fields", fields: ["username"] }); expect(f.received).toEqual([]);
  }, 30000);
  it("supports a combined sign-in form whose button enables after input", async () => {
    const f = await fixture(false, '<h1>Sign in</h1><form method="post" action="/login/done"><input name="username" autocomplete="username"><input name="password" type="password" autocomplete="current-password"><button disabled>Sign in</button><a href="/register">Create account</a></form><script>document.querySelector("form").oninput=()=>{document.querySelector("button").disabled=false}</script>');
    expect(f.login.state()).toEqual({ state: "fields", fields: ["username", "password"] });
    expect(await f.login.submit(["synthetic-user", "synthetic-secret"])).toEqual({ state: "complete" });
    expect(f.received).toHaveLength(1);
  }, 30000);
  it("hands a backwards or repeated challenge to the user without another submission", async () => {
    const f = await fixture(false, '<h1>Two-Step Verification</h1><form method="post" action="/login/password"><input name="otp" autocomplete="one-time-code"><button>Continue</button></form>');
    expect(await f.login.submit(["123456"])).toEqual({ state: "manual" });
    await expect(f.login.submit(["synthetic-secret"])).rejects.toThrow();
    expect(f.received).toHaveLength(1);
  }, 30000);
  it.each([
    '<h1>Create account</h1><form method="post"><input name="email"><input type="password" autocomplete="new-password"><button>Continue</button></form>',
    '<h1>Sign in</h1><form method="get"><input name="email"><button>Continue</button></form>',
    '<h1>Sign in</h1><form method="post" action="/delete"><input name="email"><button>Continue</button></form>',
    '<h1>Sign in</h1><form method="post" action="/unrecognized"><input name="email"><button>Continue</button></form>',
    '<h1>Sign in</h1><iframe src="about:blank"></iframe>',
  ])("offers manual takeover for unsupported forms",async html=>{
    const f=await fixture(false,html); expect(f.login.state()).toEqual({state:"manual"}); expect(f.received).toEqual([]);
  },30000);
});
