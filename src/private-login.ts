import { PrivateCdp } from "./protected-browser.js";
import { LOGIN_FORM } from "./private-login-form.js";

export type LoginKind = "username" | "password" | "code";
export type LoginStep = { state: "fields"; fields: LoginKind[] } | { state: "manual" | "complete" };
export interface PrivateLoginRequest { session: string; pageUrl: string; resumeUrl: string; credentialItem?: string }
export function validatePrivateLoginRequest(request: PrivateLoginRequest) {
  const page = new URL(request.pageUrl), resume = new URL(request.resumeUrl);
  if (!/^[a-z0-9][a-z0-9._-]{0,62}$/.test(request.session) || request.pageUrl.length > 2000 || request.resumeUrl.length > 2000 ||
      page.protocol !== "https:" || page.username || page.password || resume.origin !== page.origin || resume.username || resume.password || resume.search || resume.hash ||
      (request.credentialItem !== undefined && (!request.credentialItem || request.credentialItem.length > 200 || /^-|[\0\r\n]/.test(request.credentialItem)))) throw new Error("Invalid private sign-in request");
}
export function validLoginValues(fields: LoginKind[], values: unknown): values is string[] {
  return Array.isArray(values) && values.length === fields.length && values.every((value, i) => typeof value === "string" && value.length > 0 && value.length <= 1024 &&
    (fields[i] !== "code" || /^[a-zA-Z0-9 -]{3,32}$/.test(value)));
}

/** Called under the takeover owner: the agent is disconnected and the gate held. */
export async function protectPrivateLogin(port: number, request: PrivateLoginRequest, signal: AbortSignal) {
  validatePrivateLoginRequest(request);
  const cdp = await PrivateCdp.connect(port), origin = new URL(request.pageUrl).origin;
  let targetId: string, sessionId: string, objectId: string | undefined;
  let step: LoginStep = { state: "manual" }, closed = false;
  let username: string | undefined;
  const used = new Set<LoginKind>();
  const order: LoginKind[] = ["username", "password", "code"];
  const allowed = (fields: LoginKind[]) => fields.every(kind => order.indexOf(kind) > Math.max(-1, ...Array.from(used, previous => order.indexOf(previous))));
  const pages = async () => (await cdp.request("Target.getTargets")).targetInfos.filter((t: any) => t.type === "page");
  const inspect = async (): Promise<LoginStep> => {
    if (closed || signal.aborted) throw new Error("Private sign-in ended");
    const tabs = await pages();
    if (tabs.length !== 1 || tabs[0].targetId !== targetId || new URL(tabs[0].url).origin !== origin) return { state: "manual" };
    const tree = (await cdp.request("Page.getFrameTree", {}, sessionId)).frameTree;
    const contextId = (await cdp.request("Page.createIsolatedWorld", { frameId: tree.frame.id, worldName: "bridge-private-login" }, sessionId)).executionContextId;
    const result = await cdp.request("Runtime.evaluate", { expression: `(${LOGIN_FORM})(${JSON.stringify(origin)},true)`, contextId }, sessionId);
    if (result.exceptionDetails) return { state: "manual" };
    if (!result.result?.objectId) return { state: used.size && result.result?.value === "complete" ? "complete" : "manual" };
    const binding = result.result.objectId;
    const kinds = (await cdp.request("Runtime.callFunctionOn", { objectId: binding, functionDeclaration: "function(){return this.kinds}", returnByValue: true }, sessionId)).result?.value;
    if (!Array.isArray(kinds) || !kinds.length || kinds.length > 3 || kinds.some(k => !["username", "password", "code"].includes(k))) return { state: "manual" };
    objectId = binding;
    return { state: "fields", fields: kinds };
  };
  try {
    const tabs = await pages();
    if (tabs.length !== 1 || tabs[0].url !== request.pageUrl) throw new Error();
    targetId = tabs[0].targetId;
    sessionId = (await cdp.request("Target.attachToTarget", { targetId, flatten: true })).sessionId;
    step = await inspect();
  } catch { cdp.close(); throw new Error("Private sign-in unavailable"); }
  return {
    state: () => step,
    hasUsername: () => username !== undefined,
    matchesUsername: (candidate: string) => username !== undefined && username === candidate,
    close() { closed = true; username = undefined; objectId = undefined; step = { state: "manual" }; cdp.close(); },
    async submit(values: string[]): Promise<LoginStep> {
      if (closed || signal.aborted || step.state !== "fields" || !validLoginValues(step.fields, values) || !allowed(step.fields)) throw new Error("Private sign-in rejected");
      const previous = [...step.fields]; previous.forEach(k => used.add(k));
      const usernameIndex = previous.indexOf("username");
      if (usernameIndex >= 0) username = values[usernameIndex];
      step = { state: "manual" };
      try {
        const tabs = await pages();
        if (closed || signal.aborted || tabs.length !== 1 || tabs[0].targetId !== targetId || new URL(tabs[0].url).origin !== origin) return step;
        // The bound closure checks document, input identities, destination and
        // action again immediately before every fill/click. Never retry a send.
        const filled = await cdp.request("Runtime.callFunctionOn", { objectId, functionDeclaration: "function(values){return this.fill(values)}",
          arguments: [{ value: values }], returnByValue: true, awaitPromise: true }, sessionId).catch(() => undefined);
        if (filled?.exceptionDetails || (filled?.result?.value !== true && filled?.result?.value !== "changed")) return step;
        objectId = undefined;
        const until = Date.now() + 8_000;
        while (!closed && !signal.aborted && Date.now() < until) {
          await new Promise(r => setTimeout(r, 200));
          const next = await inspect().catch(() => ({ state: "manual" as const }));
          if (next.state === "complete") return step = next;
          if (next.state === "fields" && allowed(next.fields)) return step = next;
        }
        return step;
      } catch { return step; }
      finally { values.fill(""); }
    },
  };
}
