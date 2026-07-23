import { describe, expect, it } from "vitest";

import childExtension from "../.pi/extensions/subagents/child.js";

describe("subagent child capability surface", () => {
  it("registers only dedicated read/search/inspection tools", () => {
    const names: string[] = [];
    childExtension({
      registerTool(tool: { name: string }) { names.push(tool.name); },
    } as never);

    expect(names.sort()).toEqual([
      "repo_image",
      "repo_list",
      "repo_read",
      "repo_search",
      "system_info",
      "web_fetch",
      "web_search",
    ]);
    expect(names).not.toContain("bash");
    expect(names).not.toContain("write");
    expect(names).not.toContain("background_subagents");
  });
});
