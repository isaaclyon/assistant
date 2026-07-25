import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { bindBridgeRuntimeMarker } from "../src/telegram-capabilities.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sandboxes: string[] = [];
const previousMemoryDirectory = process.env.PI_TELEGRAM_MEMORY_DIR;
const previousPrincipal = process.env.PI_TELEGRAM_PRINCIPAL;
const previousMemoryView = process.env.PI_TELEGRAM_MEMORY_VIEW;

type BeforeAgentStart = (event: {
  systemPrompt: string;
}) => Promise<{ systemPrompt: string } | undefined>;

afterEach(async () => {
  if (previousMemoryDirectory === undefined) {
    delete process.env.PI_TELEGRAM_MEMORY_DIR;
  } else {
    process.env.PI_TELEGRAM_MEMORY_DIR = previousMemoryDirectory;
  }
  if (previousPrincipal === undefined) delete process.env.PI_TELEGRAM_PRINCIPAL;
  else process.env.PI_TELEGRAM_PRINCIPAL = previousPrincipal;
  if (previousMemoryView === undefined) delete process.env.PI_TELEGRAM_MEMORY_VIEW;
  else process.env.PI_TELEGRAM_MEMORY_VIEW = previousMemoryView;
  await Promise.all(
    sandboxes.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function loadHandler(): Promise<BeforeAgentStart> {
  const extensionPath = join(root, ".pi", "extensions", "core-memory.ts");
  const module = (await import(pathToFileURL(extensionPath).href)) as {
    default(pi: {
      on(event: "before_agent_start", handler: BeforeAgentStart): void;
    }): void;
  };
  let handler: BeforeAgentStart | undefined;
  module.default({
    on(event, registered) {
      if (event === "before_agent_start") handler = registered;
    },
  });
  if (!handler) throw new Error("Core memory extension did not register its hook");
  return handler;
}

async function writeMemory(
  vault: string,
  id: string,
  title: string,
  body: string,
): Promise<void> {
  const path = join(vault, "preferences", `${id}.md`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `---\nschema: 1\nid: "${id}"\ntype: "preference"\ntitle: "${title}"\ntags: []\ncreated: "2026-07-19T03:30:00.000Z"\nupdated: "2026-07-19T03:30:00.000Z"\n---\n${body}\n`,
  );
}

async function fixture(): Promise<{ vault: string; handler: BeforeAgentStart }> {
  const sandbox = await mkdtemp(join(tmpdir(), "core-memory-extension-"));
  sandboxes.push(sandbox);
  const vault = join(sandbox, "memory");
  process.env.PI_TELEGRAM_MEMORY_DIR = vault;
  process.env.PI_TELEGRAM_PRINCIPAL = "isaac";
  process.env.PI_TELEGRAM_MEMORY_VIEW = "owner-and-household";
  return { vault, handler: await loadHandler() };
}

describe("core memory extension", () => {
  it("does nothing outside the explicitly marked bridge runtime", async () => {
    const { vault, handler } = await fixture();
    await writeMemory(
      vault,
      "11111111-1111-4111-8111-111111111111",
      "Response style",
      "Prefers concise replies. #core",
    );

    await expect(handler({ systemPrompt: "Base prompt" })).resolves.toBeUndefined();
  });

  it("compiles fresh core memory into each marked bridge turn", async () => {
    const { vault, handler } = await fixture();
    await writeMemory(
      vault,
      "11111111-1111-4111-8111-111111111111",
      "Response style",
      "Prefers concise replies. #core",
    );
    const unbind = bindBridgeRuntimeMarker();
    try {
      const first = await handler({ systemPrompt: "Base prompt" });
      expect(first?.systemPrompt).toContain(
        "Base prompt\n\n## Core Memory\n\n",
      );
      expect(first?.systemPrompt).toContain(
        "- Response style: Prefers concise replies.",
      );

      await writeMemory(
        vault,
        "22222222-2222-4222-8222-222222222222",
        "Tone",
        "Uses a warm tone. #core",
      );
      const second = await handler({ systemPrompt: "Next prompt" });
      expect(second?.systemPrompt).toContain("- Tone: Uses a warm tone.");
    } finally {
      unbind();
    }
  });

  it("rejects invalid core instead of injecting a partial projection", async () => {
    const { vault, handler } = await fixture();
    await writeMemory(
      vault,
      "11111111-1111-4111-8111-111111111111",
      "Oversized",
      `${"x".repeat(4_000)} #core`,
    );
    const unbind = bindBridgeRuntimeMarker();
    try {
      await expect(handler({ systemPrompt: "Base prompt" })).rejects.toMatchObject({
        code: "CORE_INVALID",
      });
    } finally {
      unbind();
    }
  });
});
