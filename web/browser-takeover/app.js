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
let previous = "";
const buttons = ["keyboard", "tab", "enter", "scale", "handback"];
app?.ready(); app?.expand(); app?.enableClosingConfirmation(); app?.disableVerticalSwipes?.();
async function post(path, extra = {}) {
  const response = await fetch(`/api/${path}`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ requestId, initData, ...extra }), signal: AbortSignal.timeout(10_000) });
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
async function connect() {
  el("reconnect").hidden = true; el("status").textContent = "Connecting securely…";
  try {
    if (!requestId || !initData) throw new Error();
    const auth = await post("auth"); ticket = auth.ticket;
    el("resume").textContent = auth.resumeUrl;
    clearTimeout(expiry);
    expiry = setTimeout(() => { finished = true; disconnect(); el("finish").hidden = true; el("reconnect").hidden = true; buttons.forEach(id => { el(id).disabled = true; }); el("status").textContent = "Takeover expired. The private view is closed."; }, Math.max(0, auth.expiresAt - Date.now()));
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
          el("status").textContent = "Assistant paused. Tap a field; use Keyboard or Zoom. Hand back when done.";
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
el("keyboard").onclick = () => { el("typing").focus(); };
el("typing").oninput = event => {
  if (event.isComposing) return;
  const next = el("typing").value;
  const oldChars = Array.from(previous), chars = Array.from(next);
  let common = 0; while (common < oldChars.length && common < chars.length && oldChars[common] === chars[common]) common++;
  for (let i = common; i < oldChars.length; i++) rfb?.sendKey(KeyTable.XK_BackSpace);
  sendText(chars.slice(common).join("")); previous = next;
  if (previous.length > 512) { el("typing").value = ""; previous = ""; }
};
el("typing").onkeydown = event => {
  if (event.key === "Enter") { event.preventDefault(); rfb?.sendKey(KeyTable.XK_Return); }
  if (event.key === "Backspace" && !el("typing").value) { event.preventDefault(); rfb?.sendKey(KeyTable.XK_BackSpace); }
};
el("tab").onclick = () => { rfb?.sendKey(KeyTable.XK_Tab); el("typing").value = ""; previous = ""; };
el("enter").onclick = () => rfb?.sendKey(KeyTable.XK_Return);
el("scale").onclick = () => { if (rfb) { rfb.scaleViewport = !rfb.scaleViewport; rfb.dragViewport = !rfb.scaleViewport; el("scale").textContent = rfb.scaleViewport ? "Zoom" : "Fit"; } };
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
