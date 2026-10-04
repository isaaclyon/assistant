import RFB from "/novnc/core/rfb.js";
import KeyTable from "/novnc/core/input/keysym.js";
import { initLogging } from "/novnc/core/util/logging.js";

// In particular, never enable noVNC's informational keysym logging.
initLogging("none");

const app = window.Telegram?.WebApp;
const el = id => document.getElementById(id);
const requestId = new URLSearchParams(location.hash.slice(1)).get("request");
const initData = app?.initData;
let rfb, socket, ticket, finished = false, finishing = false, connected = false, expiry;
let desktop = false, appliedViewport = "", resizeTimer, resizePending = false;
let previous = "";
let loginStep, loginInputs = [], loginBusy = false, cancellingLogin = false;
const clearLogin = () => loginInputs.forEach(input => { input.value = ""; });
function lockLogin(locked) {
  for (const id of ["login-submit", "login-saved", "login-takeover"]) el(id).disabled = locked;
  loginInputs.forEach(input => { input.disabled = locked; });
}
function renderLogin(result) {
  clearLogin(); loginInputs = []; el("login-fields").replaceChildren();
  loginStep = result.step; el("login").hidden = false;
  el("login-origin").textContent = `Website: ${result.origin}`;
  el("login-status").textContent = result.savedUnavailable ? "Saved sign-in is unavailable for this step. Enter it privately or take over." : result.login.state === "fields" ?
    "Sign in to your existing account. Your details stay private across steps." : "This step needs you. Take over to continue in the same browser.";
  el("login-form").hidden = result.login.state !== "fields";
  el("login-saved").hidden = !result.saved;
  for (const kind of result.login.fields || []) {
    const label = document.createElement("label"), input = document.createElement("input");
    input.id = `login-${kind}`; label.htmlFor = input.id;
    label.textContent = kind === "username" ? "Email, phone or username" : kind === "password" ? "Password" : "Verification code";
    input.type = kind === "username" ? "text" : "password";
    input.autocomplete = "off"; input.autocapitalize = "off"; input.spellcheck = false; input.required = true;
    input.maxLength = kind === "code" ? 32 : 1024;
    el("login-fields").append(label, input); loginInputs.push(input);
  }
  loginBusy = false; lockLogin(false); el("login-cancel").disabled = false;
}
async function submitLogin(saved) {
  if (finished || loginBusy || cancellingLogin) return;
  loginBusy = true; lockLogin(true);
  const values = saved ? undefined : loginInputs.map(input => input.value);
  clearLogin(); el("login-status").textContent = "Submitting privately…";
  try {
    const result = await post("login", { step: loginStep, ...(saved ? { saved: true } : { values }) });
    if (finished || cancellingLogin) return;
    if (result.status === "submitted") {
      finished = true; clearTimeout(expiry); el("login-status").textContent = "Details submitted. The assistant will check sign-in.";
      app?.disableClosingConfirmation(); try { app?.close(); } catch {}
    } else renderLogin(result);
  } catch {
    if (!cancellingLogin) el("login-status").textContent = "Could not confirm this step. Reopen the sign-in button or cancel; do not resend details in chat.";
  } finally { values?.fill(""); }
}
el("login-form").addEventListener("submit", event => { event.preventDefault(); void submitLogin(false); });
el("login-saved").onclick = () => void submitLogin(true);
el("login-takeover").onclick = () => { if (!finished && !loginBusy && !cancellingLogin) { clearLogin(); lockLogin(true); el("login").hidden = true; void connect(true); } };
el("login-cancel").onclick = async () => {
  if (finished) return; cancellingLogin = true; clearLogin(); lockLogin(true); el("login-cancel").disabled = true;
  try { await post("login-cancel"); finished = true; clearTimeout(expiry); el("login-status").textContent = "Cancelled."; app?.disableClosingConfirmation(); }
  catch { el("login-status").textContent = "Could not confirm cancellation. Retry or check Telegram."; el("login-cancel").disabled = false; }
};
window.addEventListener("pagehide", clearLogin);
const buttons = ["keyboard", "tab", "enter", "scale", "desktop", "handback"];
app?.ready(); app?.expand(); app?.enableClosingConfirmation(); app?.disableVerticalSwipes?.();
function layout() {
  const heights = [window.innerHeight, window.visualViewport?.height, app?.viewportHeight].filter(n => Number.isFinite(n) && n > 0);
  document.body.style.height = `${Math.min(...heights)}px`;
  document.body.style.top = `${window.visualViewport?.offsetTop || 0}px`;
}
function viewport() {
  const rect = el("screen").getBoundingClientRect();
  return { width: Math.max(320, Math.min(1920, Math.floor(rect.width))), height: Math.max(180, Math.min(1080, Math.floor(rect.height))), desktop };
}
function scheduleResize() {
  layout(); clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => void resizeViewer(), 300);
}
async function resizeViewer() {
  if (!connected || finished || finishing || resizePending) return;
  const next = viewport(), key = JSON.stringify(next);
  if (key === appliedViewport) return;
  resizePending = true;
  try { await post("viewport", { ticket, viewport: next }); appliedViewport = key; }
  catch { el("status").textContent = "Could not fit the view. Try Desktop or reconnect."; }
  finally { resizePending = false; if (key !== JSON.stringify(viewport())) scheduleResize(); }
}
window.visualViewport?.addEventListener("resize", scheduleResize);
window.visualViewport?.addEventListener("scroll", scheduleResize);
window.addEventListener("resize", scheduleResize);
app?.onEvent?.("viewportChanged", scheduleResize);
new ResizeObserver(scheduleResize).observe(el("screen"));
layout();
async function post(path, extra = {}) {
  const response = await fetch(`/api/${path}`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ requestId, initData, ...extra }), signal: AbortSignal.timeout(path === "login" ? 75_000 : 10_000) });
  if (!response.ok) throw new Error("Unavailable");
  return response.json();
}
function disconnect() { rfb?.disconnect(); socket?.close(); el("typing").value = ""; previous = ""; }
function unavailable() {
  connected = false;
  if (finished || finishing) return;
  buttons.forEach(id => { el(id).disabled = id !== "handback" || !ticket; });
  el("status").textContent = "Viewer disconnected. Reconnect, return privately, or check Telegram.";
  el("reconnect").hidden = false;
  el("share").disabled = true;
}
async function connect(takeover = false) {
  el("reconnect").hidden = true; el("status").textContent = "Connecting securely…";
  try {
    if (!requestId || !initData) throw new Error();
    const initialViewport = viewport();
    const auth = await post("auth", { viewport: initialViewport, ...(takeover ? { takeover: true, step: loginStep } : {}) });
    appliedViewport = JSON.stringify(initialViewport);
    el("resume").textContent = auth.resumeUrl;
    clearTimeout(expiry);
    expiry = setTimeout(() => { finished = true; clearLogin(); lockLogin(true); el("login").hidden = true; disconnect(); el("finish").hidden = true; el("reconnect").hidden = true; buttons.forEach(id => { el(id).disabled = true; }); el("status").textContent = "Takeover expired. The private view is closed."; }, Math.max(0, auth.expiresAt - Date.now()));
    if (auth.login) { renderLogin(auth); return; }
    el("login").hidden = true; ticket = auth.ticket;
    socket = new WebSocket(`${location.origin.replace(/^https:/, "wss:")}/socket`);
    socket.addEventListener("open", () => socket.send(JSON.stringify({ ticket })), { once: true });
    socket.addEventListener("error", unavailable);
    socket.addEventListener("close", unavailable);
    socket.addEventListener("message", event => {
      try {
        if (JSON.parse(event.data).ready !== true) throw new Error();
        rfb = new RFB(el("screen"), socket, { credentials: { password: auth.password } });
        auth.password = "";
        rfb.scaleViewport = true; rfb.clipViewport = true; rfb.resizeSession = false;
        rfb.addEventListener("connect", () => {
          connected = true;
          buttons.forEach(id => { el(id).disabled = false; });
          el("share").disabled = false;
          el("status").textContent = "Assistant paused · Keyboard to type · two fingers to scroll.";
          scheduleResize();
        });
        rfb.addEventListener("disconnect", unavailable);
        rfb.addEventListener("securityfailure", unavailable);
      } catch { auth.password = ""; disconnect(); unavailable(); }
    }, { once: true });
  } catch { unavailable(); }
}
function sendText(text) {
  for (const character of text) {
    const code = character.codePointAt(0);
    rfb?.sendKey(code <= 0xff ? code : 0x01000000 | code);
  }
}
el("keyboard").onclick = () => { if (document.activeElement === el("typing")) el("typing").blur(); else el("typing").focus(); };
for (const id of ["keyboard", "tab", "enter"]) el(id).onpointerdown = event => event.preventDefault();
el("typing").onfocus = () => { document.body.classList.add("typing"); el("keyboard").textContent = "Hide keys"; scheduleResize(); };
el("typing").onblur = () => { document.body.classList.remove("typing"); el("keyboard").textContent = "Keyboard"; scheduleResize(); };
el("typing").oninput = event => {
  if (event.isComposing) return;
  const next = el("typing").value;
  const oldChars = Array.from(previous), chars = Array.from(next);
  let common = 0; while (common < oldChars.length && common < chars.length && oldChars[common] === chars[common]) common++;
  for (let i = common; i < oldChars.length; i++) rfb?.sendKey(KeyTable.XK_BackSpace);
  sendText(chars.slice(common).join("")); previous = next;
  if (previous.length > 512) { el("typing").value = ""; previous = ""; }
};
el("typing").oncompositionend = () => el("typing").oninput({ isComposing: false });
el("typing").onkeydown = event => {
  if (event.key === "Enter") { event.preventDefault(); rfb?.sendKey(KeyTable.XK_Return); }
  if (event.key === "Backspace" && !el("typing").value) { event.preventDefault(); rfb?.sendKey(KeyTable.XK_BackSpace); }
};
el("tab").onclick = () => { rfb?.sendKey(KeyTable.XK_Tab); el("typing").value = ""; previous = ""; };
el("enter").onclick = () => rfb?.sendKey(KeyTable.XK_Return);
el("scale").onclick = () => { if (rfb) { rfb.scaleViewport = !rfb.scaleViewport; rfb.dragViewport = !rfb.scaleViewport; el("scale").textContent = rfb.scaleViewport ? "Zoom" : "Fit"; } };
el("desktop").onclick = () => {
  desktop = !desktop; el("desktop").textContent = desktop ? "Fit view" : "Desktop";
  if (rfb) { rfb.scaleViewport = true; rfb.dragViewport = false; el("scale").textContent = "Zoom"; }
  scheduleResize();
};
el("screen").addEventListener("pointerdown", () => { el("typing").value = ""; previous = ""; });
el("handback").onclick = () => { el("typing").blur(); el("finish").hidden = false; };
el("keep").onclick = () => { el("finish").hidden = true; };
el("reconnect").onclick = () => { disconnect(); void connect(); };
async function finish(mode) {
  if (finishing || finished) return;
  finishing = true;
  el("private").disabled = true; el("share").disabled = true; el("keep").disabled = true;
  try {
    await post("finish", { ticket, mode });
    finished = true; clearTimeout(expiry); disconnect(); el("finish").hidden = true;
    el("status").textContent = "Handed back. You can close this window.";
    app?.disableClosingConfirmation(); try { app?.close(); } catch {}
  } catch {
    el("finish").hidden = true;
    el("status").textContent = "Could not confirm handback. Reconnect or wait for expiry.";
    el("private").disabled = false; el("share").disabled = !connected; el("keep").disabled = false;
    el("reconnect").hidden = connected;
  } finally { finishing = false; }
}
el("private").onclick = () => void finish("private");
el("share").onclick = () => void finish("share");
void connect();
