import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { normalizeContext, type Context } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

// Exercise the adapter's actual wire serializer, not a fake stream function.
const { buildRequestBody } = await import(pathToFileURL(join(
  import.meta.dirname, "../node_modules/@howaboua/pi-codex-conversion/dist/providers/openai-codex/request-body.js",
)).href);
const model = { id: "gpt-6-luna", provider: "openai-codex", api: "openai-codex-responses",
  reasoning: true, input: ["text", "image"] };
const tool = { name: "exec_command", description: "Run a command", parameters: {
  type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"],
} };
const user = { role: "user" as const, content: "Inspect the workspace", timestamp: 1 };

describe("Codex wire request compatibility", () => {
  it("preserves instructions and executable schemas in Pi transcript context", () => {
    const legacy = { systemPrompt: "BUILDER_INSTRUCTIONS", tools: [tool], messages: [user] } as Context;
    const transcript = normalizeContext(legacy);
    const before = structuredClone(transcript);
    const body = buildRequestBody(model, transcript, {});
    expect(body.instructions).toBe("BUILDER_INSTRUCTIONS");
    expect(body.tools).toEqual([expect.objectContaining({
      type: "function", name: tool.name, parameters: tool.parameters,
    })]);
    expect(body.input).toEqual([expect.objectContaining({ role: "user" })]);
    expect(transcript).toEqual(before);
  });

  it("replays prompt sections and tool changes without resurrecting removed capabilities", () => {
    const context = { messages: [
      { role: "system", content: "BASE", sections: { rules: "OLD_RULES", obsolete: "REMOVE_ME" },
        toolsAdded: [tool, { ...tool, name: "removed_tool" }], timestamp: 0 },
      user,
      { role: "system", content: [{ type: "text", text: "ADDITIONAL_INSTRUCTIONS" }],
        sections: { rules: "NEW_RULES", obsolete: null },
        toolsRemoved: [{ name: "removed_tool" }, { name: tool.name }],
        toolsAdded: [{ ...tool, description: "Updated command schema" }, { ...tool, name: "web_run" }],
        timestamp: 2 },
    ] };
    const before = structuredClone(context);
    const body = buildRequestBody(model, context, {});
    expect(body.instructions).toBe("BASE\n\nADDITIONAL_INSTRUCTIONS\n\nNEW_RULES");
    expect(body.tools.map((entry: { name: string }) => entry.name)).toEqual(["exec_command", "web_run"]);
    expect(body.tools[0].description).toBe("Updated command schema");
    expect(body.input).toHaveLength(1);
    expect(context).toEqual(before);
  });

  it("honors removal of every tool", () => {
    const body = buildRequestBody(model, { messages: [
      { role: "system", content: "BASE", toolsAdded: [tool], timestamp: 0 }, user,
      { role: "system", content: "", toolsRemoved: [{ name: tool.name }], timestamp: 2 },
    ] }, {});
    expect(body.tools).toBeUndefined();
    expect(body.instructions).toBe("BASE");
  });
});
