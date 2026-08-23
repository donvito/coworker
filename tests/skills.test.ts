import { describe, expect, it, vi } from "vitest";
import { CoworkerDatabase } from "@main/db/database";
import { MemoryCredentialStore } from "@main/security/credential-store";
import { ToolGateway } from "@main/tools/tool-gateway";
import {
  bundledWebSearchSkill,
  downloadSkillFromUrl,
  installSkillFromUrl,
  parseSkillMarkdown,
  skillUrlFromPrompt,
} from "@main/integrations/skills";

const compliantSkill = `---
name: release-notes
description: Creates concise release notes from a list of product changes.
---

# Release notes

Summarize user-visible changes and include upgrade guidance.
`;

describe("Agent Skills support", () => {
  it("validates compliant skill frontmatter and recognizes chat installation prompts", () => {
    expect(parseSkillMarkdown(compliantSkill)).toMatchObject({
      name: "release-notes",
      description: "Creates concise release notes from a list of product changes.",
    });
    expect(skillUrlFromPrompt("https://skills.example.test/release/SKILL.md")).toBe(
      "https://skills.example.test/release/SKILL.md",
    );
    expect(
      skillUrlFromPrompt("Install this skill from https://skills.example.test/release/SKILL.md"),
    ).toBe("https://skills.example.test/release/SKILL.md");
    expect(() => parseSkillMarkdown("# Missing frontmatter")).toThrow("YAML frontmatter");
  });

  it("downloads, stores globally, and enables a skill for only the selected coworker", async () => {
    const database = new CoworkerDatabase(":memory:");
    database.upsertSkill(bundledWebSearchSkill);
    const ava = database.createCoworker(
      {
        name: "Ava",
        role: "Accounting",
        systemPrompt: "Work carefully.",
        modelProvider: "demo",
        modelName: "faux-1",
        enabledTools: [],
      },
      "/tmp/ava",
    );
    const sarah = database.createCoworker(
      {
        name: "Sarah",
        role: "Sales",
        systemPrompt: "Work carefully.",
        modelProvider: "demo",
        modelName: "faux-1",
        enabledTools: [],
      },
      "/tmp/sarah",
    );
    const fetcher = vi.fn(async () => new Response(compliantSkill, { status: 200 })) as typeof fetch;
    try {
      const installed = await installSkillFromUrl(
        database,
        "https://skills.example.test/release/SKILL.md",
        ava.id,
        fetcher,
      );

      expect(installed.name).toBe("release-notes");
      expect(database.listSkills().map((skill) => skill.name)).toEqual([
        "web-search",
        "release-notes",
      ]);
      expect(database.getCoworker(ava.id).enabledSkillIds).toContain(installed.id);
      expect(database.getCoworker(sarah.id).enabledSkillIds).not.toContain(installed.id);
    } finally {
      database.close();
    }
  });

  it("rejects unsafe skill URLs before fetching", async () => {
    const fetcher = vi.fn() as unknown as typeof fetch;
    await expect(downloadSkillFromUrl("http://example.test/SKILL.md", fetcher)).rejects.toThrow(
      "HTTPS",
    );
    await expect(downloadSkillFromUrl("https://127.0.0.1/SKILL.md", fetcher)).rejects.toThrow(
      "private network",
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("exposes full instructions only through an enabled coworker's skill reader", async () => {
    const database = new CoworkerDatabase(":memory:");
    const skill = database.upsertSkill(parseSkillMarkdown(compliantSkill));
    const coworker = database.createCoworker(
      {
        name: "Ava",
        role: "Accounting",
        systemPrompt: "Work carefully.",
        modelProvider: "demo",
        modelName: "faux-1",
        enabledTools: [],
        enabledSkillIds: [skill.id],
      },
      "/tmp/ava",
    );
    const task = database.createTask({
      coworkerId: coworker.id,
      title: "Release notes",
      input: "Write release notes.",
    });
    const gateway = new ToolGateway(database, new MemoryCredentialStore(), "/tmp/outbox");
    try {
      const result = await gateway.request({
        task,
        coworker,
        toolCallId: "read-skill",
        toolName: "skills.read",
        arguments: { name: "release-notes" },
      });
      expect(result.kind).toBe("completed");
      if (result.kind === "completed") {
        expect(result.result).toMatchObject({
          name: "release-notes",
          content: expect.stringContaining("# Release notes"),
        });
      }
    } finally {
      database.close();
    }
  });
});
