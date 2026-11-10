import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopAppService } from "@main/app/app-service";
import { CoworkerDatabase } from "@main/db/database";
import { bundledSkills, bundledWebSearchSkillId, parseSkillMarkdown } from "@main/integrations/skills";
import { webSearchCredentialKey } from "@main/integrations/web-search";
import { formatModelSelectableSkills } from "@shared/pi-skill-prompt";
import { defaultEnabledBundledSkillNames, toolNamesForSkills } from "@shared/skill-capabilities";
import { getToolCatalogEntry } from "@shared/tool-catalog";

const temporaryPaths: string[] = [];
const skillId = "bundled:search-result-images";
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function memoryCredentials() {
  const values = new Map<string, string>();
  return {
    async set(key: string, value: string) {
      values.set(key, value);
    },
    async get(key: string) {
      return values.get(key) ?? null;
    },
    async has(key: string) {
      return values.has(key);
    },
    async delete(key: string) {
      values.delete(key);
    },
  };
}

const searchResponse = {
  results: [
    { title: "Beach villa", url: "https://stays.example.com/rooms/1", content: "Sleeps four." },
    { title: "City loft", url: "https://stays.example.com/rooms/2", content: "Near the tram." },
  ],
  images: [
    { url: "https://cdn.example.com/villa.jpg", description: "Beach villa pool" },
    { url: "https://cdn.example.com/loft.jpg", description: "City loft living room" },
  ],
};

async function setup() {
  // Throwaway data directory; never a real profile.
  const root = await mkdtemp(join(tmpdir(), "coworker-search-images-"));
  temporaryPaths.push(root);
  const database = new CoworkerDatabase(join(root, "coworker.db"));
  const credentials = memoryCredentials();
  await credentials.set(webSearchCredentialKey("tavily"), "tvly-test");
  const imageFetcher = vi.fn(async () => new Response(new Uint8Array(png))) as unknown as typeof fetch;
  const service = new DesktopAppService({
    dataPath: root,
    database,
    credentials,
    remoteImages: { fetcher: imageFetcher, resolveHost: async () => ["93.184.216.34"] },
  });
  (service as unknown as { seedSkills(): void }).seedSkills();
  const searchFetcher = vi.fn(
    async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify(searchResponse), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", searchFetcher);

  const makeCoworker = (name: string, enabledSkillIds: string[]) =>
    database.createCoworker(
      {
        name,
        role: "Research coworker",
        systemPrompt: "Help with research.",
        modelProvider: "demo",
        modelName: "faux-1",
        enabledTools: [],
        enabledSkillIds,
      },
      join(root, name.toLowerCase()),
    );
  const makeTask = (coworkerId: string, title = "Find a stay") =>
    database.createTask({ coworkerId, title, input: title });
  let callNumber = 0;
  const call = (
    coworker: ReturnType<typeof makeCoworker>,
    task: ReturnType<typeof makeTask>,
    toolName: string,
    args: unknown,
  ) =>
    service.tools.request({
      task,
      coworker,
      toolCallId: `call-${(callNumber += 1)}`,
      toolName,
      arguments: args,
    });
  return { database, service, imageFetcher, searchFetcher, makeCoworker, makeTask, call };
}

describe("search-result-images skill package", () => {
  const found = bundledSkills.find((candidate) => candidate.name === "search-result-images");
  const skill = found && "resources" in found ? found : undefined;

  it("is a bundled, standard-shaped skill with its reference file", () => {
    expect(skill).toBeDefined();
    expect(skill!.id).toBe(skillId);
    expect(parseSkillMarkdown(skill!.content)).toMatchObject({
      name: "search-result-images",
      description: skill!.description,
    });
    expect(skill!.resources.map((resource) => resource.path)).toEqual(["references/examples.md"]);
    expect(skill!.resources[0]!.mimeType).toBe("text/markdown");
  });

  it("routes narrowly: names what it is for and what it is not for", () => {
    const description = skill!.description;
    expect(description.length).toBeLessThanOrEqual(1_024);
    for (const included of ["web search", "places to stay", "venues", "restaurants", "products"]) {
      expect(description, included).toContain(included);
    }
    expect(description).toContain("Do not use for");
    for (const excluded of ["facts", "news", "how-to", "text only", "file", "email", "Telegram", "create, edit, or analyse images"]) {
      expect(description, excluded).toContain(excluded);
    }
  });

  it("keeps the judgment and workflow in the skill instructions", () => {
    const content = skill!.content;
    expect(content).toContain("Most searches should show none");
    expect(content).toContain("includeImages: true");
    expect(content).toContain("chat.attach_images");
    expect(content).toContain("references/examples.md");
    expect(content).toContain("Do not paste image URLs or use Markdown image syntax");
    const examples = Buffer.from(skill!.resources[0]!.content).toString("utf8");
    expect(examples).toContain("## Show images");
    expect(examples).toContain("## Do not show images");
  });

  it("is offered to the model through the native skill listing, not forced", () => {
    const prompt = formatModelSelectableSkills([skill!]);
    expect(prompt).toContain("<name>search-result-images</name>");
    expect(prompt).toContain("<location>skill://search-result-images/SKILL.md</location>");
    expect(prompt).toContain("The model decides whether a skill matches");
  });

  it("grants only search and image attachment, and is on by default", () => {
    expect(toolNamesForSkills([{ name: "search-result-images" }])).toEqual([
      "web.search",
      "chat.attach_images",
    ]);
    expect(toolNamesForSkills([{ name: "web-search" }])).not.toContain("chat.attach_images");
    expect(defaultEnabledBundledSkillNames.has("search-result-images")).toBe(true);
    expect(getToolCatalogEntry("chat.attach_images")).toMatchObject({
      risk: "low",
      defaultPolicy: "automatic",
    });
  });

  it("is added to existing coworkers that can search, and only to them", async () => {
    const { database, service, makeCoworker } = await setup();
    const searcher = makeCoworker("Searcher", [bundledWebSearchSkillId]);
    const offline = makeCoworker("Offline", []);
    database.setMetadata("file-archiving-enabled-v1", "true");
    database.setMetadata("bundled-skills-enabled-v5", "true");

    const enable = () => (service as unknown as { enableBundledSkills(): void }).enableBundledSkills();
    enable();
    expect(database.getCoworker(searcher.id).enabledSkillIds).toContain(skillId);
    expect(database.getCoworker(offline.id).enabledSkillIds).not.toContain(skillId);

    database.setCoworkerSkills(searcher.id, [bundledWebSearchSkillId]);
    enable();
    expect(database.getCoworker(searcher.id).enabledSkillIds).not.toContain(skillId);
  });
});

describe("image attachment boundary", () => {
  it("carries image references from a search and attaches the chosen ones", async () => {
    const { database, service, searchFetcher, makeCoworker, makeTask, call } = await setup();
    const coworker = makeCoworker("Mia", [skillId]);
    const task = makeTask(coworker.id);

    const search = await call(coworker, task, "web.search", {
      query: "beach villa for four",
      includeImages: true,
    });
    expect(search.kind).toBe("completed");
    expect(JSON.parse(String(searchFetcher.mock.calls[0]![1]?.body))).toMatchObject({ include_images: true });
    expect((search as { result: { images: unknown[] } }).result.images).toHaveLength(2);

    const attached = await call(coworker, task, "chat.attach_images", {
      images: [{ url: "https://cdn.example.com/villa.jpg", alt: "Beach villa with pool" }],
    });
    expect(attached).toMatchObject({
      kind: "completed",
      result: {
        attached: 1,
        images: [
          { url: "https://cdn.example.com/villa.jpg", alt: "Beach villa with pool", sourceUrl: null },
        ],
      },
    });
    expect((attached as { result: object }).result).not.toHaveProperty("rejected");

    const audited = database.listToolCalls(task.id).find((entry) => entry.toolName === "chat.attach_images");
    expect(audited).toMatchObject({
      status: "COMPLETED",
      arguments: { images: [{ url: "https://cdn.example.com/villa.jpg", alt: "Beach villa with pool" }] },
    });
    expect(service.snapshot().messageImages).toEqual([
      {
        id: audited!.id,
        taskId: task.id,
        coworkerId: coworker.id,
        createdAt: audited!.completedAt,
        images: [
          { url: "https://cdn.example.com/villa.jpg", alt: "Beach villa with pool", sourceUrl: null },
        ],
      },
    ]);
  });

  it("is unavailable without the skill and never bypasses a denied policy", async () => {
    const { database, makeCoworker, makeTask, call } = await setup();
    const withoutSkill = makeCoworker("Plain", [bundledWebSearchSkillId]);
    const denied = await call(withoutSkill, makeTask(withoutSkill.id), "chat.attach_images", {
      images: [{ url: "https://cdn.example.com/villa.jpg", alt: "Villa" }],
    });
    expect(denied).toMatchObject({ kind: "denied", reason: "chat.attach_images is not enabled for Plain" });

    const restricted = database.updateCoworker(makeCoworker("Strict", [skillId]).id, {
      policies: { "chat.attach_images": "denied" },
    });
    const blocked = await call(restricted, makeTask(restricted.id), "chat.attach_images", {
      images: [{ url: "https://cdn.example.com/villa.jpg", alt: "Villa" }],
    });
    expect(blocked).toMatchObject({ kind: "denied", reason: "chat.attach_images is denied by policy" });
  });

  it("validates the shape of an attachment request", async () => {
    const { database, makeCoworker, makeTask, call } = await setup();
    const coworker = makeCoworker("Mia", [skillId]);
    const task = makeTask(coworker.id);
    const image = { url: "https://cdn.example.com/villa.jpg", alt: "Villa" };
    for (const args of [
      {},
      { images: [] },
      { images: Array.from({ length: 7 }, () => image) },
      { images: [{ url: image.url }] },
      { images: [{ url: image.url, alt: "x".repeat(201) }] },
      { images: ["https://cdn.example.com/villa.jpg"] },
    ]) {
      const response = await call(coworker, task, "chat.attach_images", args);
      expect(response.kind, JSON.stringify(args).slice(0, 60)).toBe("denied");
      expect((response as { reason: string }).reason).toContain("Invalid chat.attach_images arguments");
    }
    expect(database.listToolCalls(task.id).every((entry) => entry.status === "DENIED")).toBe(true);
  });

  it("refuses images no tool returned in this task and records the failure", async () => {
    const { database, service, makeCoworker, makeTask, call } = await setup();
    const coworker = makeCoworker("Mia", [skillId]);
    const task = makeTask(coworker.id);

    await expect(
      call(coworker, task, "chat.attach_images", {
        images: [{ url: "https://cdn.example.com/villa.jpg", alt: "Before any search" }],
      }),
    ).rejects.toThrow("No tool has returned images in this task. Request them first");

    await call(coworker, task, "web.search", { query: "beach villa", includeImages: true });
    for (const url of [
      "https://attacker.example.net/pixel.gif?notes=private",
      "https://cdn.example.com/villa.jpg?leak=1",
      "https://stays.example.com/rooms/1",
      "http://cdn.example.com/villa.jpg",
      "https://127.0.0.1/villa.jpg",
      "data:image/png;base64,AAAA",
    ]) {
      await expect(
        call(coworker, task, "chat.attach_images", { images: [{ url, alt: "Not returned" }] }),
        url,
      ).rejects.toThrow("No image was attached");
    }

    const otherTask = makeTask(coworker.id, "A later request");
    await expect(
      call(coworker, otherTask, "chat.attach_images", {
        images: [{ url: "https://cdn.example.com/villa.jpg", alt: "From an earlier task" }],
      }),
    ).rejects.toThrow("No image was attached");

    const failed = database
      .listToolCalls(task.id)
      .filter((entry) => entry.toolName === "chat.attach_images");
    expect(failed).toHaveLength(7);
    expect(failed.every((entry) => entry.status === "FAILED")).toBe(true);
    expect(service.snapshot().messageImages).toEqual([]);
  });

  it("attaches the valid images and reports the rest", async () => {
    const { makeCoworker, makeTask, call } = await setup();
    const coworker = makeCoworker("Mia", [skillId]);
    const task = makeTask(coworker.id);
    await call(coworker, task, "web.search", { query: "beach villa", includeImages: true });

    const response = await call(coworker, task, "chat.attach_images", {
      images: [
        { url: "https://cdn.example.com/loft.jpg", alt: "City loft" },
        { url: "https://cdn.example.com/invented.jpg", alt: "Made up" },
      ],
    });
    expect(response).toMatchObject({
      kind: "completed",
      result: {
        attached: 1,
        images: [{ url: "https://cdn.example.com/loft.jpg", alt: "City loft" }],
        rejected: [{ url: "https://cdn.example.com/invented.jpg" }],
      },
    });
  });

  it("does not treat a search without includeImages as a source of images", async () => {
    const { makeCoworker, makeTask, call } = await setup();
    const coworker = makeCoworker("Mia", [skillId]);
    const task = makeTask(coworker.id);
    const search = await call(coworker, task, "web.search", { query: "beach villa" });
    expect((search as { result: object }).result).not.toHaveProperty("images");
    await expect(
      call(coworker, task, "chat.attach_images", {
        images: [{ url: "https://cdn.example.com/villa.jpg", alt: "Villa" }],
      }),
    ).rejects.toThrow("No image was attached");
  });
});

describe("serving attached images to the renderer", () => {
  it("downloads only the recorded image for a recorded attachment", async () => {
    const { database, service, imageFetcher, makeCoworker, makeTask, call } = await setup();
    const coworker = makeCoworker("Mia", [skillId]);
    const task = makeTask(coworker.id);
    await call(coworker, task, "web.search", { query: "beach villa", includeImages: true });
    await call(coworker, task, "chat.attach_images", {
      images: [{ url: "https://cdn.example.com/villa.jpg", alt: "Villa" }],
    });
    const [set] = service.snapshot().messageImages;

    await expect(service.readMessageImage(set!.id, 0)).resolves.toEqual({
      data: png.toString("base64"),
      mimeType: "image/png",
    });
    expect(vi.mocked(imageFetcher)).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(imageFetcher).mock.calls[0]![0])).toBe("https://cdn.example.com/villa.jpg");

    await expect(service.readMessageImage(set!.id, 1)).rejects.toThrow("not attached to a reply");
    await expect(service.readMessageImage("missing", 0)).rejects.toThrow();
    const searchCall = database.listToolCalls(task.id).find((entry) => entry.toolName === "web.search");
    await expect(service.readMessageImage(searchCall!.id, 0)).rejects.toThrow("not attached to a reply");
    expect(vi.mocked(imageFetcher)).toHaveBeenCalledTimes(1);
  });
});
