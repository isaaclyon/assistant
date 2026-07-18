import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = join(root, "node_modules", "@llblab", "pi-telegram");
const toolActivityPath = join(packageRoot, "lib", "tool-activity.ts");

const obsoleteHintKeys = `const TELEGRAM_TOOL_ACTIVITY_PATH_HINT_KEYS = [
  "path",
  "file_path",
  "filePath",
  "url",
  "name",
] as const;
const TELEGRAM_TOOL_ACTIVITY_TEXT_HINT_KEYS = [
  "command",
  "cmd",
  "pattern",
  "query",
  "prompt",
  "description",
] as const;

`;

const original = `export function formatTelegramToolActivityLabel(
  toolName: string,
  args: unknown,
  cwd?: string,
): string {
  for (const key of TELEGRAM_TOOL_ACTIVITY_PATH_HINT_KEYS) {
    const value = readTelegramToolActivityArgString(args, key);
    if (value !== undefined) {
      const hint = compactTelegramToolActivityHint(
        relativizeTelegramToolActivityPath(value, cwd),
      );
      return \`${"${toolName} ${hint}"}\`;
    }
  }
  for (const key of TELEGRAM_TOOL_ACTIVITY_TEXT_HINT_KEYS) {
    const value = readTelegramToolActivityArgString(args, key);
    if (value !== undefined) {
      return \`${"${toolName}: ${compactTelegramToolActivityHint(value)}"}\`;
    }
  }
  return toolName;
}`;

const replacement = `function formatTelegramToolActivityPath(
  value: string | undefined,
  cwd: string | undefined,
): string | undefined {
  if (value === undefined || value === cwd) return undefined;
  return compactTelegramToolActivityHint(
    relativizeTelegramToolActivityPath(value, cwd),
  );
}

function formatTelegramPatchActivity(args: unknown, cwd: string | undefined): string {
  const patch = readTelegramToolActivityArgString(args, "input");
  if (patch === undefined) return "Edited files";
  const paths = new Set(
    Array.from(
      patch.matchAll(/^\\*\\*\\* (?:Add|Update|Delete) File: (.+)$/gm),
      (match) => match[1]!.trim(),
    ),
  );
  if (paths.size !== 1) return paths.size > 1 ? \`Edited \${paths.size} files\` : "Edited files";
  const path = formatTelegramToolActivityPath(paths.values().next().value, cwd);
  return path === undefined ? "Edited file" : \`Edited \${path}\`;
}

function formatTelegramCommandActivity(command: string): string {
  if (/\\bgit\\s+status\\b/.test(command)) return "Checked Git status";
  if (/\\bgit\\s+diff\\b/.test(command)) return "Reviewed changes";
  if (/\\bgit\\s+(?:log|show|rev-parse)\\b/.test(command)) {
    return "Inspected Git history";
  }
  if (/\\b(?:npm|pnpm|yarn)\\s+run\\s+check\\b/.test(command)) {
    return "Ran project checks";
  }
  if (
    /\\b(?:npm|pnpm|yarn)\\s+(?:run\\s+)?test\\b/.test(command) ||
    /\\b(?:vitest|pytest)\\b/.test(command)
  ) {
    return "Ran tests";
  }
  if (/\\b(?:npm|pnpm|yarn)\\s+(?:run\\s+)?build\\b/.test(command)) {
    return "Built the project";
  }
  if (/(?:^|[;&|\\n]\\s*)\\s*(?:rg|grep|find)\\b/m.test(command)) {
    return "Searched files";
  }
  if (/(?:^|[;&|\\n]\\s*)\\s*(?:cat|sed|head|tail)\\b/m.test(command)) {
    return "Read files";
  }
  if (/(?:^|[;&|\\n]\\s*)\\s*ls\\b/m.test(command)) return "Listed files";
  return "Ran command";
}

export function formatTelegramToolActivityLabel(
  toolName: string,
  args: unknown,
  cwd?: string,
): string {
  const path = formatTelegramToolActivityPath(
    readTelegramToolActivityArgString(args, "path") ??
      readTelegramToolActivityArgString(args, "file_path") ??
      readTelegramToolActivityArgString(args, "filePath"),
    cwd,
  );
  if (toolName === "read" || toolName === "read_symbol" || toolName === "read_enclosing") {
    return path === undefined ? "Read file" : \`Read \${path}\`;
  }
  if (toolName === "ls") return path === undefined ? "Listed files" : \`Listed \${path}\`;
  if (toolName === "grep" || toolName === "find" || toolName === "symbol_search") {
    return path === undefined ? "Searched files" : \`Searched \${path}\`;
  }
  if (toolName === "apply_patch") return formatTelegramPatchActivity(args, cwd);
  if (toolName === "web_search" || toolName === "web_run") return "Searched the web";
  if (toolName === "fetch_content" || toolName === "get_search_content") {
    return "Read web content";
  }
  if (toolName === "write_stdin") return "Waited for command";
  if (toolName === "process") return "Managed background process";
  if (toolName === "Agent" || toolName === "subagent") return "Delegated work";
  if (toolName === "lsp_diagnostics" || toolName === "lens_diagnostics") {
    return "Checked code";
  }
  if (toolName === "exec_command" || toolName === "bash") {
    const command =
      readTelegramToolActivityArgString(args, "cmd") ??
      readTelegramToolActivityArgString(args, "command");
    return command === undefined ? "Ran command" : formatTelegramCommandActivity(command);
  }
  return toolName;
}`;

const manifest = await readFile(join(packageRoot, "package.json"), "utf8");
if (!/^\s*"version":\s*"0\.20\.6",?\s*$/m.test(manifest)) {
  throw new Error(
    "Refusing to patch @llblab/pi-telegram; expected version 0.20.6.",
  );
}

let source = await readFile(toolActivityPath, "utf8");
if (!source.includes(replacement)) {
  if (!source.includes(original) || !source.includes(obsoleteHintKeys)) {
    throw new Error(
      `Friendly Telegram tool-activity patch no longer applies cleanly to ${toolActivityPath}.`,
    );
  }
  source = source
    .replace(obsoleteHintKeys, "")
    .replace(original, replacement);
  await writeFile(toolActivityPath, source);
}
