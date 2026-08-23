import { describe, expect, it, vi } from "vitest";
import {
  listAvailableModels,
  modelSupportsImageInput,
  queryProviderModels,
  type ModelCatalogFetch,
} from "@main/integrations/model-catalog";

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
});
