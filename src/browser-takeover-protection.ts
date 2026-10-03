import { PrivateCdp } from "./protected-browser.js";

export interface TakeoverRequest { session: string; resumeUrl: string }
export function validateTakeoverRequest(request: TakeoverRequest) {
  if (!/^[a-z0-9][a-z0-9._-]{0,62}$/.test(request.session) || request.resumeUrl.length > 2_000) throw new Error("Invalid takeover request");
  const url = new URL(request.resumeUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("Use a clean HTTPS resume URL");
}

/** Caller holds the stock-browser mutex and has disconnected its observer. */
export async function protectBrowserTakeover(port: number, request: TakeoverRequest) {
  validateTakeoverRequest(request);
  const cdp = await PrivateCdp.connect(port);
  try {
    let targets = (await cdp.request("Target.getTargets")).targetInfos;
    const deadline = Date.now() + 3_000;
    while (targets.some((t: any) => t.attached) && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 100)); targets = (await cdp.request("Target.getTargets")).targetInfos;
    }
    const pages = targets.filter((t: any) => t.type === "page");
    if (pages.length !== 1 || new URL(pages[0].url).origin !== new URL(request.resumeUrl).origin || targets.some((t: any) => t.attached)) throw new Error();
    const sessionId = (await cdp.request("Target.attachToTarget", { targetId: pages[0].targetId, flatten: true })).sessionId;
    await cdp.request("Page.bringToFront", {}, sessionId);
    await cdp.request("Target.detachFromTarget", { sessionId });
  } catch { cdp.close(); throw new Error("Takeover requires one unattached HTTPS tab matching the resume site"); }
  return {
    close() { cdp.close(); },
    async finish(mode: "private" | "share") {
      try {
        let keep: string | undefined, keepSession: string | undefined;
        if (mode === "share") {
          const targets = (await cdp.request("Target.getTargets")).targetInfos;
          const visiblePages: Array<{ target: string; session: string; focused: boolean }> = [];
          for (const target of targets.filter((t: any) => t.type === "page")) {
            if (!target.url.startsWith("https://")) continue;
            const sid = (await cdp.request("Target.attachToTarget", { targetId: target.targetId, flatten: true })).sessionId;
            const visible = await cdp.request("Runtime.evaluate", { expression: "({visible:document.visibilityState === 'visible',focused:document.hasFocus()})", returnByValue: true }, sid);
            if (visible.result?.value?.visible === true) visiblePages.push({ target: target.targetId, session: sid, focused: visible.result.value.focused === true });
          }
          const focused = visiblePages.filter(page => page.focused);
          const selected = focused.length === 1 ? focused[0] : visiblePages.length === 1 ? visiblePages[0] : undefined;
          keep = selected?.target; keepSession = selected?.session;
          if (!keep || !keepSession) throw new Error();
          // Share the selected page, not buffered console activity from the takeover.
          await cdp.request("Runtime.discardConsoleEntries", {}, keepSession);
          await cdp.request("Log.clear", {}, keepSession);
        } else keep = (await cdp.request("Target.createTarget", { url: "about:blank" })).targetId;
        const targets = (await cdp.request("Target.getTargets")).targetInfos;
        for (const target of targets.filter((t: any) => t.type === "page" && t.targetId !== keep)) {
          if ((await cdp.request("Target.closeTarget", { targetId: target.targetId })).success !== true) throw new Error();
        }
        const deadline = Date.now() + 3_000;
        while (true) {
          const remaining = (await cdp.request("Target.getTargets")).targetInfos.filter((t: any) => t.type === "page");
          if (remaining.length === 1 && remaining[0].targetId === keep) break;
          if (Date.now() >= deadline) throw new Error();
          await new Promise(r => setTimeout(r, 100));
        }
        if (mode === "private") {
          const sid = (await cdp.request("Target.attachToTarget", { targetId: keep, flatten: true })).sessionId;
          if ((await cdp.request("Page.navigate", { url: request.resumeUrl }, sid)).errorText) throw new Error();
        }
      } finally { cdp.close(); }
    },
  };
}
