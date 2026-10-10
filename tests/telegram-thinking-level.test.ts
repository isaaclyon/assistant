import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveTelegramExtensionPath } from "../src/package-paths.js";

describe("pinned Telegram thinking-level compatibility", () => {
  it("preserves Pi's max thinking level through model selection and menu rendering", async () => {
    const root = dirname(resolveTelegramExtensionPath());
    const models = await import(pathToFileURL(join(root, "lib/model.ts")).href);
    const menu = await import(pathToFileURL(join(root, "lib/menu-thinking.ts")).href);
    const model = { id: "synthetic-model", provider: "test", reasoning: true };
    expect(models.resolveScopedModelPatterns(["test/synthetic-model:max"], [model])).toEqual([{ model, thinkingLevel: "max" }]);
    const keyboard = menu.buildThinkingMenuReplyMarkup("max").inline_keyboard.flat();
    expect(keyboard).toContainEqual({ text: "🟢 max", callback_data: "thinking:set:max" });
    const selections: string[] = [];
    await menu.handleTelegramThinkingMenuCallbackAction("synthetic-callback", "thinking:set:max", model, {
      setThinkingLevel: (level: string) => selections.push(level), getCurrentThinkingLevel: () => "max",
      updateStatusMessage: async () => {}, answerCallbackQuery: async () => {},
    });
    expect(selections).toEqual(["max"]);
    expect(models.isThinkingLevel("unknown")).toBe(false);
  });
});
