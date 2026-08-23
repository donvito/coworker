import { describe, expect, it } from "vitest";
import { formatModelSelectableSkills } from "@shared/pi-skill-prompt";

describe("Pi model-selected skills prompt", () => {
  it("uses Pi's native skill listing and progressive-disclosure guidance", () => {
    const prompt = formatModelSelectableSkills([
      {
        name: "lease-review-red-flags",
        description: "Reviews tenancy agreements for risky clauses.",
      },
    ]);

    expect(prompt).toContain("The following skills provide specialized instructions");
    expect(prompt).toContain("Read the full skill file when the task matches its description");
    expect(prompt).toContain("<available_skills>");
    expect(prompt).toContain("<name>lease-review-red-flags</name>");
    expect(prompt).toContain("<location>skill://lease-review-red-flags/SKILL.md</location>");
    expect(prompt).toContain("The model decides whether a skill matches");
    expect(prompt).toContain("not skills that merely share the same subject matter");
  });

  it("does not add a skill section when none are enabled", () => {
    expect(formatModelSelectableSkills([])).toBe("");
  });
});
