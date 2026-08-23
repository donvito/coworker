import { describe, expect, it } from "vitest";
import { InMemoryCredentialStore, createModels } from "@earendil-works/pi-ai";
import { createOpenAiCompatibleRuntimeProvider } from "@main/runtime/openai-compatible-provider";

describe("OpenAI-compatible runtime provider", () => {
  it("registers local models with endpoint and image metadata", async () => {
    const credentials = new InMemoryCredentialStore();
    const models = createModels({ credentials });
    models.setProvider(
      createOpenAiCompatibleRuntimeProvider({
        provider: "ollama",
        modelId: "llava:latest",
        baseUrl: "http://127.0.0.1:11434/v1",
        supportsImages: true,
        contextWindow: 32_768,
      }),
    );

    const model = models.getModel("ollama", "llava:latest");
    expect(model).toMatchObject({
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:11434/v1",
      contextWindow: 32_768,
      input: ["text", "image"],
      maxTokens: 16_384,
      provider: "ollama",
    });
    await expect(models.getAuth("ollama")).resolves.toMatchObject({
      auth: { apiKey: "local" },
      source: "Local provider",
    });
  });

  it("uses a stored API key for a custom endpoint", async () => {
    const credentials = new InMemoryCredentialStore();
    await credentials.modify("openai-compatible", async () => ({
      type: "api_key",
      key: "secret-token",
    }));
    const models = createModels({ credentials });
    models.setProvider(
      createOpenAiCompatibleRuntimeProvider({
        provider: "openai-compatible",
        modelId: "custom-chat",
        baseUrl: "https://models.example.test/v1",
        apiKey: "secret-token",
        supportsImages: false,
        contextWindow: 8_192,
      }),
    );

    await expect(models.getAuth("openai-compatible")).resolves.toMatchObject({
      auth: { apiKey: "secret-token" },
    });
  });
});
