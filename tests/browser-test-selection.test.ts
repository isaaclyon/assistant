import { describe, expect, it } from "vitest";
import { browserDependencies, browserTests, needsBrowserTests, selectBrowserTests } from "../scripts/browser-test-selection.mjs";

describe("browser test selection", () => {
  const root = process.cwd();
  const dependencies = browserDependencies(root);

  it("discovers browser suites and follows their source dependencies", () => {
    expect(browserTests(root)).toContain("tests/protected-browser.test.ts");
    expect(dependencies.has("src/protected-browser.ts")).toBe(true);
    expect(dependencies.has("src/private-login-submission.ts")).toBe(true);
    for (const file of dependencies) expect(needsBrowserTests([file], dependencies)).toBe(true);
  });

  it("skips browser launches for unrelated changes", () => {
    for (const file of ["src/codex-fast.ts", "src/search-index.ts", "tests/codex-gpt61.test.ts", "docs/pi-upgrades.md", "scripts/patch-codex-conversion.mjs"]) {
      expect(needsBrowserTests([file], dependencies)).toBe(false);
    }
  });

  it("runs browser tests for assets, helpers, infrastructure and mixed changes", () => {
    for (const file of [".pi/skills/agent-browser/scripts/stock-chrome.mjs", "src/browser-takeover-server.ts", "package-lock.json", "package.json", "scripts/test-selected.mjs", ".github/workflows/deploy.yml", "vitest.config.ts"]) {
      expect(needsBrowserTests(["docs/readme.md", file], dependencies)).toBe(true);
    }
  });

  it("falls back to full testing for missing comparison history", () => {
    expect(selectBrowserTests(root, "missing-test-selection-ref").browser).toBe(true);
    expect(selectBrowserTests(root, "0000000000").browser).toBe(true);
  });
});
