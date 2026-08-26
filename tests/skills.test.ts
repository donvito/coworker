import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import JSZip from "jszip";
import { DesktopAppService } from "@main/app/app-service";
import { CoworkerDatabase } from "@main/db/database";
import { MemoryCredentialStore } from "@main/security/credential-store";
import { ToolGateway } from "@main/tools/tool-gateway";
import {
  bundledDocumentAuthoringSkill,
  bundledFolderAccessSkill,
  bundledTeamChannelSkill,
  bundledWebSearchSkill,
  downloadSkillFromUrl,
  installSkillFromUrl,
  parseSkillMarkdown,
  parseSkillPackage,
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
  it("ships a valid, narrowly routed document-authoring skill", () => {
    expect(parseSkillMarkdown(bundledDocumentAuthoringSkill.content)).toMatchObject({
      name: "document-authoring",
      description: expect.stringContaining("Do not use for merely reviewing"),
    });
    expect(bundledDocumentAuthoringSkill.bundled).toBe(true);
  });

  it("ships shared-channel guidance without routing ordinary direct chats", () => {
    expect(parseSkillMarkdown(bundledTeamChannelSkill.content)).toMatchObject({
      name: "team-channel-collaboration",
      description: expect.stringContaining(
        "Do not use for an ordinary direct conversation",
      ),
    });
    expect(bundledTeamChannelSkill.content).toContain(
      "Respond only as yourself",
    );
  });

  it("ships folder-access guidance without routing workspace file work", () => {
    expect(parseSkillMarkdown(bundledFolderAccessSkill.content)).toMatchObject({
      name: "folder-access",
      description: expect.stringContaining(
        "Do not use for files in the coworker workspace",
      ),
    });
    expect(bundledFolderAccessSkill.bundled).toBe(true);
    expect(bundledFolderAccessSkill.content).toContain("strictly read-only");
  });

  it("seeds and enables the bundled authoring skill for existing coworkers", async () => {
    const root = await mkdtemp(join(tmpdir(), "coworker-bundled-skills-"));
    const database = new CoworkerDatabase(join(root, "coworker.db"));
    const legacyCoworker = database.createCoworker(
      {
        name: "Legacy",
        role: "Office coworker",
        systemPrompt: "Work carefully.",
        modelProvider: "demo",
        modelName: "faux-1",
        enabledTools: ["documents.export"],
      },
      join(root, "workspace"),
    );
    database.setMetadata("bundled-skills-enabled-v1", "true");
    const service = new DesktopAppService({
      dataPath: root,
      database,
      credentials: new MemoryCredentialStore(),
    });
    try {
      await service.initialize();
      const skill = service.database.getSkillByName("document-authoring");
      expect(skill).not.toBeNull();
      expect(service.database.getCoworker(legacyCoworker.id).enabledSkillIds).toContain(skill!.id);
    } finally {
      await service.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

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

  it("loads a standard packaged skill and preserves its resources", async () => {
    const archive = new JSZip();
    archive.file("release-notes/skill.md", compliantSkill);
    archive.file(
      "release-notes/resources/template.md",
      "# Release template\n\n## Highlights\n",
    );
    const bytes = await archive.generateAsync({ type: "uint8array" });

    const parsed = await parseSkillPackage(bytes);

    expect(parsed.skill.name).toBe("release-notes");
    expect(parsed.resources).toEqual([
      expect.objectContaining({
        path: "resources/template.md",
        mimeType: "text/markdown",
      }),
    ]);
    expect(new TextDecoder().decode(parsed.resources[0]!.content)).toContain("Release template");
  });

  it("ignores harmless macOS metadata beside the single skill folder", async () => {
    const archive = new JSZip();
    archive.file("release-notes/skill.md", compliantSkill);
    archive.file("release-notes/.DS_Store", "metadata");
    archive.file("__MACOSX/release-notes/._skill.md", "metadata");
    archive.file("__MACOSX/._release-notes", "metadata");

    const parsed = await parseSkillPackage(
      await archive.generateAsync({ type: "uint8array" }),
    );

    expect(parsed.skill.name).toBe("release-notes");
    expect(parsed.resources).toEqual([]);
  });

  it("rejects packages whose single root folder does not match the skill name", async () => {
    const wrongRoot = new JSZip();
    wrongRoot.file("another-name/skill.md", compliantSkill);
    await expect(
      parseSkillPackage(await wrongRoot.generateAsync({ type: "uint8array" })),
    ).rejects.toThrow(/folder.*match/i);

    const multipleRoots = new JSZip();
    multipleRoots.file("release-notes/skill.md", compliantSkill);
    multipleRoots.file("extra/readme.md", "extra");
    await expect(
      parseSkillPackage(await multipleRoots.generateAsync({ type: "uint8array" })),
    ).rejects.toThrow(/exactly one skill folder/i);
  });

  it("exposes full instructions only through an enabled coworker's skill reader", async () => {
    const database = new CoworkerDatabase(":memory:");
    const skill = database.upsertSkill(parseSkillMarkdown(compliantSkill));
    database.replaceSkillResources(skill.id, [
      {
        path: "resources/template.md",
        mimeType: "text/markdown",
        content: new TextEncoder().encode("# Packaged template"),
      },
    ]);
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
          resources: [
            expect.objectContaining({ path: "resources/template.md", mimeType: "text/markdown" }),
          ],
        });
      }

      const resource = await gateway.request({
        task,
        coworker,
        toolCallId: "read-skill-resource",
        toolName: "skills.read",
        arguments: { name: "release-notes", path: "resources/template.md" },
      });
      expect(resource.kind).toBe("completed");
      if (resource.kind === "completed") {
        expect(resource.result).toMatchObject({
          path: "resources/template.md",
          content: "# Packaged template",
        });
      }
    } finally {
      database.close();
    }
  });
});
