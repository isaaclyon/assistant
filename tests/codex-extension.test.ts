import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { resolveCodexExtensionPath } from "../src/package-paths.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function readPackageVersion(path: string): string {
  try {
    const manifest = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (
      typeof manifest === "object" &&
      manifest !== null &&
      "version" in manifest &&
      typeof manifest.version === "string"
    ) {
      return manifest.version;
    }
  } catch (error) {
    throw new Error(`Could not read package version from ${path}`, { cause: error });
  }
  throw new Error(`Package manifest has no version: ${path}`);
}

describe("Codex conversion extension", () => {
  it("uses one aligned Pi SDK version across the host and extension", () => {
    const packages = [
      "pi-agent-core",
      "pi-ai",
      "pi-coding-agent",
      "pi-tui",
    ];
    const versions = packages.map((name) => {
      const manifestPath = join(
        root,
        "node_modules",
        "@earendil-works",
        name,
        "package.json",
      );
      return readPackageVersion(manifestPath);
    });
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const pins = packages.map((name) => manifest.dependencies[`@earendil-works/${name}`]);
    for (const pin of pins) expect(pin).toMatch(/^\d+\.\d+\.\d+$/);
    expect(new Set(pins).size).toBe(1);
    expect(versions).toEqual(pins);

    // Pi's published shrinkwrap can install nested SDK copies. They must stay
    // aligned as well; checking only the four top-level dependencies misses them.
    const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
    for (const path of Object.keys(lock.packages)) {
      const name = packages.find((name) => path.endsWith(`node_modules/@earendil-works/${name}`));
      if (!name) continue;
      const expected = manifest.dependencies[`@earendil-works/${name}`];
      expect(lock.packages[path].version).toBe(expected);
      expect(readPackageVersion(join(root, path, "package.json"))).toBe(expected);
    }
  });

  it("resolves the pinned repo dependency entrypoint", () => {
    expect(resolveCodexExtensionPath()).toBe(
      join(
        root,
        "node_modules",
        "@howaboua",
        "pi-codex-conversion",
        "dist",
        "index.js",
      ),
    );
  });

  it("uses the Telegram-specific config path patched at install time", async () => {
    const modulePath = join(
      root,
      "node_modules",
      "@howaboua",
      "pi-codex-conversion",
      "dist",
      "adapter",
      "activation",
      "config-store.js",
    );
    const configModule = (await import(pathToFileURL(modulePath).href)) as {
      getCodexConversionConfigPath(agentDir?: string): string;
    };
    const previous = process.env.PI_CODEX_CONVERSION_CONFIG_PATH;
    process.env.PI_CODEX_CONVERSION_CONFIG_PATH = "/telegram/codex.json";
    try {
      expect(configModule.getCodexConversionConfigPath("/shared-agent")).toBe(
        "/telegram/codex.json",
      );
    } finally {
      if (previous === undefined) {
        Reflect.deleteProperty(process.env, "PI_CODEX_CONVERSION_CONFIG_PATH");
      } else {
        process.env.PI_CODEX_CONVERSION_CONFIG_PATH = previous;
      }
    }
  });
});
