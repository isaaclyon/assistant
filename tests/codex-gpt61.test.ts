import { describe, expect, it } from "vitest";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const adapter = join(import.meta.dirname, "../node_modules/@howaboua/pi-codex-conversion/dist/providers/openai-codex");
const load = (file: string) => import(pathToFileURL(join(adapter, file)).href);

describe("GPT-6.1 Sol", () => {
  it("is selectable with upstream limits and supported reasoning levels", async () => {
    const { openAICodexProviderModels } = await load("model-catalog.js");
    const models = openAICodexProviderModels().filter((model: { id: string }) => model.id === "gpt-6.1-sol");
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      provider: "openai-codex", contextWindow: 272_000, maxTokens: 128_000,
      input: ["text", "image"],
      thinkingLevelMap: { off: null, minimal: null, xhigh: "xhigh", max: "max" },
    });
  });

  it("uses the GPT-6 Responses Lite and reasoning-update path", async () => {
    const { isGpt6ModelId, supportsResponsesLiteModel } = await load("responses-lite-model.js");
    for (const id of ["gpt-6.1-sol", "openai-codex/gpt-6.1-sol", "gpt-6-sol"]) {
      expect(isGpt6ModelId(id)).toBe(true);
      expect(supportsResponsesLiteModel({ id })).toBe(true);
    }
    expect(isGpt6ModelId("gpt-6.1-unknown")).toBe(false);
  });
});
