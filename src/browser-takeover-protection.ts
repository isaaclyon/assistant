import { PrivateCdp } from "./protected-browser.js";
import { validTakeoverViewport, type TakeoverViewport } from "./browser-takeover-viewport.js";

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
  let pageId: string, pageSession: string, windowId: number;
  let originalBounds: { left: number; top: number; width: number; height: number; windowState: string };
  let resized = false;
  try {
    let targets = (await cdp.request("Target.getTargets")).targetInfos;
    const deadline = Date.now() + 3_000;
    while (targets.some((t: any) => t.attached) && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 100)); targets = (await cdp.request("Target.getTargets")).targetInfos;
    }
    const pages = targets.filter((t: any) => t.type === "page");
    if (pages.length !== 1 || new URL(pages[0].url).origin !== new URL(request.resumeUrl).origin || targets.some((t: any) => t.attached)) throw new Error();
    const sessionId = (await cdp.request("Target.attachToTarget", { targetId: pages[0].targetId, flatten: true })).sessionId;
    pageId = pages[0].targetId; pageSession = sessionId;
    ({ windowId, bounds: originalBounds } = await cdp.request("Browser.getWindowForTarget", { targetId: pageId }));
    await cdp.request("Page.bringToFront", {}, sessionId);
  } catch { cdp.close(); throw new Error("Takeover requires one unattached HTTPS tab matching the resume site"); }
  return {
    close() { cdp.close(); },
    async resize(viewport: TakeoverViewport) {
      if (!validTakeoverViewport(viewport)) throw new Error("Invalid viewer size");
      resized = true;
      await cdp.request("Emulation.clearDeviceMetricsOverride", {}, pageSession);
      const width = viewport.desktop ? 1920 : Math.max(500, viewport.width);
      const scale = viewport.desktop ? 1 : width / viewport.width;
      const height = viewport.desktop ? 1080 : Math.min(1080, Math.round(viewport.height * scale));
      await cdp.request("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
      await cdp.request("Browser.setWindowBounds", { windowId, bounds: { left: 0, top: 0, width, height } });
      const { bounds } = await cdp.request("Browser.getWindowBounds", { windowId });
      if (!viewport.desktop) {
        // Chrome has a 500-DIP minimum window width. Scale the page inside it so
        // a CSS pixel still occupies one CSS pixel in the fitted phone viewer.
        // Layout metrics contain only geometry; no DOM, frame or input is read.
        const metrics = await cdp.request("Page.getLayoutMetrics", {}, pageSession);
        await cdp.request("Emulation.setDeviceMetricsOverride", {
          width: viewport.width, height: Math.max(1, Math.floor(metrics.layoutViewport.clientHeight / scale)),
          deviceScaleFactor: 1, mobile: false, scale,
        }, pageSession);
      }
      return { width: bounds.width as number, height: bounds.height as number };
    },
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
        } else keep = (await cdp.request("Target.createTarget", { url: "about:blank" })).targetId;
        // Capture the user's shared page first: restoring a window can move focus.
        if (resized) {
          const targets = (await cdp.request("Target.getTargets")).targetInfos;
          if (targets.some((t: any) => t.targetId === pageId)) {
            await cdp.request("Emulation.clearDeviceMetricsOverride", {}, pageSession);
            await cdp.request("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
            const { windowState, ...geometry } = originalBounds;
            await cdp.request("Browser.setWindowBounds", { windowId, bounds: geometry });
            if (windowState !== "normal") await cdp.request("Browser.setWindowBounds", { windowId, bounds: { windowState } });
          }
        }
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
        } else {
          await cdp.request("Page.bringToFront", {}, keepSession);
          // Discard buffered activity after geometry/focus restoration too.
          await cdp.request("Runtime.discardConsoleEntries", {}, keepSession);
          await cdp.request("Log.clear", {}, keepSession);
        }
      } finally { cdp.close(); }
    },
  };
}
