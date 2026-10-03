const app = window.Telegram?.WebApp;
const requestId = new URLSearchParams(location.hash.slice(1)).get("request");
const initData = app?.initData ?? "";
const form = document.querySelector("#input"), fields = document.querySelector("#fields");
const status = document.querySelector("#status"), submit = document.querySelector("#submit"), cancel = document.querySelector("#cancel");
let inputs = [], pending = false;
const disable = () => { pending = false; submit.disabled = true; cancel.disabled = true; inputs.forEach((input) => { input.disabled = true; }); };
const clear = () => inputs.forEach((input) => { input.value = ""; });
async function request(action, extra = {}) {
  const response = await fetch(`/api/${action}`, { method: "POST", credentials: "omit", cache: "no-store",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId, initData, ...extra }), signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error("This request could not be completed. Return to chat and ask for a fresh form; do not resend values in chat.");
  return response.json();
}
form.addEventListener("submit", async (event) => {
  event.preventDefault(); if (!pending) return;
  const values = inputs.map((input) => input.value);
  disable(); clear(); status.textContent = "Submitting to the website…";
  try {
    await request("submit", { values });
    status.textContent = "Sign-in form submitted. Return to chat while the assistant checks the result.";
  } catch (error) { status.textContent = error.message; }
  finally { values.fill(""); app?.disableClosingConfirmation(); }
});
cancel.addEventListener("click", async () => {
  if (!pending) return; disable(); clear();
  try { await request("cancel"); status.textContent = "Cancelled."; }
  catch (error) { status.textContent = error.message; }
  app?.disableClosingConfirmation();
});
window.addEventListener("pagehide", clear);
app?.ready(); app?.expand();
if (!initData || !requestId) {
  status.textContent = "Open the button in the original private Telegram chat with Tailscale connected.";
} else {
  request("auth").then((result) => {
    document.querySelector("#destination").textContent = `Website: ${result.origin}`;
    if (result.status !== "pending") { status.textContent = "This request has already ended. Return to chat."; return; }
    for (const kind of result.fields) {
      const label = document.createElement("label"), input = document.createElement("input");
      input.id = `field-${inputs.length}`; label.htmlFor = input.id;
      label.textContent = kind === "password" ? "Password" : kind === "code" ? "Verification code" : "Username or email";
      input.type = kind === "username" ? "text" : "password"; input.autocomplete = "off";
      input.required = true; input.maxLength = kind === "code" ? 32 : 1024;
      fields.append(label, input); inputs.push(input);
    }
    pending = true; submit.disabled = false; cancel.disabled = false; app?.enableClosingConfirmation();
  }).catch((error) => { status.textContent = error.message; });
}
