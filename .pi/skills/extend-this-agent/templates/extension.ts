import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Minimal repo-local Pi extension. Keep one file until separation adds clarity.
 * Pi loads TypeScript directly; no extension-specific build step is required.
 */
const exampleTool = defineTool({
  name: "example_tool",
  label: "Example Tool",
  description: "Performs the extension's narrow, concrete operation",
  parameters: Type.Object({
    input: Type.String({ description: "The value to process" }),
  }),
  async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
    return {
      content: [{ type: "text", text: `Processed: ${params.input}` }],
      details: { input: params.input },
    };
  },
});

export default function extend(pi: ExtensionAPI): void {
  pi.registerTool(exampleTool);
}
