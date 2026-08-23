import { describe, expect, it } from "vitest";
import { configureModelSchema, modelProviderSchema } from "@shared/validation";

describe("model provider validation", () => {
  it.each(["openrouter", "ollama", "lmstudio", "openai-compatible"] as const)(
    "accepts the %s provider",
    (provider) => {
      expect(modelProviderSchema.parse(provider)).toBe(provider);
    },
  );

  it("allows keyless local providers with their default endpoint", () => {
    expect(configureModelSchema.parse({ provider: "ollama" })).toEqual({
      provider: "ollama",
    });
    expect(configureModelSchema.parse({ provider: "lmstudio" })).toEqual({
      provider: "lmstudio",
    });
  });

  it("requires a safe HTTP URL for a custom OpenAI-compatible provider", () => {
    expect(
      configureModelSchema.parse({
        provider: "openai-compatible",
        baseUrl: "https://models.example.test/v1",
      }),
    ).toEqual({
      provider: "openai-compatible",
      baseUrl: "https://models.example.test/v1",
    });
    expect(
      configureModelSchema.safeParse({ provider: "openai-compatible" }).success,
    ).toBe(false);
    expect(
      configureModelSchema.safeParse({
        provider: "openai-compatible",
        baseUrl: "file:///tmp/models",
      }).success,
    ).toBe(false);
    expect(
      configureModelSchema.safeParse({
        provider: "openai-compatible",
        baseUrl: "https://user:password@models.example.test/v1",
      }).success,
    ).toBe(false);
  });
});
