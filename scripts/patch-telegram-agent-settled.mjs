import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = join(root, "node_modules", "@llblab", "pi-telegram");
const lifecyclePath = join(packageRoot, "lib", "lifecycle.ts");

const original = `  pi.on("agent_end", async (event, ctx) => {
    await deps.onAgentEnd(event, ctx);
  });
}`;
const replacement = `  let latestAgentEnd: AgentEndEvent | undefined;
  pi.on("agent_end", (event) => {
    latestAgentEnd = event;
  });
  pi.on("agent_settled", async (_event, ctx) => {
    const event = latestAgentEnd;
    latestAgentEnd = undefined;
    if (event) await deps.onAgentEnd(event, ctx);
  });
}`;

const manifest = await readFile(join(packageRoot, "package.json"), "utf8");
if (!/^\s*"version":\s*"0\.20\.6",?\s*$/m.test(manifest)) {
  throw new Error(
    "Refusing to patch @llblab/pi-telegram; expected version 0.20.6.",
  );
}

const source = await readFile(lifecyclePath, "utf8");
if (!source.includes(replacement)) {
  if (!source.includes(original)) {
    throw new Error(
      `Telegram agent-settled patch no longer applies cleanly to ${lifecyclePath}.`,
    );
  }
  await writeFile(lifecyclePath, source.replace(original, replacement));
}
