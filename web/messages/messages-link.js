const PHONE_FORMATTING = /[\s().-]/g;
const PHONE_NUMBER = /^\+?[1-9][0-9]{6,14}$/;

export function parseMessageFragment(fragment) {
  const params = new URLSearchParams(String(fragment).replace(/^#/, ""));
  return {
    to: params.get("to") ?? "",
    label: params.get("label") ?? "",
    body: params.get("body") ?? "",
  };
}

export function normalizePhoneNumber(value) {
  const input = String(value).trim();
  if (!/^[+0-9\s().-]+$/.test(input)) return null;
  const normalized = input.replace(PHONE_FORMATTING, "");
  return PHONE_NUMBER.test(normalized) ? normalized : null;
}

export function buildSmsUrl(normalizedPhoneNumber, body) {
  if (!PHONE_NUMBER.test(normalizedPhoneNumber)) {
    throw new Error("A valid normalized phone number is required");
  }
  return `sms:${normalizedPhoneNumber}&body=${encodeURIComponent(String(body))}`;
}

export function initializeMessagePage(document, fragment) {
  const proposed = parseMessageFragment(fragment);
  const phoneNumber = normalizePhoneNumber(proposed.to);
  const message = document.querySelector("#message");
  const open = document.querySelector("#open");
  const error = document.querySelector("#error");

  message.value = proposed.body.slice(0, 5000);
  if (!phoneNumber) {
    error.hidden = false;
    open.hidden = true;
    open.disabled = true;
    return;
  }

  const label = proposed.label.trim().slice(0, 80) || "recipient";
  open.textContent = `Open Messages for ${label}`;
  open.hidden = false;
  open.disabled = false;
  open.addEventListener("click", () => {
    // A location change happens only in this user-generated click handler.
    window.location.href = buildSmsUrl(phoneNumber, message.value);
  });
}

if (typeof document !== "undefined") {
  initializeMessagePage(document, window.location.hash);
}
