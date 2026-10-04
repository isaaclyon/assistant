import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { browserTests, selectBrowserTests } from "./browser-test-selection.mjs";

const root = process.cwd();
const selection = selectBrowserTests(root, process.env.PI_TEST_BASE ?? "origin/main");
console.log(`${selection.reason}; browser tests ${selection.browser ? "included" : "skipped (unrelated changes)"}.`);
if (process.argv.includes("--plan")) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `browser=${selection.browser}\n`);
} else {
  const exclusions = selection.browser ? [] : browserTests(root).flatMap((file) => ["--exclude", file]);
  const result = spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "--exclude", ".worktrees/**", ...exclusions, ...process.argv.slice(2)], { stdio: "inherit" });
  process.exit(result.status ?? 1);
}
