import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const originalEnvironment = {
  stateDir: process.env.PI_TELEGRAM_BRIDGE_STATE_DIR,
  principal: process.env.PI_TELEGRAM_PRINCIPAL,
  instance: process.env.PI_TELEGRAM_BRIDGE_INSTANCE_ID,
};

interface ToolDefinition {
  name: string;
  parameters: unknown;
  execute(id: string, params: Record<string, unknown>): Promise<{ details: any }>;
}

afterEach(async () => {
  for (const [key, value] of Object.entries({
    PI_TELEGRAM_BRIDGE_STATE_DIR: originalEnvironment.stateDir,
    PI_TELEGRAM_PRINCIPAL: originalEnvironment.principal,
    PI_TELEGRAM_BRIDGE_INSTANCE_ID: originalEnvironment.instance,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await Promise.all(roots.splice(0).map((rootPath) => rm(rootPath, { recursive: true, force: true })));
});

describe("tasks extension", () => {
  it("exposes deterministic CRUD/status views and operation-bound deletion confirmation", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "tasks-extension-"));
    roots.push(stateDir);
    process.env.PI_TELEGRAM_BRIDGE_STATE_DIR = stateDir;
    process.env.PI_TELEGRAM_PRINCIPAL = "isaac";
    process.env.PI_TELEGRAM_BRIDGE_INSTANCE_ID = "isaac";
    const tools = new Map<string, ToolDefinition>();
    const handlers = new Map<string, () => void>();
    const module = await import(`${new URL("../.pi/extensions/tasks.ts", import.meta.url).href}?test=${Date.now()}`) as {
      default(api: unknown): void;
    };
    module.default({
      on(event: string, handler: () => void) { handlers.set(event, handler); },
      registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
    });

    const tool = tools.get("tasks")!;
    expect(tool).toBeDefined();
    handlers.get("session_start")?.();
    const created = await tool.execute("create", {
      operation: "create",
      title: "File taxes",
      due_date: "2026-08-10",
      notes: "Gather receipts",
    });
    const taskId = created.details.result.task.id as string;
    expect(created.details).toMatchObject({
      ok: true,
      result: { task: { title: "File taxes", assignee: "isaac", status: "open" } },
    });

    const list = await tool.execute("list", {
      operation: "list",
      view: "upcoming",
      as_of: "2026-08-03",
    });
    expect(list.details).toMatchObject({ ok: true, result: { tasks: [{ id: taskId }] } });

    const completed = await tool.execute("complete", { operation: "complete", task_id: taskId });
    expect(completed.details).toMatchObject({ ok: true, result: { task: { status: "completed" } } });
    const search = await tool.execute("search", { operation: "search", query: "receipts" });
    expect(search.details).toMatchObject({ ok: true, result: { tasks: [{ id: taskId, status: "completed" }] } });

    const confirmation = await tool.execute("confirm-request", {
      operation: "request_confirmation",
      confirmation_operation: "delete_task",
      task_id: taskId,
    });
    expect(confirmation.details).toMatchObject({
      ok: true,
      result: { confirmationRequired: true, operation: "delete_task", taskId },
    });
    const token = confirmation.details.result.confirmationToken as string;
    const rejected = await tool.execute("delete-wrong", {
      operation: "delete",
      task_id: taskId,
      confirmation_token: "wrong",
    });
    expect(rejected.details).toMatchObject({ ok: false, error: { code: "TASK_CONFIRMATION_INVALID" } });
    const deleted = await tool.execute("delete", {
      operation: "delete",
      task_id: taskId,
      confirmation_token: token,
    });
    expect(deleted.details).toMatchObject({ ok: true, result: { deleted: true, taskId } });
    expect(JSON.stringify(tool.parameters)).not.toMatch(/sql|query_raw|status|override|reset/i);
  });
});
