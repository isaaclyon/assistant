import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const resourceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const roots: string[] = [];
const originalEnv = {
  stateDir: process.env.PI_TELEGRAM_BRIDGE_STATE_DIR,
  instanceId: process.env.PI_TELEGRAM_BRIDGE_INSTANCE_ID,
  principal: process.env.PI_TELEGRAM_PRINCIPAL,
  memoryView: process.env.PI_TELEGRAM_MEMORY_VIEW,
  memoryDir: process.env.PI_TELEGRAM_MEMORY_DIR,
  sessionDir: process.env.PI_TELEGRAM_BRIDGE_SESSION_DIR,
  sessionRoots: process.env.PI_TELEGRAM_BRIDGE_SESSION_ROOTS,
  resourceRoot: process.env.PI_TELEGRAM_BRIDGE_RESOURCE_ROOT,
};

interface ToolDefinition {
  name: string;
  promptGuidelines?: string[];
  execute(
    id: string,
    params: Record<string, unknown>,
  ): Promise<{ content: Array<{ type: string; text: string }>; details: unknown }>;
}

afterEach(async () => {
  for (const [key, value] of Object.entries({
    PI_TELEGRAM_BRIDGE_STATE_DIR: originalEnv.stateDir,
    PI_TELEGRAM_BRIDGE_INSTANCE_ID: originalEnv.instanceId,
    PI_TELEGRAM_PRINCIPAL: originalEnv.principal,
    PI_TELEGRAM_MEMORY_VIEW: originalEnv.memoryView,
    PI_TELEGRAM_MEMORY_DIR: originalEnv.memoryDir,
    PI_TELEGRAM_BRIDGE_SESSION_DIR: originalEnv.sessionDir,
    PI_TELEGRAM_BRIDGE_SESSION_ROOTS: originalEnv.sessionRoots,
    PI_TELEGRAM_BRIDGE_RESOURCE_ROOT: originalEnv.resourceRoot,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("search extension", () => {
  it("bounds interactive refreshes and distinguishes timeout from failure", async () => {
    const module = await import(
      `${pathToFileURL(join(resourceRoot, ".pi", "extensions", "search.ts")).href}?budget=${Date.now()}`
    ) as {
      settleRefreshWithin<T>(
        promise: Promise<T>,
        timeoutMs: number,
      ): Promise<{ status: string; value?: T }>;
    };

    await expect(module.settleRefreshWithin(Promise.resolve("ok"), 50)).resolves.toEqual({
      status: "fresh",
      value: "ok",
    });
    await expect(
      module.settleRefreshWithin(Promise.reject(new Error("private failure")), 50),
    ).resolves.toEqual({ status: "failed" });
    await expect(
      module.settleRefreshWithin(new Promise(() => undefined), 5),
    ).resolves.toEqual({ status: "timeout" });
  });

  it("registers separate memory/session tools and supersedes scan search in its guidance", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "search-extension-"));
    roots.push(sandbox);
    const vault = join(sandbox, "vault");
    const sessions = join(sandbox, "sessions");
    const foreignSessions = join(sandbox, "foreign-sessions");
    await mkdir(sessions, { recursive: true });
    await mkdir(foreignSessions, { recursive: true });
    const storeModule = await import(pathToFileURL(join(
      resourceRoot,
      ".pi",
      "skills",
      "personal-memory",
      "scripts",
      "store.mjs",
    )).href) as {
      createMarkdownMemoryStore(options: Record<string, unknown>): {
        add(request: Record<string, unknown>): Promise<unknown>;
      };
    };
    await storeModule.createMarkdownMemoryStore({
      root: vault,
      principal: "isaac",
      memoryView: "owner-and-household",
      randomUUID: () => "11111111-1111-4111-8111-111111111111",
      now: () => new Date("2026-07-25T12:00:00.000Z"),
    }).add({
      type: "preference",
      title: "Coffee preference",
      body: "Light roast",
    });
    await writeFile(join(sessions, "session-1.jsonl"), [
      JSON.stringify({
        type: "session",
        version: 3,
        id: "session-1",
        timestamp: "2026-07-25T12:00:00.000Z",
      }),
      JSON.stringify({
        type: "message",
        id: "entry-1",
        timestamp: "2026-07-25T12:01:00.000Z",
        message: { role: "user", content: "We discussed grinder calibration" },
      }),
      JSON.stringify({
        type: "message",
        id: "entry-2",
        timestamp: "2026-07-25T12:02:00.000Z",
        message: { role: "toolResult", content: "tool-only-memory-result" },
      }),
      "",
    ].join("\n"));
    await writeFile(join(foreignSessions, "foreign.jsonl"), [
      JSON.stringify({
        type: "session",
        version: 3,
        id: "foreign-session",
        timestamp: "2026-07-25T12:00:00.000Z",
      }),
      JSON.stringify({
        type: "message",
        id: "foreign-entry",
        timestamp: "2026-07-25T12:01:00.000Z",
        message: { role: "user", content: "foreign-private-needle" },
      }),
      "",
    ].join("\n"));
    process.env.PI_TELEGRAM_BRIDGE_STATE_DIR = join(sandbox, "state");
    process.env.PI_TELEGRAM_BRIDGE_INSTANCE_ID = "isaac";
    process.env.PI_TELEGRAM_PRINCIPAL = "isaac";
    process.env.PI_TELEGRAM_MEMORY_VIEW = "owner-and-household";
    process.env.PI_TELEGRAM_MEMORY_DIR = vault;
    process.env.PI_TELEGRAM_BRIDGE_SESSION_DIR = sessions;
    process.env.PI_TELEGRAM_BRIDGE_SESSION_ROOTS = JSON.stringify([
      sessions,
      foreignSessions,
    ]);
    process.env.PI_TELEGRAM_BRIDGE_RESOURCE_ROOT = resourceRoot;

    const handlers = new Map<string, () => void>();
    const tools = new Map<string, ToolDefinition>();
    const pi = {
      on(event: string, handler: () => void) {
        handlers.set(event, handler);
      },
      registerTool(tool: ToolDefinition) {
        tools.set(tool.name, tool);
      },
    };
    const module = await import(
      `${pathToFileURL(join(resourceRoot, ".pi", "extensions", "search.ts")).href}?test=${Date.now()}`
    ) as { default(api: unknown): void };
    module.default(pi);
    handlers.get("session_start")?.();

    expect([...tools.keys()].sort()).toEqual(["memory_search", "search_index", "session_search"]);
    expect(tools.get("memory_search")?.promptGuidelines?.join(" ")).toContain(
      "preferred memory retrieval",
    );
    const memory = await tools.get("memory_search")!.execute("memory-1", {
      query: "coffee",
      limit: 5,
    });
    const session = await tools.get("session_search")!.execute("session-1", {
      query: "grinder",
      limit: 5,
    });
    const defaultRoles = await tools.get("session_search")!.execute("session-default-roles", {
      query: "tool-only-memory-result",
      limit: 5,
    });
    const explicitToolResult = await tools.get("session_search")!.execute("session-tool-result", {
      query: "tool-only-memory-result",
      roles: ["toolResult"],
      limit: 5,
    });
    const foreign = await tools.get("session_search")!.execute("session-foreign", {
      query: "foreign-private-needle",
      limit: 5,
    });
    const status = await tools.get("search_index")!.execute("status-1", {
      operation: "status",
    });
    const invalid = await tools.get("session_search")!.execute("session-invalid", {
      query: "grinder",
      from: "not-a-timestamp",
    });

    expect(memory.details).toMatchObject({
      ok: true,
      result: { results: [expect.objectContaining({ source: "memory" })] },
    });
    expect(session.details).toMatchObject({
      ok: true,
      result: { results: [expect.objectContaining({ source: "session" })] },
    });
    expect(defaultRoles.details).toMatchObject({
      ok: true,
      result: { results: [] },
    });
    expect(explicitToolResult.details).toMatchObject({
      ok: true,
      result: { results: [expect.objectContaining({ source: "session", role: "toolResult" })] },
    });
    expect(foreign.details).toMatchObject({
      ok: true,
      result: { results: [] },
    });
    expect(status.details).toMatchObject({
      ok: true,
      result: {
        schemaVersion: 1,
        memoryDocuments: 1,
        sessionDocuments: 2,
      },
    });
    expect(invalid.details).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
    handlers.get("session_shutdown")?.();
  });
});
