import { describe, expect, it, vi } from "vitest";
import {
  getModelCapabilities,
  getRuntimeModelConfiguration,
  localModelCredentialMarker,
  listAvailableModels,
  modelSupportsImageInput,
  queryProviderModels,
  type ModelCatalogFetch,
} from "@main/integrations/model-catalog";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

describe("provider model catalog", () => {
  it("reports image-input capability from Pi model metadata", () => {
    expect(modelSupportsImageInput("openai", "gpt-4.1-mini")).toBe(true);
    expect(modelSupportsImageInput("demo", "faux-1")).toBe(false);
    expect(modelSupportsImageInput("openai", "missing-model")).toBe(false);
  });

  it("returns the built-in demo model without reading credentials or using the network", async () => {
    const credentials = {
      set: vi.fn(),
      get: vi.fn(),
      has: vi.fn(),
      delete: vi.fn(),
    };
    const fetcher = vi.fn<ModelCatalogFetch>();

    await expect(listAvailableModels("demo", credentials, fetcher)).resolves.toEqual([
      { id: "faux-1", name: "Built-in demo", supportsImages: false },
    ]);
    expect(credentials.get).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("queries OpenAI with the stored key and removes unsupported model types", async () => {
    const fetcher: ModelCatalogFetch = vi.fn(async (input, init) => {
      expect(String(input)).toBe("https://api.openai.com/v1/models");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-openai-key");
      return jsonResponse({
        data: [
          { id: "text-embedding-3-small" },
          { id: "gpt-4.1-mini" },
        ],
      });
    });

    await expect(
      queryProviderModels("openai", "test-openai-key", fetcher),
    ).resolves.toEqual([
      { id: "gpt-4.1-mini", name: "GPT-4.1 mini", supportsImages: true },
    ]);
  });

  it("paginates Anthropic's model list", async () => {
    const urls: URL[] = [];
    const fetcher: ModelCatalogFetch = vi.fn(async (input, init) => {
      const url = new URL(String(input));
      urls.push(url);
      expect(new Headers(init?.headers).get("x-api-key")).toBe("test-anthropic-key");
      expect(new Headers(init?.headers).get("anthropic-version")).toBe("2023-06-01");
      if (!url.searchParams.has("after_id")) {
        return jsonResponse({
          data: [{ id: "claude-haiku-4-5", display_name: "Claude Haiku 4.5" }],
          has_more: true,
          last_id: "claude-haiku-4-5",
        });
      }
      return jsonResponse({
        data: [{ id: "claude-opus-4-6", display_name: "Claude Opus 4.6" }],
        has_more: false,
        last_id: "claude-opus-4-6",
      });
    });

    const models = await queryProviderModels(
      "anthropic",
      "test-anthropic-key",
      fetcher,
    );

    expect(models.map((model) => model.id)).toEqual([
      "claude-haiku-4-5",
      "claude-opus-4-6",
    ]);
    expect(urls[1]?.searchParams.get("after_id")).toBe("claude-haiku-4-5");
  });

  it("normalizes Gemini IDs and keeps only generateContent models", async () => {
    const fetcher: ModelCatalogFetch = vi.fn(async (_input, init) => {
      expect(new Headers(init?.headers).get("x-goog-api-key")).toBe("test-google-key");
      return jsonResponse({
        models: [
          {
            name: "models/gemini-2.5-flash",
            displayName: "Gemini 2.5 Flash",
            supportedGenerationMethods: ["generateContent", "countTokens"],
          },
          {
            name: "models/text-embedding-004",
            displayName: "Text Embedding",
            supportedGenerationMethods: ["embedContent"],
          },
        ],
      });
    });

    await expect(
      queryProviderModels("google", "test-google-key", fetcher),
    ).resolves.toEqual([
      { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", supportsImages: true },
    ]);
  });

  it("queries OpenRouter and keeps models supported by the Pi runtime", async () => {
    const catalogModel = openrouterProvider().getModels()[0]!;
    const fetcher: ModelCatalogFetch = vi.fn(async (input, init) => {
      const url = new URL(String(input));
      expect(`${url.origin}${url.pathname}`).toBe("https://openrouter.ai/api/v1/models");
      expect(url.searchParams.get("limit")).toBe("1000");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-router-key");
      return jsonResponse({
        data: [
          { id: catalogModel.id, name: catalogModel.name },
          { id: "unavailable/not-in-runtime-catalog" },
        ],
      });
    });

    await expect(
      queryProviderModels("openrouter", "test-router-key", fetcher),
    ).resolves.toEqual([
      {
        id: catalogModel.id,
        name: catalogModel.name,
        supportsImages: catalogModel.input.includes("image"),
      },
    ]);
  });

  it("discovers Ollama models and reads native vision capabilities", async () => {
    const fetcher: ModelCatalogFetch = vi.fn(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/tags") {
        return jsonResponse({
          models: [
            { name: "qwen3:8b", model: "qwen3:8b" },
            { name: "llava:latest", model: "llava:latest" },
          ],
        });
      }
      expect(url.pathname).toBe("/api/show");
      const request = JSON.parse(String(init?.body)) as { model: string };
      return jsonResponse({
        capabilities:
          request.model === "llava:latest"
            ? ["completion", "vision", "tools"]
            : ["completion", "tools"],
      });
    });

    await expect(
      queryProviderModels("ollama", localModelCredentialMarker, fetcher, {
        baseUrl: "http://127.0.0.1:11434/v1",
      }),
    ).resolves.toEqual([
      { id: "llava:latest", name: "llava:latest", supportsImages: true },
      { id: "qwen3:8b", name: "qwen3:8b", supportsImages: false },
    ]);
  });

  it("filters LM Studio embeddings and recognizes VLMs", async () => {
    const fetcher: ModelCatalogFetch = vi.fn(async (input) => {
      expect(new URL(String(input)).pathname).toBe("/api/v0/models");
      return jsonResponse({
        data: [
          { id: "qwen2-vl-7b", type: "vlm", capabilities: ["vision", "tool_use"] },
          { id: "llama-3.1-8b", type: "llm", capabilities: ["tool_use"] },
          { id: "nomic-embed", type: "embeddings" },
        ],
      });
    });

    await expect(
      queryProviderModels("lmstudio", localModelCredentialMarker, fetcher, {
        baseUrl: "http://localhost:1234/v1",
      }),
    ).resolves.toEqual([
      { id: "llama-3.1-8b", name: "llama-3.1-8b", supportsImages: false },
      { id: "qwen2-vl-7b", name: "qwen2-vl-7b", supportsImages: true },
    ]);
  });

  it("supports custom OpenAI-compatible model endpoints and stored capabilities", async () => {
    const values = new Map([
      ["model:openai-compatible", "custom-key"],
      ["model:openai-compatible:base-url", "https://models.example.test/api/v1"],
    ]);
    const credentials = {
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
    const fetcher: ModelCatalogFetch = vi.fn(async (input, init) => {
      expect(String(input)).toBe("https://models.example.test/api/v1/models");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer custom-key");
      return jsonResponse({
        data: [
          {
            id: "acme-vision",
            name: "Acme Vision",
            architecture: { input_modalities: ["text", "image"] },
          },
        ],
      });
    });

    await expect(
      listAvailableModels("openai-compatible", credentials, fetcher),
    ).resolves.toEqual([
      { id: "acme-vision", name: "Acme Vision", supportsImages: true },
    ]);
    await expect(
      getModelCapabilities("openai-compatible", "acme-vision", credentials, fetcher),
    ).resolves.toEqual({ supportsImages: true });

    const runtimeFetcher = vi.fn(fetcher);
    await expect(
      queryProviderModels("openai-compatible", "custom-key", runtimeFetcher, {
        baseUrl: "https://models.example.test/api/v1",
      }),
    ).resolves.toHaveLength(1);
  });

  it("builds runtime configuration for built-in providers without model discovery", async () => {
    const values = new Map([["model:openrouter", "router-key"]]);
    const credentials = {
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
    const model = openrouterProvider().getModels()[0]!;

    await expect(
      getRuntimeModelConfiguration("openrouter", model.id, credentials),
    ).resolves.toMatchObject({
      apiKey: "router-key",
      supportsImages: model.input.includes("image"),
      contextWindow: model.contextWindow,
    });
  });
});
