import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve, relative } from "node:path";

export function browserTests(root) {
  return readdirSync(resolve(root, "tests"))
    .filter((name) => name.endsWith("-browser.test.ts"))
    .map((name) => `tests/${name}`);
}

// Follow local module imports, including .js imports backed by TypeScript.
// Browser scripts and assets loaded by filename are covered separately below.
export function browserDependencies(root, tests = browserTests(root)) {
  const seen = new Set();
  function visit(file) {
    if (seen.has(file)) return;
    seen.add(file);
    const source = readFileSync(resolve(root, file), "utf8");
    for (const match of source.matchAll(/(?:from\s*|import\s*\(\s*|import\s*)["'](\.[^"']+)["']/g)) {
      const target = resolve(root, dirname(file), match[1]);
      const found = [target.replace(/\.js$/, ".ts"), target, `${target}.ts`, `${target}/index.ts`]
        .find((path) => existsSync(path));
      if (!found) throw new Error(`Cannot resolve browser dependency ${match[1]} in ${file}`);
      visit(relative(root, found));
    }
  }
  tests.forEach(visit);
  const scripts = ".pi/skills/agent-browser/scripts";
  if (existsSync(resolve(root, scripts))) {
    for (const file of readdirSync(resolve(root, scripts))) {
      if (file.endsWith(".mjs")) visit(`${scripts}/${file}`);
    }
  }
  return seen;
}

export function needsBrowserTests(files, dependencies) {
  return files.some((file) => {
    if (dependencies.has(file)) return true;
    if (/^(?:src|tests)\/.*(?:browser|private-login|private-input|opentable)/.test(file)) return true;
    if (file.startsWith(".pi/skills/agent-browser/") || file.startsWith(".pi/extensions/private-browser")) return true;
    if (/^(?:docs\/|.*\.md$)/.test(file)) return false;
    if (file === "scripts/patch-codex-conversion.mjs") return false;
    // Ordinary source and test changes outside the dependency graph are unrelated.
    if (/^(?:src\/|tests\/|\.pi\/)/.test(file)) return false;
    // Dependencies, workflows, scripts and build/test configuration run the full suite.
    return true;
  });
}

export function selectBrowserTests(root, base) {
  try {
    if (!base || /^0+$/.test(base)) throw new Error("No comparison revision");
    const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
    const files = [...git("diff", "--name-only", "-z", base, "--").split("\0"),
      ...git("ls-files", "--others", "--exclude-standard", "-z").split("\0")].filter(Boolean);
    return { browser: needsBrowserTests(files, browserDependencies(root)), reason: `Compared with ${base}` };
  } catch (error) {
    return { browser: true, reason: `Full suite fallback: ${error.message}` };
  }
}
