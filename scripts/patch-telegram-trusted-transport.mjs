import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", "@llblab", "pi-telegram");
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
if (manifest.version !== "0.20.6") throw new Error("Unexpected Telegram version for trusted transport patch");
const path = join(root, "lib", "telegram-api.ts");
const original = "  if (!family) return fetch(input, init);";
const replacement = `  const trustedKey = Symbol.for("pi.bridge.trustedTelegramFetch");
  const trusted = (globalThis as typeof globalThis & { [trustedKey]?: typeof fetch })[trustedKey];
  if (trusted) return trusted(input, init);
  if (process.env.PI_TELEGRAM_TRUSTED_SOCKET) throw new Error("Trusted Telegram transport is not installed");
${original}`;
const source = await readFile(path, "utf8");
const unpatched = source.includes(replacement) ? source.replace(replacement, original) : source;
if (createHash("sha256").update(unpatched).digest("hex") !== "cca674880c4ef800b9429fdac6ed449bc0c087942d920b4d59cbee518d384897" ||
    unpatched.split(original).length !== 2) throw new Error("Telegram trusted transport patch source changed");
await writeFile(path, unpatched.replace(original, replacement));
