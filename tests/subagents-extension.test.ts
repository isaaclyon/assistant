import { describe, expect, it } from "vitest";

import backgroundSubagents from "../.pi/extensions/subagents/index.js";

describe("background subagent model scope", () => {
  it("exposes only the three available GPT-6 models", () => {
    let parameters: Record<string, unknown> | undefined;
    backgroundSubagents({
      registerTool(tool: { parameters: Record<string, unknown> }) {
        parameters = tool.parameters;
      },
    } as never);

    const properties = parameters?.properties as Record<string, Record<string, unknown>>;
    const expected = [
      "openai-codex/gpt-6-luna",
      "openai-codex/gpt-6-sol",
      "openai-codex/gpt-6-astra",
    ];
    expect(properties.model?.enum).toEqual(expected);

    const task = properties.tasks?.items as { properties?: Record<string, Record<string, unknown>> } | undefined;
    expect(task?.properties?.model?.enum).toEqual(expected);
  });
});
