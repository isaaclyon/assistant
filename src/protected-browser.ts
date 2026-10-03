/** Narrow CDP client. Protocol errors, events, URLs, and page values never escape. */
export class PrivateCdp {
  private sequence = 0;
  private pending = new Map<number, { resolve(value: any): void; reject(): void; timer: ReturnType<typeof setTimeout> }>();
  private constructor(private socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string" || event.data.length > 2_000_000) { this.close(); return; }
      try {
        const response = JSON.parse(event.data);
        const request = this.pending.get(response.id);
        if (!request) return; // Never retain console, network, or other unsolicited events.
        clearTimeout(request.timer); this.pending.delete(response.id);
        if (response.error) request.reject(); else request.resolve(response.result);
      } catch { this.close(); }
    });
    socket.addEventListener("close", () => this.rejectAll());
    socket.addEventListener("error", () => this.rejectAll());
  }
  static async connect(port: number) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Protected browser unavailable");
    const info = await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(3_000) })).json() as { webSocketDebuggerUrl?: string };
    const url = new URL(info.webSocketDebuggerUrl ?? "");
    if (url.protocol !== "ws:" || url.hostname !== "127.0.0.1" || url.port !== String(port) || !url.pathname.startsWith("/devtools/browser/")) throw new Error("Protected browser unavailable");
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error("Protected browser unavailable")); }, 3_000);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Protected browser unavailable")); }, { once: true });
    });
    return new PrivateCdp(socket);
  }
  request(method: string, params: object = {}, sessionId?: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const fail = () => reject(new Error("Protected browser operation failed"));
      const timer = setTimeout(() => { this.pending.delete(id); fail(); }, 5_000);
      this.pending.set(id, { resolve, reject: fail, timer });
      try { this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
      catch { clearTimeout(timer); this.pending.delete(id); fail(); }
    });
  }
  private rejectAll() {
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(); }
    this.pending.clear();
  }
  close() { this.rejectAll(); this.socket.close(); }
}

export interface ProtectedInputRequest {
  session: string;
  pageUrl: string;
  resumeUrl: string;
  fields: Array<{ kind: "username" | "password" | "code"; selector: string }>;
  submitSelector: string;
}

export function validateProtectedRequest(request: ProtectedInputRequest): void {
  if (!/^[a-z0-9][a-z0-9._-]{0,62}$/.test(request.session)) throw new Error("Invalid browser session");
  const page = new URL(request.pageUrl), resume = new URL(request.resumeUrl);
  if (page.protocol !== "https:" || page.username || page.password || resume.origin !== page.origin || resume.username || resume.password || resume.search || resume.hash) throw new Error("Use HTTPS and a same-origin resume URL without query or fragment");
  if (request.fields.length < 1 || request.fields.length > 3 || new Set(request.fields.map((field) => field.kind)).size !== request.fields.length ||
      new Set(request.fields.map((field) => field.selector)).size !== request.fields.length ||
      request.fields.some((field) => !["username", "password", "code"].includes(field.kind)) ||
      !request.fields.some((field) => field.kind !== "username") ||
      [...request.fields.map((field) => field.selector), request.submitSelector].some((selector) => !selector || selector.length > 300)) throw new Error("Invalid protected fields");
}

export function validProtectedValues(request: ProtectedInputRequest, values: unknown): values is string[] {
  return Array.isArray(values) && values.length === request.fields.length && values.every((value, index) =>
    typeof value === "string" && value.length > 0 && value.length <= 1024 &&
    (request.fields[index]!.kind !== "code" || /^[a-zA-Z0-9 -]{3,32}$/.test(value)));
}

// This function runs in a Chrome isolated world, never in the model's context.
// Capture exact DOM objects: a replacement field or document invalidates the request.
const BIND_FORM = String.raw`function(spec) {
  const page = globalThis;
  const document = page.document;
  const unique = (selector) => { const matches = document.querySelectorAll(selector); return matches.length === 1 ? matches[0] : null; };
  const inputs = spec.fields.map((field) => unique(field.selector));
  const button = unique(spec.submitSelector);
  const form = button?.form;
  const action = form?.action;
  const overrideAction = button?.getAttribute('formaction');
  const overrideMethod = button?.getAttribute('formmethod');
  const good = () => page.location.href === spec.pageUrl && form?.isConnected && form.method.toLowerCase() === "post" &&
    new URL(form.action).origin === page.location.origin && form.action === action && button?.isConnected && !button.disabled &&
    button.getAttribute('formaction') === overrideAction && button.getAttribute('formmethod') === overrideMethod &&
    (overrideAction === null || new URL(button.formAction).origin === page.location.origin) && (overrideMethod === null || overrideMethod.toLowerCase() === 'post') &&
    unique(spec.submitSelector) === button && button.form === form &&
    inputs.every((input, index) => input instanceof page.HTMLInputElement && input.isConnected && input.form === form && !input.disabled && !input.readOnly &&
      unique(spec.fields[index].selector) === input && input.getClientRects().length > 0 &&
      (spec.fields[index].kind === "password" ? input.type === "password" : ["text", "email", "tel", "number", "password"].includes(input.type)));
  if (!good()) return null;
  const setter = Object.getOwnPropertyDescriptor(page.HTMLInputElement.prototype, "value").set;
  return {
    check: good,
    fill(values) {
      if (!good()) return false;
      for (let index = 0; index < inputs.length; index++) {
        if (!good()) return false;
        setter.call(inputs[index], values[index]);
        inputs[index].dispatchEvent(new page.Event("input", { bubbles: true }));
        inputs[index].dispatchEvent(new page.Event("change", { bubbles: true }));
      }
      if (!good()) return false;
      button.click();
      return true;
    },
  };
}`;

/** Caller must hold the stock-Chrome lease and disconnect agent-browser first. */
export async function protectBrowserPage(port: number, request: ProtectedInputRequest) {
  validateProtectedRequest(request);
  const cdp = await PrivateCdp.connect(port);
  let targetId: string | undefined;
  let sessionId: string | undefined;
  let objectId: string | undefined;
  let touched = false;
  let consumed = false;
  try {
    let targets = (await cdp.request("Target.getTargets")).targetInfos;
    // The CLI can acknowledge close before Chrome processes websocket detachment.
    const detachDeadline = Date.now() + 3_000;
    while (targets.some((target: any) => target.attached) && Date.now() < detachDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      targets = (await cdp.request("Target.getTargets")).targetInfos;
    }
    const pages = targets.filter((target: any) => target.type === "page");
    // One tab, no other debugger: avoid background-tab observers and cached traces.
    if (pages.length !== 1 || pages[0].url !== request.pageUrl || targets.some((target: any) => target.attached)) throw new Error();
    targetId = pages[0].targetId;
    sessionId = (await cdp.request("Target.attachToTarget", { targetId, flatten: true })).sessionId;
    const frame = (await cdp.request("Page.getFrameTree", {}, sessionId)).frameTree.frame;
    const context = (await cdp.request("Page.createIsolatedWorld", { frameId: frame.id, worldName: "bridge-protected-input" }, sessionId)).executionContextId;
    const result = await cdp.request("Runtime.evaluate", { expression: `(${BIND_FORM})(${JSON.stringify(request)})`, contextId: context }, sessionId);
    objectId = result.result?.objectId;
    if (!objectId || result.exceptionDetails) throw new Error();
  } catch {
    cdp.close();
    throw new Error("Protected input requires one unattached HTTPS tab with a supported same-origin POST form");
  }
  return {
    async submit(values: string[]) {
      if (consumed || !validProtectedValues(request, values)) throw new Error("Protected input rejected");
      consumed = true;
      // Mark before the command: an uncertain send may already have changed the DOM.
      touched = true;
      const response = await cdp.request("Runtime.callFunctionOn", {
        objectId, functionDeclaration: "function(values) { return this.fill(values); }",
        arguments: [{ value: values }], returnByValue: true,
      }, sessionId);
      if (response.exceptionDetails || response.result?.value !== true) throw new Error("Protected page changed; request new input");
      // Allow the POST/navigation to finish before closing its response document.
      // No response body, console, network, or landing URL enters a tool result.
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        const state = await cdp.request("Runtime.evaluate", {
          expression: `document.readyState === 'complete' && location.href !== ${JSON.stringify(request.pageUrl)}`,
          returnByValue: true,
        }, sessionId).catch(() => undefined);
        if (state?.result?.value === true) break;
      }
    },
    async close() {
      try {
        if (touched) {
          // Destroy the entire sensitive document rather than guessing which fields
          // or page scripts might still contain a value. Resume at an explicit URL.
          // Keep one blank window alive: headed Chrome exits when its last tab closes.
          const cleanTarget = (await cdp.request("Target.createTarget", { url: "about:blank" })).targetId;
          const targets = (await cdp.request("Target.getTargets")).targetInfos;
          for (const target of targets.filter((target: any) => target.type === "page" && target.targetId !== cleanTarget)) {
            const closed = await cdp.request("Target.closeTarget", { targetId: target.targetId });
            if (closed.success !== true) throw new Error();
          }
          let remaining = (await cdp.request("Target.getTargets")).targetInfos.filter((target: any) => target.type === "page");
          const closeDeadline = Date.now() + 3_000;
          while ((remaining.length !== 1 || remaining[0].targetId !== cleanTarget) && Date.now() < closeDeadline) {
            await new Promise((resolve) => setTimeout(resolve, 100));
            remaining = (await cdp.request("Target.getTargets")).targetInfos.filter((target: any) => target.type === "page");
          }
          if (remaining.length !== 1 || remaining[0].targetId !== cleanTarget) throw new Error();
          const cleanSession = (await cdp.request("Target.attachToTarget", { targetId: cleanTarget, flatten: true })).sessionId;
          const navigation = await cdp.request("Page.navigate", { url: request.resumeUrl }, cleanSession);
          if (navigation.errorText) throw new Error();
        }
      } finally { cdp.close(); }
    },
  };
}
