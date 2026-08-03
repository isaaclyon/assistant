import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");

describe("find-places skill", () => {
  it("routes public lookup through the typed gateway and private rankings through rank_places", async () => {
    const skill = await readFile(join(root, ".pi/skills/find-places/SKILL.md"), "utf8");

    expect(skill).toContain('operation: "places_search"');
    expect(skill).toContain('field_profile: "identity"');
    expect(skill).toContain("rank_places");
    expect(skill).toMatch(/saved, liked, disliked, ranked, added, or compared places/i);
    expect(skill).toMatch(/Do not invoke `gog`, Google APIs, or shell/i);
  });

  it("documents ambiguity, no-result, untrusted-content, and local-limit behavior", async () => {
    const skill = await readFile(join(root, ".pi/skills/find-places/SKILL.md"), "utf8");

    expect(skill).toMatch(/Ask for location only when[^]*materially ambiguous/i);
    expect(skill).toMatch(/no place matched/i);
    expect(skill).toMatch(/untrusted/i);
    expect(skill).toContain('reason: "monthly_limit"');
    expect(skill).toMatch(/Do not reveal counters, configuration, reset timing, or an override/i);
  });

  it("does not claim unsupported review or rich-detail access", async () => {
    const skill = await readFile(join(root, ".pi/skills/find-places/SKILL.md"), "utf8");

    expect(skill).toMatch(/does not expose ratings, hours, phone numbers/i);
    expect(skill).toMatch(/Never invent or imply access/i);
  });
});
