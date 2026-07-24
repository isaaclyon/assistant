import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

interface ToolDefinition {
  name: string;
  promptGuidelines?: string[];
  execute: (
    id: string,
    params: Record<string, unknown>,
  ) => Promise<{ content: Array<{ type: string; text: string }>; details: unknown }>;
}

describe("places extension", () => {
  const originalStateDir = process.env.PI_TELEGRAM_BRIDGE_STATE_DIR;

  afterEach(() => {
    if (originalStateDir === undefined) delete process.env.PI_TELEGRAM_BRIDGE_STATE_DIR;
    else process.env.PI_TELEGRAM_BRIDGE_STATE_DIR = originalStateDir;
  });

  it("registers a lifecycle-owned tool with actionable results", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "places-extension-"));
    process.env.PI_TELEGRAM_BRIDGE_STATE_DIR = stateDir;
    const handlers = new Map<string, () => void>();
    let tool: ToolDefinition | undefined;
    const pi = {
      on(event: string, handler: () => void) {
        handlers.set(event, handler);
      },
      registerTool(definition: ToolDefinition) {
        tool = definition;
      },
    };
    const module = (await import(
      `${pathToFileURL(join(root, ".pi", "extensions", "places.ts")).href}?test=${Date.now()}`
    )) as { default: (api: unknown) => void };
    module.default(pi);

    expect(tool?.name).toBe("places");
    expect(tool?.promptGuidelines?.join(" ")).toContain("telegram_button");
    handlers.get("session_start")?.();
    const menu = await tool?.execute("call-1", { action: "menu" });
    expect(menu?.details).toMatchObject({
      ok: true,
      result: { categories: expect.arrayContaining([expect.objectContaining({ name: "Coffee" })]) },
    });
    const categoryId = (
      menu?.details as {
        result?: { categories?: Array<{ id?: string }> };
      }
    ).result?.categories?.[0]?.id;
    if (!categoryId) throw new Error("missing category");
    await tool?.execute("call-first", {
      action: "start",
      name: "Existing",
      category_id: categoryId,
      sentiment: "liked",
    });
    const comparison = await tool?.execute("call-second", {
      action: "start",
      name: "Candidate",
      category_id: categoryId,
      sentiment: "liked",
    });
    expect(comparison?.details).toMatchObject({
      ok: true,
      result: {
        kind: "compare",
        buttonActions: [
          expect.objectContaining({ label: "Candidate", prompt: expect.stringContaining("revision 0") }),
          expect.objectContaining({ label: "Existing", prompt: expect.stringContaining('winner "existing"') }),
          expect.objectContaining({ label: "Back" }),
          expect.objectContaining({ label: "Cancel", prompt: expect.stringContaining("confirm") }),
        ],
      },
    });
    const invalid = await tool?.execute("call-2", { action: "start" });
    expect(invalid?.details).toMatchObject({
      ok: false,
      error: { code: "INVALID_ACTION" },
    });
    handlers.get("session_shutdown")?.();
    const unavailable = await tool?.execute("call-3", { action: "menu" });
    expect(unavailable?.details).toMatchObject({
      ok: false,
      error: { code: "UNAVAILABLE" },
    });
    await rm(stateDir, { recursive: true, force: true });
  });
});
