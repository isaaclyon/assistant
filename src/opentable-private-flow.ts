import type { ProtectedInputRequest } from "./protected-browser.js";

/** A closed, site-owned flow. Neither scripts nor frame/step selectors come from Pi. */
export function openTableRequest(session: string): ProtectedInputRequest {
  return { session, flow: "opentable", pageUrl: "https://www.opentable.com/", resumeUrl: "https://www.opentable.com/",
    fields: [{ kind: "username", selector: "#email" }], submitSelector: 'button[data-test="continue-button"]' };
}

// Runs in the top page's isolated world. Only fixed states or a private remote
// object leave this function; no page text, values, URLs or application state do.
export const OPENTABLE_FORM = String.raw`function(operation) {
  const root = globalThis, topDocument = root.document;
  const unique = (doc, selector) => { const all = doc.querySelectorAll(selector); return all.length === 1 ? all[0] : null; };
  const frames = topDocument.querySelectorAll('iframe[title="Sign in"]'), frame = frames[0];
  if (frames.length > 1) return operation === 'state' ? 'unsupported' : null;
  if (root.location.href !== 'https://www.opentable.com/') return operation === 'state' ? 'unsupported' : null;
  if (!frame) return operation === 'state' ? (topDocument.readyState === 'complete' ? 'complete' : 'waiting') : null;
  let doc;
  try { doc = frame.contentDocument; } catch { return operation === 'state' ? 'unsupported' : null; }
  if (!doc || doc.location.origin !== root.location.origin) return operation === 'state' ? 'unsupported' : null;
  const page = doc.defaultView, url = doc.location.href;
  const definitions = {
    '/authenticate/start': ['username', '#email', 'button[data-test="continue-button"]'],
    '/authenticate/verify-medium': ['code', '#emailVerificationCode', 'button[type="submit"]'],
    '/authenticate/verify-email-2': ['code', '#emailVerificationCode', 'button[type="submit"]'],
    '/authenticate/verify-credentials-2': ['password', '#password', 'button[type="submit"]'],
  };
  const definition = definitions[doc.location.pathname];
  if (!definition) return operation === 'state' ? 'unsupported' : null;
  const [kind, selector, submitSelector] = definition;
  const input = unique(doc, selector), button = unique(doc, submitSelector), form = input?.form;
  const action = form?.getAttribute('action'), method = form?.getAttribute('method');
  const good = () => root.document === topDocument && root.location.href === 'https://www.opentable.com/' &&
    unique(topDocument, 'iframe[title="Sign in"]') === frame && frame.isConnected && frame.getClientRects().length > 0 &&
    frame.contentDocument === doc && doc.location.href === url && doc.location.origin === root.location.origin &&
    input instanceof page.HTMLInputElement && unique(doc, selector) === input && input.isConnected &&
    !input.disabled && !input.readOnly && input.getClientRects().length > 0 &&
    input.type === (kind === 'username' ? 'email' : kind === 'password' ? 'password' : 'text') &&
    form?.isConnected && input.form === form && form.getAttribute('action') === action && action === null &&
    form.getAttribute('method') === method && method === null && !form.getAttribute('target') &&
    button instanceof page.HTMLButtonElement && unique(doc, submitSelector) === button && button.isConnected &&
    button.form === form && button.type === 'submit' && button.getClientRects().length > 0 &&
    !['formaction', 'formmethod', 'formtarget'].some(attribute => button.hasAttribute(attribute));
  if (operation === 'state') return good() ? kind : 'waiting';
  if (operation !== kind || !good()) return null;
  const setter = Object.getOwnPropertyDescriptor(page.HTMLInputElement.prototype, 'value').set;
  return {
    emailCodeFor(email) {
      if (kind !== 'code' || !good() || typeof email !== 'string') return false;
      const expected = "we've sent a code to " + email.trim().toLowerCase() + ". enter the code to continue.";
      return Array.from(doc.querySelectorAll('p')).some(p => p.getClientRects().length > 0 &&
        p.innerText?.replace(/\s+/g, ' ').replace(/\u2019/g, "'").trim().toLowerCase() === expected);
    },
    async fill(values) {
      if (!good() || values.length !== 1) return false;
      setter.call(input, values[0]);
      input.dispatchEvent(new page.Event('input', { bubbles: true }));
      input.dispatchEvent(new page.Event('change', { bubbles: true }));
      // OpenTable automatically submits a complete six-digit code. Clicking its
      // button as well would send a second request. Other steps need a React render
      // before the initially disabled Continue button can be clicked once.
      if (kind === 'code') return true;
      for (let attempt = 0; attempt < 40; attempt++) {
        await new Promise(resolve => root.setTimeout(resolve, 25));
        if (!good()) return false;
        if (!button.disabled) { button.click(); return true; }
      }
      return false;
    },
  };
}`;
