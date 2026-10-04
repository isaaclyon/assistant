import { expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ request: vi.fn(), close: vi.fn() }));
vi.mock("../src/protected-browser.js", () => ({ PrivateCdp: { connect: async () => f } }));
import { protectBrowserTakeover } from "../src/browser-takeover-protection.js";

it("selects the human's focused popup before restoring window geometry can change focus", async () => {
  let pages = ["initial"], focused = "initial";
  const removed: string[] = [];
  f.request.mockImplementation(async (method: string, params: any = {}, session?: string) => {
    if (method === "Target.getTargets") return { targetInfos: pages.map(id => ({ targetId: id, type: "page", url: "https://example.com/", attached: false })) };
    if (method === "Target.attachToTarget") return { sessionId: params.targetId };
    if (method === "Browser.getWindowForTarget") return { windowId: 1, bounds: { left: 10, top: 10, width: 900, height: 900, windowState: "normal" } };
    if (method === "Browser.getWindowBounds") return { bounds: { width: 500, height: 800 } };
    if (method === "Page.getLayoutMetrics") return { layoutViewport: { clientHeight: 713 } };
    if (method === "Browser.setWindowBounds") focused = "initial";
    if (method === "Page.bringToFront") focused = session!;
    if (method === "Runtime.evaluate") return { result: { value: { visible: true, focused: session === focused } } };
    if (method === "Target.closeTarget") { removed.push(params.targetId); pages = pages.filter(id => id !== params.targetId); return { success: true }; }
    return {};
  });
  const page = await protectBrowserTakeover(1234, { session: "test", resumeUrl: "https://example.com/" });
  await page.resize({ width: 390, height: 600, desktop: false });
  pages.push("popup"); focused = "popup";
  await page.finish("share");
  expect(removed).toEqual(["initial"]);
  expect(pages).toEqual(["popup"]);
  expect(focused).toBe("popup");
  expect(f.close).toHaveBeenCalledOnce();
});
