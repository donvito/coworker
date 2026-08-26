import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopAppService } from "@main/app/app-service";
import { CoworkerDatabase } from "@main/db/database";
import {
  credentialKeySchema,
  remoteModelProviderSchema,
} from "@shared/validation";

const temporaryPaths: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "coworker-model-endpoints-"));
  temporaryPaths.push(path);
  return path;
}

function memoryCredentials() {
  const values = new Map<string, string>();
  return {
    values,
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

function stubModelListing(modelIds: string[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify({ data: modelIds.map((id) => ({ id })) }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
}

describe("named OpenAI-compatible endpoints", () => {
  it("validates custom endpoint provider ids and credential keys", () => {
    expect(remoteModelProviderSchema.parse("openai-compatible:abc123")).toBe(
      "openai-compatible:abc123",
    );
    expect(remoteModelProviderSchema.parse("openrouter")).toBe("openrouter");
    expect(remoteModelProviderSchema.safeParse("openai-compatible:").success).toBe(false);
    expect(remoteModelProviderSchema.safeParse("evil:endpoint").success).toBe(false);
    expect(credentialKeySchema.parse("model:openai-compatible:abc123")).toBe(
      "model:openai-compatible:abc123",
    );
    expect(credentialKeySchema.parse("model:openai-compatible:abc123:base-url")).toBe(
      "model:openai-compatible:abc123:base-url",
    );
    expect(credentialKeySchema.safeParse("model:openai-compatible:UPPER").success).toBe(
      false,
    );
  });

  it("adds multiple named endpoints and can rename one in place", async () => {
    const root = await temporaryDirectory();
    const database = new CoworkerDatabase(join(root, "coworker.db"));
    const credentials = memoryCredentials();
    const service = new DesktopAppService({ dataPath: root, database, credentials });
    stubModelListing(["lfm-2.5", "qwen-3"]);
    try {
      const first = await service.addModelEndpoint({
        name: "LM Studio on this Mac",
        baseUrl: "http://127.0.0.1:1234/v1",
        defaultModelName: "lfm-2.5",
      });
      expect(first.provider).toMatch(/^openai-compatible:[a-z0-9]+$/);
      expect(first.configured).toBe(true);
      expect(first.defaultApplied).toBe(true);
      expect(first.models.map((model) => model.id)).toEqual(["lfm-2.5", "qwen-3"]);

      const second = await service.addModelEndpoint({
        name: "Ollama box in the garage",
        baseUrl: "http://192.168.1.20:11434/v1",
        apiKey: "garage-key",
      });
      expect(second.provider).not.toBe(first.provider);

      const endpoints = database.listModelEndpoints();
      expect(endpoints.map((endpoint) => endpoint.name)).toEqual([
        "LM Studio on this Mac",
        "Ollama box in the garage",
      ]);
      expect(credentials.values.get(`model:${second.provider}`)).toBe("garage-key");
      expect(credentials.values.get(`model:${second.provider}:base-url`)).toBe(
        "http://192.168.1.20:11434/v1",
      );

      const settings = database.getSettings();
      expect(settings.defaultModelProvider).toBe(first.provider);
      expect(settings.defaultModelName).toBe("lfm-2.5");

      await service.configureModel({
        provider: first.provider,
        endpointName: "Renamed local server",
      });
      expect(database.getModelEndpoint(first.provider)?.name).toBe("Renamed local server");
      expect(database.listModelEndpoints()).toHaveLength(2);
    } finally {
      database.close();
    }
  });

  it("blocks removing an endpoint a coworker still uses, then cleans up fully", async () => {
    const root = await temporaryDirectory();
    const database = new CoworkerDatabase(join(root, "coworker.db"));
    const credentials = memoryCredentials();
    const service = new DesktopAppService({ dataPath: root, database, credentials });
    stubModelListing(["lfm-2.5"]);
    try {
      const added = await service.addModelEndpoint({
        name: "Desk server",
        baseUrl: "http://127.0.0.1:1234/v1",
        defaultModelName: "lfm-2.5",
      });
      const ava = database.createCoworker(
        {
          name: "Ava",
          role: "Analyst",
          systemPrompt: "Help.",
          modelProvider: added.provider,
          modelName: "lfm-2.5",
          enabledTools: [],
        },
        join(root, "workspaces", "ava"),
      );

      await expect(service.removeModelEndpoint(added.provider)).rejects.toThrow(
        /still used by Ava/,
      );

      database.updateCoworker(ava.id, { modelProvider: "demo", modelName: "faux-1" });
      await service.removeModelEndpoint(added.provider);
      expect(database.listModelEndpoints()).toEqual([]);
      expect(credentials.values.has(`model:${added.provider}`)).toBe(false);
      expect(credentials.values.has(`model:${added.provider}:base-url`)).toBe(false);
      const settings = database.getSettings();
      expect(settings.defaultModelProvider).toBeNull();
      expect(settings.defaultModelName).toBeNull();
    } finally {
      database.close();
    }
  });

  it("surfaces a pre-existing openai-compatible credential as a legacy endpoint", async () => {
    const root = await temporaryDirectory();
    const database = new CoworkerDatabase(join(root, "coworker.db"));
    const credentials = memoryCredentials();
    credentials.values.set("model:openai-compatible", "legacy-key");
    credentials.values.set(
      "model:openai-compatible:base-url",
      "http://127.0.0.1:8080/v1",
    );
    const service = new DesktopAppService({ dataPath: root, database, credentials });
    try {
      await service.initialize();
      const endpoints = database.listModelEndpoints();
      expect(endpoints).toHaveLength(1);
      expect(endpoints[0]).toMatchObject({
        id: "openai-compatible",
        name: "OpenAI-compatible",
        baseUrl: "http://127.0.0.1:8080/v1",
      });
      expect(service.snapshot().modelEndpoints).toHaveLength(1);
    } finally {
      await service.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });
});
