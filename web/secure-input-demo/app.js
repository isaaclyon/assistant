/* No analytics, storage, secret-bearing URLs, or Telegram sendData calls. */
const app = window.Telegram?.WebApp;
const status = document.querySelector("#status");
const form = document.querySelector("#demo");
const code = document.querySelector("#code");
const submit = document.querySelector("#submit");
const cancel = document.querySelector("#cancel");
const requestId = new URLSearchParams(location.hash.slice(1)).get("request");
const initData = app?.initData ?? "";
let pending = false;

function enable(enabled) {
  code.disabled = !enabled;
  submit.disabled = !enabled;
  cancel.disabled = !enabled;
}
function show(result) {
  pending = result.status === "pending";
  enable(pending);
  status.textContent = pending ? "Telegram identity verified. Enter the sample code below." :
    result.status === "completed" ? "Success! Your identity was verified and the sample submission was accepted." :
    "Cancelled. No code was submitted.";
  if (!pending) { code.value = ""; app?.disableClosingConfirmation(); }
}
async function request(action, extra = {}) {
  const response = await fetch(`/api/${action}`, {
    method: "POST", credentials: "omit", cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ requestId, initData, ...extra }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(response.status === 410 ? "This demo has expired. Ask for a new form." :
    response.status === 403 ? "Identity verification failed. Open the button in the original private bot chat." :
    "The request could not be accepted. Reopen the original button to check its status.");
  return response.json();
}
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!pending) return;
  if (code.value !== "123456") { status.textContent = "Use only the sample code 123456."; return; }
  enable(false);
  try { show(await request("submit", { code: "123456" })); }
  catch (error) { status.textContent = error.message; }
});
cancel.addEventListener("click", async () => {
  if (!pending) return;
  enable(false);
  code.value = "";
  try { show(await request("cancel")); }
  catch (error) { status.textContent = error.message; }
});
app?.ready();
app?.expand();
if (!initData || !requestId) {
  status.textContent = "Open this form using the button in the private Telegram bot chat. Keep Tailscale connected.";
} else {
  app?.enableClosingConfirmation();
  request("auth").then(show).catch((error) => { status.textContent = error.message; });
}
