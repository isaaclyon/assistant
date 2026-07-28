import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const resourceRoot = join(import.meta.dirname, "..");
const extensionUrl = pathToFileURL(
  join(resourceRoot, ".pi", "extensions", "google-workspace.ts"),
).href;
const roots: string[] = [];

interface ToolDefinition {
  name: string;
  parameters: unknown;
  execute(
    id: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ content: Array<{ type: string; text: string }>; details: unknown }>;
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("google workspace extension", () => {
  it("registers one typed account-status operation and normalizes gog output", async () => {
    const tools = new Map<string, ToolDefinition>();
    const run = vi.fn().mockResolvedValue({
      accounts: [
        {
          email: "owner@example.com",
          subject: "private-subject",
          client: "default",
          services: ["contacts", "calendar"],
          scopes: ["private-scope"],
        },
      ],
    });
    const module = await import(`${extensionUrl}?typed=${Date.now()}`) as {
      registerGoogleWorkspaceTool(
        pi: { registerTool(tool: ToolDefinition): void },
        options: {
          resolveRuntime(): Promise<{ account?: string }>;
          run(args: string[], signal?: AbortSignal): Promise<unknown>;
        },
      ): void;
    };

    module.registerGoogleWorkspaceTool(
      { registerTool: (tool) => tools.set(tool.name, tool) },
      {
        resolveRuntime: async () => ({ account: "owner@example.com" }),
        run,
      },
    );

    expect([...tools]).toHaveLength(1);
    const tool = tools.get("google_workspace")!;
    const result = await tool.execute("call-1", { operation: "account_status" });

    expect(run).toHaveBeenCalledWith(
      [
        "--no-input",
        "--readonly",
        "--gmail-no-send",
        "--wrap-untrusted",
        "--json",
        "--account",
        "owner@example.com",
        "auth",
        "list",
      ],
      undefined,
    );
    expect(result.details).toEqual({
      ok: true,
      result: {
        operation: "account_status",
        account: "owner@example.com",
        authenticated: true,
        services: ["calendar", "contacts"],
      },
      error: null,
    });
    expect(JSON.stringify(result)).not.toContain("private-subject");
    expect(JSON.stringify(result)).not.toContain("private-scope");
    expect(JSON.stringify(tool.parameters)).not.toContain("command");
  });

  it("requires an explicit or configured account and returns redacted failures", async () => {
    const tools = new Map<string, ToolDefinition>();
    const run = vi.fn().mockRejectedValue(new Error("secret stderr and token"));
    const module = await import(`${extensionUrl}?errors=${Date.now()}`) as {
      registerGoogleWorkspaceTool(
        pi: { registerTool(tool: ToolDefinition): void },
        options: {
          resolveRuntime(): Promise<{ account?: string }>;
          run(args: string[], signal?: AbortSignal): Promise<unknown>;
        },
      ): void;
    };
    module.registerGoogleWorkspaceTool(
      { registerTool: (tool) => tools.set(tool.name, tool) },
      { resolveRuntime: async () => ({}), run },
    );

    const missing = await tools.get("google_workspace")!.execute("call-1", {
      operation: "account_status",
    });
    expect(missing.details).toMatchObject({
      ok: false,
      error: { code: "GOOGLE_ACCOUNT_REQUIRED" },
    });
    expect(run).not.toHaveBeenCalled();

    const failed = await tools.get("google_workspace")!.execute("call-2", {
      operation: "account_status",
      account: "owner@example.com",
    });
    expect(failed.details).toMatchObject({
      ok: false,
      error: {
        code: "GOOGLE_WORKSPACE_UNAVAILABLE",
        message: "Google Workspace is temporarily unavailable",
      },
    });
    expect(JSON.stringify(failed)).not.toContain("secret stderr");
    expect(JSON.stringify(failed)).not.toContain("token");
  });

  it("runs JSON commands with a minimal environment and bounded output", async () => {
    const root = await mkdtemp(join(tmpdir(), "gog-runner-"));
    roots.push(root);
    const passwordPath = join(root, "keyring-password");
    const executable = join(root, "fake-gog.mjs");
    await writeFile(passwordPath, "keyring-secret\n", { mode: 0o600 });
    await writeFile(
      executable,
      [
        "#!/usr/bin/env node",
        "const inherited = process.env.PI_CREDENTIAL_ENGINEERING_SHOULD_NOT_LEAK;",
        "process.stdout.write(JSON.stringify({ password: process.env.GOG_KEYRING_PASSWORD, home: process.env.GOG_HOME, inherited }));",
      ].join("\n"),
      { mode: 0o700 },
    );
    await chmod(executable, 0o700);
    process.env.PI_CREDENTIAL_ENGINEERING_SHOULD_NOT_LEAK = "ambient-secret";
    const module = await import(`${extensionUrl}?runner=${Date.now()}`) as {
      runGogJson(options: {
        binary: string;
        passwordFile: string;
        gogHome: string;
        args: string[];
        timeoutMs?: number;
        maxOutputBytes?: number;
      }): Promise<unknown>;
    };

    await expect(
      module.runGogJson({
        binary: executable,
        passwordFile: passwordPath,
        gogHome: root,
        args: ["test"],
      }),
    ).resolves.toEqual({ password: "keyring-secret", home: root });

    await writeFile(executable, "#!/usr/bin/env node\nprocess.stdout.write('not json')\n", {
      mode: 0o700,
    });
    await expect(
      module.runGogJson({ binary: executable, passwordFile: passwordPath, gogHome: root, args: [] }),
    ).rejects.toThrow("Google Workspace command failed");

    await writeFile(executable, "#!/usr/bin/env node\nprocess.stdout.write('x'.repeat(5000))\n", {
      mode: 0o700,
    });
    await expect(
      module.runGogJson({
        binary: executable,
        passwordFile: passwordPath,
        gogHome: root,
        args: [],
        maxOutputBytes: 100,
      }),
    ).rejects.toThrow("Google Workspace command failed");

    await writeFile(executable, "#!/usr/bin/env node\nsetTimeout(() => {}, 10_000)\n", {
      mode: 0o700,
    });
    await expect(
      module.runGogJson({
        binary: executable,
        passwordFile: passwordPath,
        gogHome: root,
        args: [],
        timeoutMs: 25,
      }),
    ).rejects.toThrow("Google Workspace command failed");
    delete process.env.PI_CREDENTIAL_ENGINEERING_SHOULD_NOT_LEAK;
  });
});
