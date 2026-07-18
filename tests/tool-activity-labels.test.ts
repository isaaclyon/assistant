import { beforeAll, describe, expect, it } from "vitest";

type FormatToolActivityLabel = (
  toolName: string,
  args: unknown,
  cwd?: string,
) => string;

let formatTelegramToolActivityLabel: FormatToolActivityLabel;

beforeAll(async () => {
  const specifier = new URL(
    "../node_modules/@llblab/pi-telegram/lib/tool-activity.ts",
    import.meta.url,
  ).href;
  const module = (await import(specifier)) as {
    formatTelegramToolActivityLabel: FormatToolActivityLabel;
  };
  formatTelegramToolActivityLabel = module.formatTelegramToolActivityLabel;
});

describe("friendly Telegram tool activity labels", () => {
  it.each([
    ["read", { path: "/repo/src/host.ts" }, "Read src/host.ts"],
    ["ls", { path: "/repo/src" }, "Listed src"],
    ["grep", { pattern: "private phrase", path: "/repo/src" }, "Searched src"],
    ["find", { pattern: "*.ts", path: "/repo" }, "Searched files"],
    ["web_search", { query: "private query" }, "Searched the web"],
    ["write_stdin", { session_id: 42 }, "Waited for command"],
  ])("maps %s without exposing sensitive arguments", (toolName, args, expected) => {
    expect(formatTelegramToolActivityLabel(toolName, args, "/repo")).toBe(
      expected,
    );
  });

  it("extracts one edited path without exposing patch contents", () => {
    expect(
      formatTelegramToolActivityLabel(
        "apply_patch",
        {
          input:
            "*** Begin Patch\n*** Update File: /repo/src/host.ts\n@@\n-private secret\n+replacement\n*** End Patch",
        },
        "/repo",
      ),
    ).toBe("Edited src/host.ts");
  });

  it("summarizes patches that edit multiple files", () => {
    expect(
      formatTelegramToolActivityLabel(
        "apply_patch",
        {
          input:
            "*** Begin Patch\n*** Update File: src/a.ts\n*** Add File: src/b.ts\n*** End Patch",
        },
        "/repo",
      ),
    ).toBe("Edited 2 files");
  });

  it.each([
    ["git status --short", "Checked Git status"],
    ["git diff --stat", "Reviewed changes"],
    ["git log -5", "Inspected Git history"],
    ["rg -n 'needle' src", "Searched files"],
    ["sed -n '1,80p' src/host.ts", "Read files"],
    ["npm test", "Ran tests"],
    ["npm run check", "Ran project checks"],
    ["npm run build", "Built the project"],
  ])("maps command %s", (command, expected) => {
    expect(
      formatTelegramToolActivityLabel("exec_command", { cmd: command }, "/repo"),
    ).toBe(expected);
  });

  it("does not expose an unrecognized command", () => {
    expect(
      formatTelegramToolActivityLabel(
        "exec_command",
        { cmd: "deploy --token extremely-secret" },
        "/repo",
      ),
    ).toBe("Ran command");
  });
});
